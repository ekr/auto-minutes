/**
 * Auto-Minutes Main Entry Point
 * Orchestrates the process of generating meeting minutes from IETF transcripts
 */

import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import dotenv from "dotenv";
import fetch from "node-fetch";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { fetchSessionsFromProceedings, fetchSessionsFromAgenda, downloadTranscript, fetchSessionsWithValidation, fetchCurrentMeetingNumber, fetchInterimSession, fetchAllInterimSessions, fetchInterimSessionsInRange, fetchSessionSlidesAndBluesheet, fetchWorkingGroupDocuments } from "./scraper.js";
import { initializeClaude, generateMinutes, setGenerationTimeout, assertTranscriptPresent, assertTranscriptSubstantial } from "./generator.js";
import { transcribeSession, getTranscriptCachePath, getAudioCachePath, prepareLocalTranscript } from "./transcriber.js";
import { recordUsage, printSummary } from "./accounting.js";
import {
  saveMinutes,
  generateIndex,
  minutesExist,
  generateRootIndex,
  generateWgPages,
  cacheExists,
  saveCachedMinutes,
  getCachedMinutes,
  getCachedSessionIds,
  saveCacheManifest,
  loadCacheManifest,
  getCachedMeetingIds,
  sanitizeSessionName,
  saveCacheMetadata,
  getCachedMetadata,
  deleteCachedMinutes,
  deleteCachedManifest,
  deleteCacheDir,
} from "./publisher.js";

// Load environment variables
dotenv.config();

const SUPPORTED_MEDIA_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".mp3", ".wav", ".m4a", ".aac", ".ogg"]);

// Global verbose flag
let verbose = false;

/**
 * Extract the session slug from a session ID.
 * Session ID format: IETF{N}-{SLUG...}-{YYYYMMDD}-{HHMM}
 * The slug can contain hyphens (e.g., "rtg-area"), so we strip the IETF prefix
 * and the trailing date/time components.
 * @param {string} sessionId - e.g. "IETF124-PRIVACYPASS-20251105-1700"
 * @returns {string} Lowercase slug, e.g. "privacypass" or "rtg-area"
 */
function sessionSlugFromId(sessionId) {
  const parts = sessionId.split('-');
  // parts[0] = "IETF124", last two = "YYYYMMDD", "HHMM"
  return parts.slice(1, -2).join('-').toLowerCase();
}

/**
 * Fetch slides/bluesheet and WG documents for a session in parallel.
 * Supports both regular IETF meetings (numeric ID) and interim meetings
 * (meetingSlug present on the session object, e.g. "interim-2026-dnssd-01").
 * Returns null gracefully when fetches fail.
 * @param {Object} session - Session object with sessionId (and optionally meetingSlug) property
 * @returns {Promise<{slidesAndBluesheet: Object|null, wgDocuments: Array}>}
 */
async function fetchContextForSession(session) {
  let meetingIdentifier;
  let sessionSlug;

  const meetingMatch = session.sessionId.match(/^IETF(\d+)-/);
  if (meetingMatch) {
    meetingIdentifier = parseInt(meetingMatch[1], 10);
    sessionSlug = sessionSlugFromId(session.sessionId);
  } else if (session.meetingSlug) {
    // Interim session: use the stored meeting slug and derive group from session name
    meetingIdentifier = session.meetingSlug;
    sessionSlug = session.sessionName.toLowerCase();
  } else {
    return { slidesAndBluesheet: null, wgDocuments: [] };
  }

  const [slidesResult, docsResult] = await Promise.allSettled([
    fetchSessionSlidesAndBluesheet(meetingIdentifier, sessionSlug),
    fetchWorkingGroupDocuments(sessionSlug),
  ]);

  if (verbose && slidesResult.status === 'rejected') {
    console.log(`    [context] Could not fetch slides/bluesheet: ${slidesResult.reason?.message}`);
  }
  if (verbose && docsResult.status === 'rejected') {
    console.log(`    [context] Could not fetch WG documents: ${docsResult.reason?.message}`);
  }

  return {
    slidesAndBluesheet: slidesResult.status === 'fulfilled' ? slidesResult.value : null,
    wgDocuments: docsResult.status === 'fulfilled' ? docsResult.value : [],
  };
}

/**
 * Run async tasks with a concurrency limit
 * @param {Array<Function>} tasks - Array of functions that return promises
 * @param {number} limit - Maximum number of concurrent tasks
 * @returns {Promise<Array>} Results in the same order as tasks
 */
async function runWithConcurrency(tasks, limit) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = task().then(
      r => { executing.delete(p); return r; },
      e => { executing.delete(p); throw e; },
    );
    executing.add(p);
    results.push(p);
    if (executing.size >= limit) {
      // Use .catch to prevent unhandled rejections from other in-flight
      // promises while we await the first to settle.
      await Promise.race(executing).catch(() => {});
    }
  }
  return Promise.all(results);
}

/**
 * Generate minutes for a session (checks cache first, otherwise downloads and generates)
 * @param {number} meetingNumber - IETF meeting number
 * @param {Object} session - Session object with sessionName and sessionId
 * @param {string} modelName - Full model name to use
 * @returns {Promise<Object>} Object with {minutes: string, wasGenerated: boolean}
 */
async function generateSessionMinutes(meetingNumber, session, sttModel = null, modelName = null, localAudioPath = null, geminiSegmentSeconds = null, localTranscriptPath = null, allowShortTranscript = false) {
  // Check cache first (skip when a local audio/transcript file is provided — re-run must be deterministic)
  if (!localAudioPath && !localTranscriptPath && await cacheExists(meetingNumber, session.sessionId)) {
    console.log(`  Loading from cache: ${session.sessionId}`);
    const minutes = await getCachedMinutes(meetingNumber, session.sessionId);

    // Load cached metadata if present (informational only)
    const metadata = await getCachedMetadata(meetingNumber, session.sessionId);
    if (metadata) {
      if (metadata.slides?.length) {
        console.log(`  Loaded ${metadata.slides.length} cached slide deck(s)`);
      }
      if (metadata.bluesheetText) {
        console.log(`  Loaded cached bluesheet (${metadata.bluesheetText.length} chars)`);
      }
    }

    return { minutes, wasGenerated: false };
  }

  // Fetch slides, bluesheet, and WG documents for LLM context (before transcription
  // so context can be used by Gemini STT to identify speakers by name)
  console.log(`  Fetching context (slides, bluesheet, WG docs): ${session.sessionId}`);
  const context = await fetchContextForSession(session);

  // Report context results immediately so the user sees them without
  // waiting for transcription. The metadata is persisted later, only if
  // transcription succeeds, so we don't leave orphaned cache entries for
  // sessions that had no transcript.
  if (context.slidesAndBluesheet) {
    if (context.slidesAndBluesheet.slides?.length) {
      console.log(`  Fetched ${context.slidesAndBluesheet.slides.length} slide deck(s)`);
    }
    if (context.slidesAndBluesheet.bluesheet) {
      console.log(`  Fetched bluesheet (${context.slidesAndBluesheet.bluesheet.length} chars)`);
    }
  }

  // Download transcript - from local file, audio (via STT), or text
  let transcript;
  try {
    if (localTranscriptPath) {
      console.log(`  Using local transcript: ${localTranscriptPath}`);
      transcript = prepareLocalTranscript(session, localTranscriptPath, verbose);
    } else if (sttModel) {
      console.log(`  Transcribing audio (${sttModel}): ${session.sessionId}`);
      const result = await transcribeSession(session, sttModel, process.env.GEMINI_API_KEY, verbose, context, localAudioPath, geminiSegmentSeconds);
      transcript = result.text;
      recordUsage(result.usage);
    } else {
      console.log(`  Downloading transcript: ${session.sessionId}`);
      transcript = await downloadTranscript(session);
    }
    assertTranscriptSubstantial(transcript, session.sessionName, { allowShort: allowShortTranscript });
  } catch (error) {
    console.log(`  Skipping ${session.sessionId} — ${error.message}`);
    return { minutes: "", wasGenerated: false, reason: error.message }; // Return empty minutes if transcript unavailable/invalid
  }

  if (context.slidesAndBluesheet) {
    await saveCacheMetadata(meetingNumber, session.sessionId, {
      slides: context.slidesAndBluesheet.slides || [],
      bluesheetText: context.slidesAndBluesheet.bluesheet || null,
    });
  }

  // Generate minutes using LLM
  console.log(`  Generating minutes with LLM: ${session.sessionId}`);
  let minutes;
  try {
    const result = await generateMinutes(transcript, session.sessionName, verbose, modelName, context);
    minutes = result.text;
    recordUsage(result.usage);
  } catch (error) {
    console.log(`  Could not generate minutes: ${error.message}`);
    return { minutes: "", wasGenerated: false, reason: error.message };
  }

  // Save to cache
  await saveCachedMinutes(meetingNumber, session.sessionId, minutes);
  console.log(`  Cached: ${session.sessionId}`);

  return { minutes, wasGenerated: true };
}

