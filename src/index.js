/**
 * Auto-Minutes Main Entry Point
 * Orchestrates the process of generating meeting minutes from IETF transcripts
 */

import dotenv from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { fetchSessionsFromProceedings, fetchSessionsFromAgenda, downloadTranscript, fetchSessionsWithValidation, fetchCurrentMeetingNumber, fetchInterimSession, fetchAllInterimSessions, fetchInterimSessionsInRange } from "./scraper.js";
import { initializeClaude, generateMinutes, setGenerationTimeout } from "./generator.js";
import { transcribeSession } from "./transcriber.js";
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
} from "./publisher.js";

// Load environment variables
dotenv.config();

// Global verbose flag
let verbose = false;

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
    const p = task().then(r => { executing.delete(p); return r; });
    executing.add(p);
    results.push(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
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
async function generateSessionMinutes(meetingNumber, session, useAudio = false, modelName = null) {
  // Check cache first
  if (await cacheExists(meetingNumber, session.sessionId)) {
    console.log(`  Loading from cache: ${session.sessionId}`);
    const minutes = await getCachedMinutes(meetingNumber, session.sessionId);
    return { minutes, wasGenerated: false };
  }

  // Download transcript - either from audio or text
  let transcript;
  try {
    if (useAudio) {
      console.log(`  Transcribing audio: ${session.sessionId}`);
      transcript = await transcribeSession(session, process.env.GEMINI_API_KEY, verbose);
    } else {
      console.log(`  Downloading transcript: ${session.sessionId}`);
      transcript = await downloadTranscript(session);
    }
  } catch (error) {
    console.log(`  Could not fetch transcript: ${error.message}`);
    return { minutes: "", wasGenerated: false }; // Return empty minutes if transcript unavailable
  }

  // Generate minutes using LLM
  console.log(`  Generating minutes with LLM: ${session.sessionId}`);
  let minutes;
  try {
    minutes = await generateMinutes(transcript, session.sessionName, verbose, modelName);
  } catch (error) {
    console.log(`  Could not generate minutes: ${error.message}`);
    return { minutes: "", wasGenerated: false };
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
 * @param {boolean} useAudio - Whether to use audio transcription
 */
async function processSummarizeSessions(meetingId, sessions, useAudio = false, modelName = null, parallel = 1) {
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
      const result = await generateSessionMinutes(meetingId, session, useAudio, modelName);
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
    .example("$0 --preview 123:6LO --audio", "Preview with audio transcription")
    .example("$0 --summarize 123 -j 5", "Process 5 sessions in parallel")
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
      default: "gemini-3.1-pro-preview",
      description: "LLM model to use (e.g., gemini-3-flash, claude-sonnet-4-6, or shorthand: gemini, claude)",
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
      description: "Use audio transcription (download audio and transcribe with Gemini STT) instead of Meetecho text transcript",
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
    .check((argv) => {
      if (!argv.summarize && !argv.output && !argv.build && !argv.pages && !argv.preview) {
        throw new Error(
          "Must specify at least one action: --summarize, --output, --build, --pages, or --preview",
        );
      }
      // Ensure --preview is mutually exclusive with other actions
      if (argv.preview && (argv.summarize || argv.output || argv.build || argv.pages)) {
        throw new Error(
          "--preview cannot be used with other actions (--summarize, --output, --build, --pages)",
        );
      }
      return true;
    })
    .help()
    .alias("help", "h")
    .parse();

  verbose = argv.verbose;
  setGenerationTimeout(argv.timeout * 1000);
  const doSummarize = !!argv.summarize;
  const doOutput = argv.output;
  const doBuild = argv.build || argv.pages;
  const doPages = argv.pages;
  const doPreview = argv.preview;
  const source = argv.source;
  const useAudio = argv.audio;
  const parallel = argv.parallel;

  // Resolve model shorthand names and determine provider
  let modelName = argv.model;
  if (modelName === "gemini") {
    modelName = "gemini-3.1-pro-preview";
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

    // --audio always requires GEMINI_API_KEY for STT, even when using claude for minutes
    if (useAudio && provider === "claude") {
      const geminiKey = process.env.GEMINI_API_KEY;
      if (!geminiKey) {
        console.error("Error: GEMINI_API_KEY is required for --audio (Gemini STT)");
        console.error("Please add GEMINI_API_KEY to your .env file");
        process.exit(1);
      }
    }
  }

  try {
    // PREVIEW MODE: Generate and print minutes for a specific session
    if (doPreview) {
      console.log("\n=== PREVIEW MODE ===");
      console.log(`Using model: ${modelName}${useAudio ? " (audio transcription enabled)" : ""}`);

      // Parse the meeting:session-name format
      const parts = doPreview.split(":");
      if (parts.length !== 2) {
        throw new Error(
          "Invalid --preview format. Use: --preview meeting:session-name (e.g., --preview 123:6LO)",
        );
      }

      let previewMeetingNumber;
      const previewSessionName = parts[1];

      if (parts[0].toLowerCase() === "current") {
        console.log("Resolving current IETF meeting number...");
        previewMeetingNumber = await fetchCurrentMeetingNumber();
        console.log(`Current IETF meeting: ${previewMeetingNumber}`);
      } else {
        previewMeetingNumber = parseInt(parts[0], 10);
        if (isNaN(previewMeetingNumber)) {
          throw new Error(`Invalid meeting number: ${parts[0]}`);
        }
      }

      console.log(
        `Previewing: IETF ${previewMeetingNumber}, Session: ${previewSessionName}`,
      );

      // Fetch all sessions for the meeting
      const baseFetchFunction =
        source === "agenda" ? fetchSessionsFromAgenda : fetchSessionsFromProceedings;
      console.log(`Fetching session list from ${source}...`);
      const result = await fetchSessionsWithValidation(baseFetchFunction, previewMeetingNumber);
      console.log(`Found ${result.stats.total} total sessions (${result.stats.valid} valid, ${result.stats.invalid} invalid)`);
      const allSessions = result.validSessions;

      // Filter to matching sessions (case-insensitive)
      const matchingSessions = allSessions.filter(
        (s) => s.sessionName.toLowerCase() === previewSessionName.toLowerCase(),
      );

      if (matchingSessions.length === 0) {
        throw new Error(
          `No sessions found with name: ${previewSessionName}\nAvailable sessions: ${[...new Set(allSessions.map((s) => s.sessionName))].sort().join(", ")}`,
        );
      }

      console.log(
        `Found ${matchingSessions.length} session(s) matching "${previewSessionName}"`,
      );

      // Process each matching session
      const allMinutes = [];
      for (const session of matchingSessions) {
        console.log(`\nProcessing: ${session.sessionId}`);

        // Download transcript (no cache) - either from audio or text
        let transcript;
        try {
          if (useAudio) {
            console.log("  Using audio transcription...");
            transcript = await transcribeSession(session, process.env.GEMINI_API_KEY, verbose);
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
        const minutes = await generateMinutes(
          transcript,
          session.sessionName,
          verbose,
          modelName,
        );

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

      return; // Exit after preview
    }

    // SUMMARIZE STAGE: Download transcripts and generate LLM summaries
    if (doSummarize) {
      const parsed = parseSummarizeArg(argv.summarize);

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
            await processSummarizeSessions(date, filtered, useAudio, modelName, parallel);
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
          meetingId = await fetchCurrentMeetingNumber();
          console.log(`Current IETF meeting: ${meetingId}`);

          console.log(`\n=== SUMMARIZE STAGE: IETF ${meetingId} ===`);
          console.log(`Using model: ${modelName}${useAudio ? " (audio transcription enabled)" : ""}`);

          const baseFetchFunction = source === "agenda" ? fetchSessionsFromAgenda : fetchSessionsFromProceedings;
          console.log(`Fetching session list from ${source}...`);
          const result = await fetchSessionsWithValidation(baseFetchFunction, meetingId);
          console.log(`Found ${result.stats.total} sessions (${result.stats.valid} valid, ${result.stats.invalid} invalid)`);
          sessions = result.validSessions;
        } else if (parsed.type === 'ietf-group') {
          meetingId = parsed.meetingNumber;
          console.log(`\n=== SUMMARIZE STAGE: IETF ${meetingId} — ${parsed.group} ===`);
          console.log(`Using model: ${modelName}${useAudio ? " (audio transcription enabled)" : ""}`);

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
        } else if (parsed.type === 'interim') {
          meetingId = parsed.date;
          console.log(`\n=== SUMMARIZE STAGE: Interim ${parsed.group} (${parsed.date}) ===`);
          console.log(`Using model: ${modelName}`);

          console.log(`Looking up interim meeting for ${parsed.group} on ${parsed.date}...`);
          sessions = await fetchInterimSession(parsed.date, parsed.group);
          console.log(`Found ${sessions.length} session(s)`);
        } else if (parsed.type === 'interim-all') {
          meetingId = parsed.date;
          console.log(`\n=== SUMMARIZE STAGE: All interims on ${parsed.date} ===`);
          console.log(`Using model: ${modelName}`);

          sessions = await fetchAllInterimSessions(parsed.date);
          console.log(`Found ${sessions.length} session(s)`);
        } else {
          meetingId = parsed.meetingNumber;
          console.log(`\n=== SUMMARIZE STAGE: IETF ${meetingId} ===`);
          console.log(`Using model: ${modelName}${useAudio ? " (audio transcription enabled)" : ""}`);

          const baseFetchFunction = source === "agenda" ? fetchSessionsFromAgenda : fetchSessionsFromProceedings;
          console.log(`Fetching session list from ${source}...`);
          const result = await fetchSessionsWithValidation(baseFetchFunction, meetingId);
          console.log(`Found ${result.stats.total} sessions (${result.stats.valid} valid, ${result.stats.invalid} invalid)`);
          sessions = result.validSessions;
        }

        await processSummarizeSessions(meetingId, sessions, useAudio, modelName, parallel);
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

          // Save to output (with recording URLs)
          await saveMinutes(
            group.sessionName,
            combinedMinutes,
            outputDir,
            recordingUrls,
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

    console.log("\nAll done!");

    // BUILD STAGE: Build site with 11ty if requested
    if (doBuild) {
      console.log("\n=== BUILD STAGE ===");
      await buildSite(doPages);
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

main();