/**
 * Parse session information from session ID
 * Format: IETFXXX-SESSIONNAME-YYYYMMDD-HHMM
 * @param {string} sessionId - Session ID
 * @returns {Object} Object with sessionName and dateTime
 */
function parseSessionId(sessionId) {
  const parts = sessionId.split("-");

  // Extract date/time (last two parts)
  const dateStr = parts[parts.length - 2]; // YYYYMMDD
  const timeStr = parts[parts.length - 1]; // HHMM

  // Extract session name (everything between IETFXXX and date)
  const sessionName = parts.slice(1, -2).join("-");

  let dateTimeHeader = "";
  if (dateStr && timeStr && dateStr.length === 8 && timeStr.length === 4) {
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);
    const hour = timeStr.substring(0, 2);
    const minute = timeStr.substring(2, 4);

    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const monthName = monthNames[parseInt(month, 10) - 1];
    const formattedDateTime = `${day} ${monthName} ${year} ${hour}:${minute}`;

    dateTimeHeader = `**Session Date/Time:** ${formattedDateTime}\n\n`;
  }

  return { sessionName, dateTimeHeader };
}

/**
 * Parse the --summarize argument into a typed descriptor
 * @param {string|number} value - Meeting number, "current", "number:group", "date:group", "date", "date+", "date-date", or "date-date:group"
 * @returns {Object} Parsed descriptor with type field
 */
function parseSummarizeArg(value) {
  const str = String(value);

  // "current" → resolve via API
  if (str.toLowerCase() === 'current') {
    return { type: 'current' };
  }

  // date-date or date-date:group → explicit date range of interims
  // Must be checked before the general colon format below
  if (/^\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}(:.+)?$/.test(str)) {
    const startDate = str.slice(0, 10);
    const endDate = str.slice(11, 21);
    const group = str.length > 21 ? str.slice(22) : undefined;
    return { type: 'interim-range', startDate, endDate, ...(group && { group }) };
  }

  // colon format: date:group (interim) or number:group (plenary filtered)
  if (str.includes(':')) {
    const [left, group] = str.split(':', 2);
    if (!left || !group) {
      throw new Error(`Invalid format: "${str}". Expected "YYYY-MM-DD:GROUP" or "NUMBER:GROUP"`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(left)) {
      return { type: 'interim', date: left, group };
    }
    const meetingNumber = parseInt(left, 10);
    if (!isNaN(meetingNumber)) {
      return { type: 'ietf-group', meetingNumber, group };
    }
    throw new Error(`Invalid format: "${str}". Left side of ":" must be a date (YYYY-MM-DD) or meeting number`);
  }

  // date+ → range of interims from date through today
  if (str.endsWith('+') && /^\d{4}-\d{2}-\d{2}\+$/.test(str)) {
    const startDate = str.slice(0, -1);
    return { type: 'interim-range', startDate };
  }

  // bare date → all interims on that date
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return { type: 'interim-all', date: str };
  }

  // numeric → IETF meeting number
  const meetingNumber = parseInt(str, 10);
  if (isNaN(meetingNumber)) {
    throw new Error(`Invalid meeting number: "${str}"`);
  }
  return { type: 'ietf', meetingNumber };
}

/**
 * Process sessions for a single meetingId: generate/cache minutes and save manifest.
 * @param {string|number} meetingId - Meeting identifier (number for IETF, date string for interim)
 * @param {Array} sessions - Array of session objects
 * @param {string|null} sttModel - STT model to use, or null for text transcripts
 */
async function processSummarizeSessions(meetingId, sessions, sttModel = null, modelName = null, parallel = 1, localAudioPath = null, geminiSegmentSeconds = null, localTranscriptPath = null, allowShortTranscript = false) {
  if (verbose) {
    console.log("\n=== Session List Structure (JSON) ===");
    console.log(JSON.stringify(sessions, null, 2));
    console.log("=== End Session List ===\n");
  }

  // Group sessions by name (multiple sessions can have the same name)
  const sessionsByName = new Map();
  for (const session of sessions) {
    if (!sessionsByName.has(session.sessionName)) {
      sessionsByName.set(session.sessionName, []);
    }
    sessionsByName.get(session.sessionName).push(session);
  }

  // Build task list from all sessions
  const allTasks = [];
  for (const [sessionName, sessionGroup] of sessionsByName) {
    for (const session of sessionGroup) {
      allTasks.push({ sessionName, session });
    }
  }

  if (parallel > 1) {
    console.log(`\nProcessing ${allTasks.length} session(s) with concurrency=${parallel}`);
  }

  // Process sessions with concurrency limit
  const results = await runWithConcurrency(
    allTasks.map(({ sessionName, session }) => async () => {
      console.log(`  Processing ${sessionName} [${session.sessionId}]...`);
      const result = await generateSessionMinutes(meetingId, session, sttModel, modelName, localAudioPath, geminiSegmentSeconds, localTranscriptPath, allowShortTranscript);
      if (!result.minutes) {
        console.log(`  Skipping ${sessionName} [${session.sessionId}] - no transcript`);
      } else {
        console.log(`  Completed ${sessionName} [${session.sessionId}]`);
      }
      return { sessionName, session, result };
    }),
    parallel,
  );

  // Collect results into session groups (preserving original group order)
  const sessionGroups = [];
  const skippedSessions = [];
  let anyNewMinutes = false;
  for (const [sessionName] of sessionsByName) {
    const groupResults = results.filter(r => r.sessionName === sessionName);
    const processedSessions = [];
    for (const { session, result } of groupResults) {
      if (result.wasGenerated) {
        anyNewMinutes = true;
      }
      if (result.minutes) {
        processedSessions.push({
          sessionId: session.sessionId,
          recordingUrl: session.recordingUrl,
        });
      } else {
        skippedSessions.push({
          sessionName,
          sessionId: session.sessionId,
          reason: result.reason || "no transcript",
        });
      }
    }
    if (processedSessions.length > 0) {
      sessionGroups.push({
        sessionName,
        sessions: processedSessions,
      });
    }
  }

  if (anyNewMinutes) {
    console.log("\nSaving cache manifest...");
    await saveCacheManifest(meetingId, sessionGroups);
    console.log(`Cached ${sessionGroups.length} session groups`);
  } else {
    console.log("\nNo new minutes generated, skipping manifest update");
  }

  return skippedSessions;
}

/**
 * Process --uncache: clear cached data for resolved sessions
 * @param {Object} parsed - Parsed specifier from parseSummarizeArg()
 * @param {string} uncacheType - Cache type to clear: "all", "minutes", "transcripts", "audio"
 */
async function processUncache(parsed, uncacheType) {
  // Resolve meetingId(s) and optional group filter
  let meetingIds = [];
  let groupFilter = null;

  if (parsed.type === 'current') {
    const { number: meetingNumber } = await fetchCurrentMeetingNumber();
    console.log(`Current IETF meeting: ${meetingNumber}`);
    meetingIds = [meetingNumber];
  } else if (parsed.type === 'ietf') {
    meetingIds = [parsed.meetingNumber];
  } else if (parsed.type === 'ietf-group') {
    meetingIds = [parsed.meetingNumber];
    groupFilter = parsed.group.toLowerCase();
  } else if (parsed.type === 'interim') {
    meetingIds = [parsed.date];
    groupFilter = parsed.group.toLowerCase();
  } else if (parsed.type === 'interim-all') {
    meetingIds = [parsed.date];
  } else if (parsed.type === 'interim-range') {
    // Enumerate cached meeting IDs that fall within the date range
    const allIds = await getCachedMeetingIds();
    const startDate = parsed.startDate;
    const endDate = parsed.endDate || new Date().toISOString().slice(0, 10);
    meetingIds = allIds.filter(id =>
      typeof id === 'string' && id >= startDate && id <= endDate
    );
    if (parsed.group) {
      groupFilter = parsed.group.toLowerCase();
    }
  }

  if (meetingIds.length === 0) {
    console.log("No matching meetings found in cache.");
    return;
  }

  let totalCleared = 0;

  for (const meetingId of meetingIds) {
    const isPlenary = typeof meetingId === 'number';
    const label = isPlenary ? `IETF ${meetingId}` : `Interim ${meetingId}`;
    console.log(`\n=== UNCACHE: ${label} (${uncacheType}) ===`);

    // Resolve session IDs for this meeting
    let sessionIds;
    let manifest = null;

    try {
      const sessionGroups = await loadCacheManifest(meetingId);
      manifest = sessionGroups;

      if (groupFilter) {
        // Filter to matching group, then extract session IDs
        sessionIds = sessionGroups
          .filter(g => g.sessionName.toLowerCase() === groupFilter)
          .flatMap(g => g.sessions.map(s => s.sessionId));
      } else {
        sessionIds = sessionGroups.flatMap(g => g.sessions.map(s => s.sessionId));
      }
    } catch {
      // No manifest — fall back to directory listing
      sessionIds = await getCachedSessionIds(meetingId);
      if (groupFilter) {
        sessionIds = sessionIds.filter(id => {
          const slug = sessionSlugFromId(id);
          return slug === groupFilter;
        });
      }
    }

    if (sessionIds.length === 0) {
      console.log("  No matching sessions found.");
      continue;
    }

    let sessionCount = 0;

    for (const sessionId of sessionIds) {
      let deleted = false;

      // Delete minutes
      if (uncacheType === 'all' || uncacheType === 'minutes') {
        if (await deleteCachedMinutes(meetingId, sessionId)) {
          console.log(`  Deleted minutes: ${sessionId}`);
          deleted = true;
        }
      }

      // Delete transcript
      if (uncacheType === 'all' || uncacheType === 'transcripts') {
        const transcriptPath = getTranscriptCachePath(sessionId);
        try {
          await fs.unlink(transcriptPath);
          console.log(`  Deleted transcript: ${sessionId}`);
          deleted = true;
        } catch {
          // File doesn't exist
        }
      }

      // Delete audio
      if (uncacheType === 'all' || uncacheType === 'audio') {
        const audioPath = getAudioCachePath(sessionId);
        try {
          await fs.unlink(audioPath);
          console.log(`  Deleted audio: ${sessionId}`);
          deleted = true;
        } catch {
          // File doesn't exist
        }
      }

      if (deleted) sessionCount++;
    }

    // Delete manifest if clearing all or minutes and all sessions were targeted
    if ((uncacheType === 'all' || uncacheType === 'minutes') && !groupFilter) {
      await deleteCachedManifest(meetingId);
    }

    // Try to clean up empty directory
    if (uncacheType === 'all' && !groupFilter) {
      await deleteCacheDir(meetingId);
    }

    totalCleared += sessionCount;
    console.log(`Cleared ${sessionCount} session(s)`);
  }

  if (meetingIds.length > 1) {
    console.log(`\nTotal: cleared ${totalCleared} session(s) across ${meetingIds.length} meeting(s)`);
  }
}

/**
 * Resolve a GitHub token for the API: prefer an explicit env var, otherwise
 * fall back to the token the `gh` CLI is already logged in with.
 * @returns {Promise<string>}
 */
async function resolveGitHubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    const { execFileSync } = await import("child_process");
    const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
    if (token) return token;
  } catch {
    // gh not installed or not logged in — fall through to the error below.
  }
  throw new Error(
    "No GitHub token found. Set GITHUB_TOKEN (or GH_TOKEN), or run `gh auth login`.",
  );
}

/**
 * Process --uncache-remote: dispatch the remote repo's sync workflow so it
 * deletes the cached artifacts for these sessions and regenerates them
 * server-side. Nothing is read or written locally.
 * @param {string[]} selectors - Selector strings (already validated)
 * @param {string} uncacheType - "minutes" or "all"
 * @param {{repo: string, workflow: string, ref: string}} opts
 */
async function dispatchRemoteUncache(selectors, uncacheType, { repo, workflow, ref }) {
  // The workflow reads one "<selector> <type>" per line of the selectors input.
  const selectorsInput = selectors.map((s) => `${s} ${uncacheType}`).join("\n");

  const token = await resolveGitHubToken();
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "auto-minutes",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref, inputs: { selectors: selectorsInput } }),
  });

  // A successful workflow dispatch returns 204 No Content.
  if (response.status !== 204) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Workflow dispatch failed (HTTP ${response.status}) for ${repo} ${workflow}@${ref}` +
        (detail ? `: ${detail}` : ""),
    );
  }

  console.log(`Dispatched ${workflow} on ${repo}@${ref} to uncache (${uncacheType}) and regenerate:`);
  for (const s of selectors) console.log(`  ${s}`);
  console.log(`Watch: https://github.com/${repo}/actions/workflows/${workflow}`);
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .usage("Usage: $0 [options]")
    .example("$0 --summarize 123", "Generate LLM summaries for IETF 123")
    .example("$0 --summarize current", "Generate LLM summaries for the current/upcoming IETF meeting")
    .example("$0 --summarize 123:6LO", "Generate summaries for a specific WG at an IETF meeting")
    .example("$0 --summarize 2026-03-03:AIPREF", "Generate summaries for an interim meeting")
    .example("$0 --summarize 2026-03-03", "Generate summaries for all interims on a date")
    .example("$0 --summarize 2026-03-03+", "Generate summaries for all interims from date through today")
    .example("$0 --summarize 2026-03-01-2026-03-13", "Generate summaries for interims in a date range")
    .example("$0 --summarize 2026-03-01-2026-03-13:AIPREF", "Generate summaries for a specific WG in a date range")
    .example("$0 --summarize 123 --source agenda", "Fetch sessions from Meetecho agenda")
    .example("$0 --output", "Generate output markdown files from cache")
    .example("$0 --summarize 123 --output", "Generate summaries and output")
    .example("$0 --build", "Build site with 11ty (outputs to _site/)")
    .example("$0 --output --build", "Generate output and build site")
    .example("$0 --pages", "Build and prepare GitHub Pages")
    .example("$0 --preview 123:6LO", "Preview minutes for IETF 123 6LO session")
    .example("$0 --preview 2026-04-14:AIPREF", "Preview minutes for an interim session")
    .example("$0 --preview 123:6LO --audio", "Preview with audio transcription (Google STT)")
    .example("$0 --preview 123:6LO --audio --stt-model gemini", "Preview with Gemini STT")
    .example("$0 --preview 123:6LO --audio --stt-model google:chirp_3+names", "Preview with chirp+Gemini name-fill hybrid (real timestamps + names)")
    .example("$0 --summarize 123 -j 5", "Process 5 sessions in parallel")
    .example("$0 --uncache 123", "Clear all cached data for IETF 123")
    .example("$0 --uncache 123:6LO --uncache-type minutes", "Clear only cached minutes for 6LO")
    .example("$0 --uncache-remote 123:6LO", "Uncache & regenerate 6LO on the remote (server-side; nothing local)")
    .example("$0 --uncache-remote 2026-07-08:CBOR --uncache-type all", "Also re-download & re-transcribe, on the remote")
    .option("summarize", {
      alias: "s",
      type: "string",
      description:
        "Generate LLM summaries: number, \"current\", number:group, date:group, date, date+, date-date, or date-date:group",
    })
    .option("output", {
      alias: "o",
      type: "boolean",
      description: "Generate output markdown files from cache",
    })
    .option("build", {
      alias: "b",
      type: "boolean",
      description: "Build site with 11ty (outputs to _site/)",
    })
    .option("pages", {
      alias: "p",
      type: "boolean",
      description: "Build and prepare GitHub Pages (gh-pages branch)",
    })
    .option("model", {
      alias: "m",
      type: "string",
      default: "gemini-3.5-flash",
      description: "LLM model to use (e.g., gemini-3.5-flash, claude-sonnet-4-6, or shorthand: gemini, claude)",
    })
    .option("verbose", {
      alias: "v",
      type: "boolean",
      description: "Run with verbose output",
    })
    .option("source", {
      type: "string",
      choices: ["proceedings", "agenda"],
      default: "proceedings",
      description: "Source to fetch sessions from (proceedings or agenda)",
    })
    .option("audio", {
      alias: "a",
      type: "boolean",
      description: "Use audio transcription instead of Meetecho text transcript",
    })
    .option("stt-model", {
      type: "string",
      default: "google",
      description: "STT backend when --audio is used: \"google\", \"google:chirp_2\", \"google:chirp_3\" (default), \"gemini\", or a chirp+Gemini name-fill hybrid (\"google+names\", \"google:chirp_3+names\") that keeps chirp's real timestamps and diarization but fills in speaker names via a text-only Gemini call; the hybrid requires chirp_3 diarization, so \"google:chirp_2+names\" is not supported",
    })
    .option("gemini-segment-seconds", {
      type: "number",
      description: "When using --stt-model gemini, split audio into segments of this many seconds and transcribe each independently",
    })
    .option("timeout", {
      type: "number",
      default: 300,
      description: "LLM generation timeout in seconds (default: 300 = 5 minutes)",
    })
    .option("parallel", {
      alias: "j",
      type: "number",
      default: 1,
      description: "Number of sessions to process in parallel",
    })
    .option("preview", {
      type: "string",
      description: "Preview minutes for a specific session (format: meeting:session-name)",
    })
    .option("uncache", {
      type: "string",
      description: "Clear cached data: number, \"current\", number:group, date:group, date, date+, date-date, or date-date:group",
    })
    .option("uncache-type", {
      type: "string",
      choices: ["all", "minutes", "transcripts", "audio"],
      default: "all",
      description: "Type of cache to clear (default: all)",
    })
    .option("uncache-remote", {
      type: "array",
      description: "Uncache and regenerate sessions on the remote repo by dispatching its sync workflow (does nothing locally). Same selector grammar as --uncache; repeat the flag for several. Honors --uncache-type minutes|all (default minutes).",
    })
    .option("repo", {
      type: "string",
      default: "ietf-minutes/ietf-minutes-data",
      description: "owner/repo to dispatch --uncache-remote against",
    })
    .option("workflow", {
      type: "string",
      default: "sync.yaml",
      description: "Workflow file to dispatch for --uncache-remote",
    })
    .option("ref", {
      type: "string",
      default: "main",
      description: "Git ref the dispatched --uncache-remote workflow runs from",
    })
    .option("audio-file", {
      type: "string",
      description: "Use a local audio/video file instead of fetching from Meetecho (requires single-session selector: NUMBER:GROUP or YYYY-MM-DD:GROUP)",
    })
    .option("transcript-file", {
      type: "string",
      description: "Use a local transcript file instead of fetching/transcribing audio (requires single-session selector: NUMBER:GROUP or YYYY-MM-DD:GROUP)",
    })
    .option("allow-short-transcript", {
      type: "boolean",
      default: false,
      description: "Skip the minimum-word-count check on transcripts (for legitimately short sessions)",
    })
    .check((argv) => {
      if (!argv.summarize && !argv.output && !argv.build && !argv.pages && !argv.preview && !argv.uncache && !argv.uncacheRemote) {
        throw new Error(
          "Must specify at least one action: --summarize, --output, --build, --pages, --preview, --uncache, or --uncache-remote",
        );
      }
      // --uncache-remote is a standalone action: it dispatches a remote
      // workflow and touches nothing locally, so it can't be mixed with the
      // local pipeline stages.
      if (argv.uncacheRemote) {
        if (argv.summarize || argv.output || argv.build || argv.pages || argv.preview || argv.uncache) {
          throw new Error("--uncache-remote cannot be combined with other actions");
        }
        // The remote workflow only knows how to drop minutes (re-run the LLM)
        // or all (also re-download and re-transcribe).
        if (argv.uncacheType && !["minutes", "all"].includes(argv.uncacheType)) {
          throw new Error("--uncache-remote supports only --uncache-type minutes or all");
        }
        for (const sel of argv.uncacheRemote) {
          try {
            parseSummarizeArg(String(sel));
          } catch (e) {
            throw new Error(`Invalid --uncache-remote selector "${sel}": ${e.message}`);
          }
        }
      }
      // Ensure --preview is mutually exclusive with other actions
      if (argv.preview && (argv.summarize || argv.output || argv.build || argv.pages || argv.uncache)) {
        throw new Error(
          "--preview cannot be used with other actions (--summarize, --output, --build, --pages, --uncache)",
        );
      }
      // Ensure --uncache is mutually exclusive with --summarize and --preview
      if (argv.uncache && (argv.summarize || argv.preview)) {
        throw new Error(
          "--uncache cannot be used with --summarize or --preview",
        );
      }
      // Validate --audio-file usage
      if (argv.audioFile) {
        if (!argv.preview && !argv.summarize) {
          throw new Error("--audio-file requires --preview or --summarize");
        }
        if (argv.output || argv.build || argv.pages || argv.uncache) {
          throw new Error("--audio-file cannot be used with --output, --build, --pages, or --uncache");
        }
      }
      // Validate --transcript-file usage
      if (argv.transcriptFile) {
        if (!argv.preview && !argv.summarize) {
          throw new Error("--transcript-file requires --preview or --summarize");
        }
        if (argv.output || argv.build || argv.pages || argv.uncache) {
          throw new Error("--transcript-file cannot be used with --output, --build, --pages, or --uncache");
        }
        if (argv.audioFile) {
          throw new Error("--transcript-file cannot be used with --audio-file");
        }
        if (argv.audio) {
          throw new Error("--transcript-file cannot be used with --audio");
        }
      }
      // Validate --gemini-segment-seconds usage
      if (argv.geminiSegmentSeconds !== undefined) {
        if (!Number.isFinite(argv.geminiSegmentSeconds) || argv.geminiSegmentSeconds <= 0) {
          throw new Error("--gemini-segment-seconds must be a positive number");
        }
        if (argv.sttModel !== "gemini") {
          throw new Error("--gemini-segment-seconds requires --stt-model gemini");
        }
      }
      // Validate --stt-model
      {
        const hasNames = argv.sttModel.endsWith("+names");
        const base = hasNames ? argv.sttModel.slice(0, -"+names".length) : argv.sttModel;
        const validBases = new Set(["google", "google:chirp_2", "google:chirp_3", "gemini"]);
        const namesCapableBases = new Set(["google", "google:chirp_3"]);
        if (hasNames && !namesCapableBases.has(base)) {
          throw new Error(`--stt-model "${argv.sttModel}" is invalid: the "+names" hybrid requires chirp_3 diarization and is only supported with "google" or "google:chirp_3" (e.g. "google:chirp_3+names"); chirp_2 does not produce speaker labels to map`);
        }
        if (!validBases.has(base)) {
          throw new Error(`--stt-model "${argv.sttModel}" is invalid; must be one of: google, google:chirp_2, google:chirp_3, gemini, or "google"/"google:chirp_3" suffixed with "+names"`);
        }
      }
      return true;
    })
    .strict()
    .help()
    .alias("help", "h")
    .parse();

  verbose = argv.verbose;
  setGenerationTimeout(argv.timeout * 1000);
  const allSkipped = [];
  const doSummarize = !!argv.summarize;
  const doOutput = argv.output;
  const doBuild = argv.build || argv.pages;
  const doPages = argv.pages;
  const doPreview = argv.preview;
  const doUncache = argv.uncache;
  const uncacheType = argv.uncacheType || "all";
  const source = argv.source;
  const sttModel = (argv.audio || argv.audioFile) ? (argv.sttModel || "google") : null;
  const parallel = argv.parallel;

  // REMOTE UNCACHE: dispatch the sync workflow to delete and regenerate the
  // given sessions on the remote repo. Terminal action; nothing runs locally.
  if (argv.uncacheRemote) {
    const selectors = argv.uncacheRemote.map(String);
    // --uncache-type defaults to "all" for the local path; for the remote it
    // defaults to the cheaper minutes-only. Distinguish an explicit flag from
    // the yargs default rather than inheriting "all".
    const typed = process.argv.some((a) => a === "--uncache-type" || a.startsWith("--uncache-type="));
    const remoteType = typed ? argv.uncacheType : "minutes";
    await dispatchRemoteUncache(selectors, remoteType, {
      repo: argv.repo,
      workflow: argv.workflow,
      ref: argv.ref,
    });
    return;
  }

  // Resolve model shorthand names and determine provider
  let modelName = argv.model;
  if (modelName === "gemini") {
    modelName = "gemini-3.5-flash";
  } else if (modelName === "claude") {
    modelName = "claude-sonnet-4-6";
  }

  let provider;
  if (modelName.startsWith("gemini")) {
    provider = "gemini";
  } else if (modelName.startsWith("claude")) {
    provider = "claude";
  } else {
    console.error(`Error: Unknown model "${modelName}". Model name must start with "gemini" or "claude".`);
    process.exit(1);
  }

  // Check for appropriate API key based on provider (only needed for summarize or preview)
  if (doSummarize || doPreview) {
    if (provider === "claude") {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        console.error("Error: ANTHROPIC_API_KEY not found in environment");
        console.error("Please create a .env file with your API key");
        process.exit(1);
      }
      initializeClaude(apiKey);
    } else if (provider === "gemini") {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.error("Error: GEMINI_API_KEY not found in environment");
        console.error("Please create a .env file with your API key");
        process.exit(1);
      }
      const { initializeGemini } = await import("./generator.js");
      initializeGemini(apiKey);
    }

    // --stt-model gemini (or a "+names" hybrid, which uses Gemini for speaker
    // name mapping) requires GEMINI_API_KEY, even when using claude for minutes
    if ((sttModel === "gemini" || (sttModel && sttModel.endsWith("+names"))) && provider === "claude") {
      const geminiKey = process.env.GEMINI_API_KEY;
      if (!geminiKey) {
        console.error(`Error: GEMINI_API_KEY is required for --stt-model ${sttModel}`);
        console.error("Please add GEMINI_API_KEY to your .env file");
        process.exit(1);
      }
    }

    // --stt-model google requires GCS_BUCKET and GOOGLE_APPLICATION_CREDENTIALS
    if (sttModel && sttModel.startsWith("google")) {
      if (!process.env.GCS_BUCKET) {
        console.error("Error: GCS_BUCKET environment variable is required for --stt-model google");
        console.error("Please add GCS_BUCKET=<your-bucket-name> to your .env file");
        process.exit(1);
      }
      if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        console.error("Error: GOOGLE_APPLICATION_CREDENTIALS environment variable is required for --stt-model google");
        console.error("Please set it to the path of your service account JSON key file");
        process.exit(1);
      }
    }
  }

  // Validate --audio-file path and extension before any network calls
  if (argv.audioFile) {
    if (!existsSync(argv.audioFile)) {
      console.error(`Error: --audio-file '${argv.audioFile}' does not exist`);
      process.exit(1);
    }
    const ext = path.extname(argv.audioFile).toLowerCase();
    if (!SUPPORTED_MEDIA_EXTENSIONS.has(ext)) {
      console.error(`Error: Unsupported file extension '${ext}'. Supported: ${[...SUPPORTED_MEDIA_EXTENSIONS].join(", ")}`);
      process.exit(1);
    }
  }

  // Validate --transcript-file path before any network calls
  if (argv.transcriptFile) {
    if (!existsSync(argv.transcriptFile)) {
      console.error(`Error: --transcript-file '${argv.transcriptFile}' does not exist`);
      process.exit(1);
    }
  }

  try {
    // UNCACHE STAGE: Clear cached data for specified sessions
    if (doUncache) {
      const parsed = parseSummarizeArg(argv.uncache);
      await processUncache(parsed, uncacheType);
    }

    // PREVIEW MODE: Generate and print minutes for a specific session
    if (doPreview) {
      console.log("\n=== PREVIEW MODE ===");
      console.log(`Using model: ${modelName}${sttModel ? ` (STT: ${sttModel})` : ""}`);

      // Parse the meeting:session-name format
      const parts = doPreview.split(":");
      if (parts.length !== 2) {
        throw new Error(
          "Invalid --preview format. Use: --preview meeting:session-name (e.g., --preview 123:6LO or 2026-04-14:AIPREF)",
        );
      }

      const [previewLeft, previewSessionName] = parts;
      let allSessions;

      if (/^\d{4}-\d{2}-\d{2}$/.test(previewLeft)) {
        // Interim meeting: YYYY-MM-DD:group
        console.log(`Previewing: Interim ${previewSessionName} (${previewLeft})`);
        console.log(`Looking up interim meeting for ${previewSessionName} on ${previewLeft}...`);
        allSessions = await fetchInterimSession(previewLeft, previewSessionName);
        console.log(`Found ${allSessions.length} session(s)`);
      } else {
        // IETF meeting: NUMBER:group or current:group
        let previewMeetingNumber;
        if (previewLeft.toLowerCase() === "current") {
          console.log("Resolving current IETF meeting number...");
          ({ number: previewMeetingNumber } = await fetchCurrentMeetingNumber());
          console.log(`Current IETF meeting: ${previewMeetingNumber}`);
        } else {
          previewMeetingNumber = parseInt(previewLeft, 10);
          if (isNaN(previewMeetingNumber) || !/^\d+$/.test(previewLeft)) {
            throw new Error(`Invalid meeting selector: "${previewLeft}" (use NUMBER, "current", or YYYY-MM-DD)`);
          }
        }

        console.log(
          `Previewing: IETF ${previewMeetingNumber}, Session: ${previewSessionName}`,
        );

        const baseFetchFunction =
          source === "agenda" ? fetchSessionsFromAgenda : fetchSessionsFromProceedings;
        console.log(`Fetching session list from ${source}...`);
        const result = await fetchSessionsWithValidation(baseFetchFunction, previewMeetingNumber);
        console.log(`Found ${result.stats.total} total sessions (${result.stats.valid} valid, ${result.stats.invalid} invalid)`);
        allSessions = result.validSessions;
      }

      // Filter to matching sessions (case-insensitive)
      const matchingSessions = allSessions.filter(
        (s) => s.sessionName.toLowerCase() === previewSessionName.toLowerCase(),
      );

      if (matchingSessions.length === 0) {
        throw new Error(
          `No sessions found with name: ${previewSessionName}\nAvailable sessions: ${[...new Set(allSessions.map((s) => s.sessionName))].sort().join(", ")}`,
        );
      }

      if (argv.audioFile && matchingSessions.length !== 1) {
        const sessionIds = matchingSessions.map(s => s.sessionId).join(", ");
        throw new Error(
          `--audio-file requires exactly one session; resolved ${matchingSessions.length}: ${sessionIds}. Pass one as the selector or remove --audio-file.`,
        );
      }
      if (argv.transcriptFile && matchingSessions.length !== 1) {
        const sessionIds = matchingSessions.map(s => s.sessionId).join(", ");
        throw new Error(
          `--transcript-file requires exactly one session; resolved ${matchingSessions.length}: ${sessionIds}. Pass one as the selector or remove --transcript-file.`,
        );
      }

      console.log(
        `Found ${matchingSessions.length} session(s) matching "${previewSessionName}"`,
      );

      // Process each matching session
      const allMinutes = [];
      for (const session of matchingSessions) {
        console.log(`\nProcessing: ${session.sessionId}`);

        // Fetch slides, bluesheet, and WG documents for context (no cache in preview)
        // Fetched before transcription so context can help Gemini STT identify speakers
        console.log("  Fetching context (slides, bluesheet, WG docs)...");
        const context = await fetchContextForSession(session);

        // Report context results immediately so the user sees them before
        // transcription begins. (Preview mode intentionally does not cache.)
        if (context.slidesAndBluesheet) {
          if (context.slidesAndBluesheet.slides?.length) {
            console.log(`  Fetched ${context.slidesAndBluesheet.slides.length} slide deck(s)`);
          }
          if (context.slidesAndBluesheet.bluesheet) {
            console.log(`  Fetched bluesheet (${context.slidesAndBluesheet.bluesheet.length} chars)`);
          }
        }

        // Download transcript (no cache) - from local file, audio, or text
        let transcript;
        try {
          if (argv.transcriptFile) {
            console.log(`  Using local transcript: ${argv.transcriptFile}`);
            transcript = prepareLocalTranscript(session, argv.transcriptFile, verbose);
          } else if (sttModel) {
            console.log(`  Using audio transcription (${sttModel})...`);
            const result = await transcribeSession(session, sttModel, process.env.GEMINI_API_KEY, verbose, context, argv.audioFile || null, argv.geminiSegmentSeconds || null);
            transcript = result.text;
            recordUsage(result.usage);
          } else {
            console.log("  Downloading transcript...");
            transcript = await downloadTranscript(session);
          }
        } catch (error) {
          console.error(`  Error getting transcript: ${error.message}`);
          continue;
        }

        // Generate minutes using LLM (no cache)
        console.log("  Generating minutes with LLM...");
        let minutes, minutesUsage;
        try {
          const result = await generateMinutes(transcript, session.sessionName, verbose, modelName, context);
          minutes = result.text;
          minutesUsage = result.usage;
        } catch (error) {
          console.error(`  Error generating minutes: ${error.message}`);
          continue;
        }
        recordUsage(minutesUsage);

        // Add date/time header
        const { dateTimeHeader } = parseSessionId(session.sessionId);
        allMinutes.push(`${dateTimeHeader}${minutes}`);

        console.log("  Done!");
      }

      // Print all minutes to stdout
      console.log("\n" + "=".repeat(80));
      console.log("GENERATED MINUTES");
      console.log("=".repeat(80) + "\n");
      console.log(allMinutes.join("\n\n---\n\n"));
      console.log("\n" + "=".repeat(80));

      printSummary();
      return; // Exit after preview
    }

    // SUMMARIZE STAGE: Download transcripts and generate LLM summaries
    if (doSummarize) {
      const parsed = parseSummarizeArg(argv.summarize);

      if (argv.audioFile && !['ietf-group', 'interim'].includes(parsed.type)) {
        throw new Error(
          `--audio-file requires a single-session selector (NUMBER:GROUP or YYYY-MM-DD:GROUP), got ${parsed.type}.`,
        );
      }
      if (argv.transcriptFile && !['ietf-group', 'interim'].includes(parsed.type)) {
        throw new Error(
          `--transcript-file requires a single-session selector (NUMBER:GROUP or YYYY-MM-DD:GROUP), got ${parsed.type}.`,
        );
      }

      if (parsed.type === 'interim-range') {
        // Process interims in a date range
        const rangeLabel = parsed.endDate
          ? `${parsed.startDate} to ${parsed.endDate}`
          : `${parsed.startDate}+`;
        console.log(`\n=== SUMMARIZE STAGE: Interims from ${rangeLabel} ===`);
        console.log(`Using model: ${modelName}`);

        const sessionsByDate = await fetchInterimSessionsInRange(parsed.startDate, parsed.endDate);
        console.log(`\nFound sessions across ${sessionsByDate.size} date(s)`);

        for (const [date, sessions] of sessionsByDate) {
          const filtered = parsed.group
            ? sessions.filter(s => s.sessionName.toLowerCase() === parsed.group.toLowerCase())
            : sessions;
          if (filtered.length === 0) continue;
          try {
            console.log(`\n--- Processing interims for ${date} ---`);
            const skipped = await processSummarizeSessions(date, filtered, sttModel, modelName, parallel, null, argv.geminiSegmentSeconds || null, null, argv.allowShortTranscript);
            allSkipped.push(...skipped);
          } catch (error) {
            console.warn(`Warning: Failed to process interims for ${date}: ${error.message}`);
          }
        }
      } else {
        // Single meetingId case: current, ietf, interim, or interim-all
        let meetingId;
        let sessions;

        if (parsed.type === 'current') {
          console.log("Resolving current IETF meeting number...");
          const current = await fetchCurrentMeetingNumber();
          meetingId = current.number;
          console.log(`Current IETF meeting: ${meetingId}`);

          if (!current.inProgress) {
            console.log(`IETF ${meetingId} has not started yet; nothing to summarize.`);
            // Fall through: leave sessions undefined so the summarize call
            // below is skipped, but allow later stages (--output, --build) to
            // still run against previously-cached meetings.
          } else {
            console.log(`\n=== SUMMARIZE STAGE: IETF ${meetingId} ===`);
            console.log(`Using model: ${modelName}${sttModel ? ` (STT: ${sttModel})` : ""}`);

            const baseFetchFunction = source === "agenda" ? fetchSessionsFromAgenda : fetchSessionsFromProceedings;
            console.log(`Fetching session list from ${source}...`);
            const result = await fetchSessionsWithValidation(baseFetchFunction, meetingId);
            console.log(`Found ${result.stats.total} sessions (${result.stats.valid} valid, ${result.stats.invalid} invalid)`);
            sessions = result.validSessions;
          }
        } else if (parsed.type === 'ietf-group') {
          meetingId = parsed.meetingNumber;
          console.log(`\n=== SUMMARIZE STAGE: IETF ${meetingId} — ${parsed.group} ===`);
          console.log(`Using model: ${modelName}${sttModel ? ` (STT: ${sttModel})` : ""}`);

          const baseFetchFunction = source === "agenda" ? fetchSessionsFromAgenda : fetchSessionsFromProceedings;
          console.log(`Fetching session list from ${source}...`);
          const result = await fetchSessionsWithValidation(baseFetchFunction, meetingId);
          console.log(`Found ${result.stats.total} sessions (${result.stats.valid} valid, ${result.stats.invalid} invalid)`);
          const groupLower = parsed.group.toLowerCase();
          sessions = result.validSessions.filter(
            s => s.sessionName.toLowerCase() === groupLower
          );
          if (sessions.length === 0) {
            const available = [...new Set(result.validSessions.map(s => s.sessionName))].sort().join(', ');
            throw new Error(`No sessions found matching "${parsed.group}" in IETF ${meetingId}.\nAvailable: ${available}`);
          }
          console.log(`Filtered to ${sessions.length} session(s) for ${parsed.group}`);
          if (argv.audioFile && sessions.length !== 1) {
            const sessionIds = sessions.map(s => s.sessionId).join(", ");
            throw new Error(
              `--audio-file requires exactly one session; resolved ${sessions.length}: ${sessionIds}. Pass one as the selector or remove --audio-file.`,
            );
          }
          if (argv.transcriptFile && sessions.length !== 1) {
            const sessionIds = sessions.map(s => s.sessionId).join(", ");
            throw new Error(
              `--transcript-file requires exactly one session; resolved ${sessions.length}: ${sessionIds}. Pass one as the selector or remove --transcript-file.`,
            );
          }
        } else if (parsed.type === 'interim') {
          meetingId = parsed.date;
          console.log(`\n=== SUMMARIZE STAGE: Interim ${parsed.group} (${parsed.date}) ===`);
          console.log(`Using model: ${modelName}`);

          console.log(`Looking up interim meeting for ${parsed.group} on ${parsed.date}...`);
          sessions = await fetchInterimSession(parsed.date, parsed.group);
          console.log(`Found ${sessions.length} session(s)`);
          if (argv.audioFile && sessions.length !== 1) {
            const sessionIds = sessions.map(s => s.sessionId).join(", ");
            throw new Error(
              `--audio-file requires exactly one session; resolved ${sessions.length}: ${sessionIds}. Pass one as the selector or remove --audio-file.`,
            );
          }
          if (argv.transcriptFile && sessions.length !== 1) {
            const sessionIds = sessions.map(s => s.sessionId).join(", ");
            throw new Error(
              `--transcript-file requires exactly one session; resolved ${sessions.length}: ${sessionIds}. Pass one as the selector or remove --transcript-file.`,
            );
          }
        } else if (parsed.type === 'interim-all') {
          meetingId = parsed.date;
          console.log(`\n=== SUMMARIZE STAGE: All interims on ${parsed.date} ===`);
          console.log(`Using model: ${modelName}`);

          sessions = await fetchAllInterimSessions(parsed.date);
          console.log(`Found ${sessions.length} session(s)`);
        } else {
          meetingId = parsed.meetingNumber;
          console.log(`\n=== SUMMARIZE STAGE: IETF ${meetingId} ===`);
          console.log(`Using model: ${modelName}${sttModel ? ` (STT: ${sttModel})` : ""}`);

          const baseFetchFunction = source === "agenda" ? fetchSessionsFromAgenda : fetchSessionsFromProceedings;
          console.log(`Fetching session list from ${source}...`);
          const result = await fetchSessionsWithValidation(baseFetchFunction, meetingId);
          console.log(`Found ${result.stats.total} sessions (${result.stats.valid} valid, ${result.stats.invalid} invalid)`);
          sessions = result.validSessions;
        }

        if (sessions !== undefined) {
          const skipped = await processSummarizeSessions(meetingId, sessions, sttModel, modelName, parallel, argv.audioFile || null, argv.geminiSegmentSeconds || null, argv.transcriptFile || null, argv.allowShortTranscript);
          allSkipped.push(...skipped);
        }
      }
    }

    // OUTPUT STAGE: Generate markdown output files from cache for ALL meetings
    if (doOutput) {
      console.log("\n=== OUTPUT STAGE ===");
      console.log("Scanning cache for meetings...");

      const cachedMeetings = await getCachedMeetingIds();
      console.log(
        `Found ${cachedMeetings.length} cached meetings: ${cachedMeetings.join(", ")}`,
      );

      for (const meetingId of cachedMeetings) {
        const isPlenary = typeof meetingId === 'number';
        const label = isPlenary ? `IETF ${meetingId}` : `Interim ${meetingId}`;
        const outputDir = isPlenary
          ? `site/minutes/ietf${meetingId}`
          : `site/minutes/${meetingId}`;

        console.log(`\n--- Processing ${label} ---`);

        console.log("Loading cache manifest...");
        const sessionGroups = await loadCacheManifest(meetingId);
        console.log(`Found ${sessionGroups.length} session groups`);

        const processedSessions = [];
        for (const group of sessionGroups) {
          console.log(`\nGenerating output for: ${group.sessionName}`);

          const allMinutes = [];
          const recordingUrls = [];

          for (const session of group.sessions) {
            const minutes = await getCachedMinutes(
              meetingId,
              session.sessionId,
            );
            const { dateTimeHeader } = parseSessionId(session.sessionId);
            allMinutes.push(`${dateTimeHeader}${minutes}`);
            recordingUrls.push(session.recordingUrl);
          }

          // Concatenate all minutes for this session name
          const combinedMinutes = allMinutes.join("\n\n---\n\n");

          // Check for cached transcripts and copy to output
          let transcriptFile = null;
          const allTranscripts = [];
          for (const session of group.sessions) {
            const transcriptPath = getTranscriptCachePath(session.sessionId);
            if (existsSync(transcriptPath)) {
              const transcript = await fs.readFile(transcriptPath, "utf-8");
              try {
                assertTranscriptPresent(transcript, session.sessionId);
              } catch {
                continue; // Cached transcript is empty/invalid — don't publish it
              }
              const { dateTimeHeader } = parseSessionId(session.sessionId);
              allTranscripts.push(`${dateTimeHeader}${transcript}`);
            }
          }
          if (allTranscripts.length > 0) {
            const sanitizedName = sanitizeSessionName(group.sessionName);
            const transcriptTxtFile = `${sanitizedName}-transcript.txt`;
            const transcriptMdFile = `${sanitizedName}-transcript.md`;
            transcriptFile = `${sanitizedName}-transcript.html`;
            const combinedTranscripts = allTranscripts.join("\n\n---\n\n");
            await fs.mkdir(outputDir, { recursive: true });
            // Write .txt (raw markdown)
            await fs.writeFile(
              path.join(outputDir, transcriptTxtFile),
              combinedTranscripts,
              "utf-8",
            );
            // Write .md with header link (rendered by 11ty to .html)
            const transcriptWithHeader = `[Markdown Version](${transcriptTxtFile})\n\n${combinedTranscripts}`;
            await fs.writeFile(
              path.join(outputDir, transcriptMdFile),
              transcriptWithHeader,
              "utf-8",
            );
            console.log(`  Copied transcript: ${transcriptMdFile} + ${transcriptTxtFile}`);
          }

          // Save to output — draft links are extracted from the generated minutes content
          await saveMinutes(
            group.sessionName,
            combinedMinutes,
            outputDir,
            recordingUrls,
            transcriptFile,
            meetingId,
          );
          processedSessions.push(group.sessionName);
          console.log(`  Saved: ${group.sessionName}`);
        }

        // Generate index page
        console.log("Generating index...");
        await generateIndex(processedSessions, outputDir);
        console.log(`Completed ${label}`);
      }

      // Generate WG pages
      console.log("\nGenerating WG pages...");
      await generateWgPages();

      // Generate root index
      console.log("\nGenerating root index...");
      await generateRootIndex();
      console.log("Root index generated at site/index.md");
    }

    if (allSkipped.length > 0) {
      console.log(`\n=== SKIPPED SESSIONS (${allSkipped.length}) ===`);
      for (const s of allSkipped) {
        console.log(`  ${s.sessionName} [${s.sessionId}]: ${s.reason}`);
      }
    }

    printSummary();
    console.log("\nAll done!");

    // BUILD STAGE: Build site with 11ty if requested
    if (doBuild) {
      console.log("\n=== BUILD STAGE ===");
      await buildSite(doPages);
    }

    if (allSkipped.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

/**
 * Build site with 11ty and optionally prepare GitHub Pages
 * @param {boolean} preparePages - Whether to prepare GitHub Pages after building
 */
async function buildSite(preparePages = false) {
  const { execSync } = await import("child_process");
  const fs = await import("fs/promises");
  const path = await import("path");

  try {
    // Remove existing _site directory
    console.log("Cleaning _site directory...");
    try {
      await fs.rm("_site", { recursive: true, force: true });
    } catch (err) {
      // Directory doesn't exist, that's fine
    }

    console.log("Building site with 11ty...");
    execSync("npx @11ty/eleventy", { stdio: "inherit" });
    console.log("Successfully built site to _site/");

    if (preparePages) {
      const repoUrl = "git@github.com:ekr/auto-minutes.git";
      const ghPagesDir = "gh-pages-repo";
      const docsDir = path.join(ghPagesDir, "docs");

      try {
        // Step 1: Remove existing gh-pages repo if it exists
        console.log("\nPreparing to push to GitHub Pages...");
        try {
          await fs.rm(ghPagesDir, { recursive: true, force: true });
          console.log("Removed existing gh-pages-repo directory");
        } catch (err) {
          // Directory doesn't exist, that's fine
        }

        // Step 2: Clone the gh-pages branch
        console.log("Cloning gh-pages branch...");
        execSync(`git clone -b gh-pages --single-branch ${repoUrl} ${ghPagesDir}`, {
          stdio: "inherit",
        });

        // Step 3: Reset to baseline tag
        console.log("Resetting to baseline tag...");
        process.chdir(ghPagesDir);
        execSync("git reset --hard baseline", { stdio: "inherit" });
        process.chdir("..");

        // Step 4: Clear docs directory
        console.log("Clearing docs directory...");
        await fs.rm(docsDir, { recursive: true, force: true });
        await fs.mkdir(docsDir, { recursive: true });

        // Step 5: Copy everything from _site to gh-pages-repo/docs
        console.log("Copying _site/ to gh-pages-repo/docs/...");
        const allowedExtensions = ['.css', '.html', '.txt', '.jpg', '.png'];
        const copiedFiles = await copyDir("_site", docsDir, allowedExtensions);
        console.log(`Copied ${copiedFiles.length} files`);

        // Step 6: Git add and commit
        console.log("Adding files to git...");
        process.chdir(ghPagesDir);
        for (const file of copiedFiles) {
          // Get path relative to docsDir (e.g., "docs/index.html")
          const relativePath = path.relative(ghPagesDir, file);
          if (verbose) {
            console.log(`  Adding: ${relativePath}`);
          }
          execSync(`git add "${relativePath}"`, { stdio: "inherit" });
        }

        console.log("Committing changes...");
        execSync('git commit -m "Updated pages with current minutes"', { stdio: "inherit" });
        process.chdir("..");

        console.log("Successfully prepared gh-pages branch");
      } catch (error) {
        console.error("Error preparing gh-pages:", error.message);
        // Try to clean up even on error
        try {
          await fs.rm(ghPagesDir, { recursive: true, force: true });
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
        throw error;
      }
    }
  } catch (error) {
    console.error("Error in build/push process:", error.message);
    throw error;
  }
}

/**
 * Recursively copy directory contents, filtering by allowed file extensions
 * @param {string} src - Source directory
 * @param {string} dest - Destination directory
 * @param {Array<string>} allowedExtensions - Array of allowed file extensions (e.g., ['.html', '.css'])
 * @returns {Promise<Array<string>>} Array of destination file paths that were copied
 */
async function copyDir(src, dest, allowedExtensions = null) {
  const fs = await import("fs/promises");
  const path = await import("path");

  const copiedFiles = [];

  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      const subFiles = await copyDir(srcPath, destPath, allowedExtensions);
      copiedFiles.push(...subFiles);
    } else {
      // If no filter specified, copy all files
      if (!allowedExtensions) {
        await fs.copyFile(srcPath, destPath);
        copiedFiles.push(destPath);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (allowedExtensions.includes(ext)) {
          await fs.copyFile(srcPath, destPath);
          copiedFiles.push(destPath);
        }
      }
    }
  }

  return copiedFiles;
}

main().then(() => process.exit(process.exitCode || 0));
