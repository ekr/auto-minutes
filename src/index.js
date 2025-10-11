/**
 * Auto-Minutes Main Entry Point
 * Orchestrates the process of generating meeting minutes from IETF transcripts
 */

import dotenv from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { fetchMeetingSessions, downloadTranscript } from "./scraper.js";
import { initializeClaude, generateMinutes } from "./generator.js";
import {
  saveMinutes,
  generateIndex,
  minutesExist,
  generateRootIndex,
  cacheExists,
  saveCachedMinutes,
  getCachedMinutes,
  getCachedSessionIds,
  saveCacheManifest,
  loadCacheManifest,
  getCachedMeetingNumbers,
} from "./publisher.js";

// Load environment variables
dotenv.config();

/**
 * Generate minutes for a session (checks cache first, otherwise downloads and generates)
 * @param {number} meetingNumber - IETF meeting number
 * @param {Object} session - Session object with sessionName and sessionId
 * @returns {Promise<string>} The generated minutes (raw markdown)
 */
async function generateSessionMinutes(meetingNumber, session) {
  // Check cache first
  if (await cacheExists(meetingNumber, session.sessionId)) {
    console.log(`  Loading from cache: ${session.sessionId}`);
    return await getCachedMinutes(meetingNumber, session.sessionId);
  }

  // Download transcript
  console.log(`  Downloading transcript: ${session.sessionId}`);
  let transcript;
  try {
    transcript = await downloadTranscript(session);
  } catch (error) {
    console.log(`  Could not fetch transcript: ${error.message}`);
    return ""; // Return empty minutes if transcript unavailable
  }

  // Generate minutes using LLM
  console.log(`  Generating minutes with LLM: ${session.sessionId}`);
  const minutes = await generateMinutes(transcript, session.sessionName);

  // Save to cache
  await saveCachedMinutes(meetingNumber, session.sessionId, minutes);
  console.log(`  Cached: ${session.sessionId}`);

  return minutes;
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

async function main() {
  const argv = yargs(hideBin(process.argv))
    .usage("Usage: $0 [options]")
    .example("$0 --summarize 123", "Generate LLM summaries for IETF 123")
    .example("$0 --output", "Generate output markdown files from cache")
    .example("$0 --summarize 123 --output", "Generate summaries and output")
    .example("$0 --build", "Build site with 11ty (outputs to _site/)")
    .example("$0 --output --build", "Generate output and build site")
    .example("$0 --push", "Build and push to GitHub Pages")
    .option("summarize", {
      alias: "s",
      type: "number",
      description:
        "Generate LLM summaries for meeting number (cache raw minutes)",
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
    .option("push", {
      alias: "P",
      type: "boolean",
      description: "Build and push to GitHub Pages",
    })
    .option("model", {
      alias: "m",
      type: "string",
      choices: ["claude", "gemini"],
      default: "gemini",
      description: "LLM model to use for generating minutes",
    })
    .option("verbose", {
      alias: "v",
      type: "boolean",
      description: "Run with verbose output",
    })
    .check((argv) => {
      if (!argv.summarize && !argv.output && !argv.build && !argv.push) {
        throw new Error(
          "Must specify at least one action: --summarize, --output, --build, or --push",
        );
      }
      return true;
    })
    .help()
    .alias("help", "h")
    .parse();

  const meetingNumber = argv.summarize;
  const verbose = argv.verbose;
  const doSummarize = !!argv.summarize;
  const doOutput = argv.output;
  const doBuild = argv.build || argv.push;
  const doPush = argv.push;
  const model = argv.model;

  // Check for appropriate API key based on model (only needed for summarize)
  if (doSummarize) {
    if (model === "claude") {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        console.error("Error: ANTHROPIC_API_KEY not found in environment");
        console.error("Please create a .env file with your API key");
        process.exit(1);
      }
      initializeClaude(apiKey);
    } else if (model === "gemini") {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.error("Error: GEMINI_API_KEY not found in environment");
        console.error("Please create a .env file with your API key");
        process.exit(1);
      }
      const { initializeGemini } = await import("./generator.js");
      initializeGemini(apiKey);
    }
  }

  try {
    // SUMMARIZE STAGE: Download transcripts and generate LLM summaries
    if (doSummarize) {
      console.log(`\n=== SUMMARIZE STAGE: IETF ${meetingNumber} ===`);
      console.log(`Using ${model} model...`);

      // Step 1: Fetch all sessions for the meeting
      console.log("Fetching session list...");
      const sessions = await fetchMeetingSessions(meetingNumber);
      console.log(`Found ${sessions.length} sessions`);

      if (verbose) {
        console.log("\n=== Session List Structure (JSON) ===");
        console.log(JSON.stringify(sessions, null, 2));
        console.log("=== End Session List ===\n");
      }

      // Step 2: Group sessions by name (multiple sessions can have the same name)
      const sessionsByName = new Map();
      for (const session of sessions) {
        if (!sessionsByName.has(session.sessionName)) {
          sessionsByName.set(session.sessionName, []);
        }
        sessionsByName.get(session.sessionName).push(session);
      }

      // Step 3: Process each session - generate/cache LLM summaries
      const sessionGroups = [];
      for (const [sessionName, sessionGroup] of sessionsByName) {
        console.log(
          `\nProcessing session group: ${sessionName} (${sessionGroup.length} session(s))`,
        );

        const processedSessions = [];
        for (const session of sessionGroup) {
          console.log(
            `  Processing ${session.sessionName} [${session.sessionId}]...`,
          );

          // Generate minutes (uses cache if available, otherwise downloads and generates)
          const minutes = await generateSessionMinutes(meetingNumber, session);

          // Skip if no minutes were generated (transcript unavailable)
          if (!minutes) {
            console.log(
              `  Skipping ${session.sessionName} [${session.sessionId}] - no transcript`,
            );
            continue;
          }

          processedSessions.push({
            sessionId: session.sessionId,
            recordingUrl: session.recordingUrl,
          });
          console.log(
            `  Completed ${session.sessionName} [${session.sessionId}]`,
          );
        }

        // Only add to manifest if at least one session was processed
        if (processedSessions.length > 0) {
          sessionGroups.push({
            sessionName,
            sessions: processedSessions,
          });
        }
      }

      // Save manifest to cache
      console.log("\nSaving cache manifest...");
      await saveCacheManifest(meetingNumber, sessionGroups);
      console.log(`Cached ${sessionGroups.length} session groups`);
    }

    // OUTPUT STAGE: Generate markdown output files from cache for ALL meetings
    if (doOutput) {
      console.log("\n=== OUTPUT STAGE ===");
      console.log("Scanning cache for meetings...");

      const cachedMeetings = await getCachedMeetingNumbers();
      console.log(
        `Found ${cachedMeetings.length} cached meetings: ${cachedMeetings.join(", ")}`,
      );

      for (const meetingNum of cachedMeetings) {
        console.log(`\n--- Processing IETF ${meetingNum} ---`);
        const outputDir = `site/minutes/ietf${meetingNum}`;

        console.log("Loading cache manifest...");
        const sessionGroups = await loadCacheManifest(meetingNum);
        console.log(`Found ${sessionGroups.length} session groups`);

        const processedSessions = [];
        for (const group of sessionGroups) {
          console.log(`\nGenerating output for: ${group.sessionName}`);

          const allMinutes = [];
          const recordingUrls = [];

          for (const session of group.sessions) {
            const minutes = await getCachedMinutes(
              meetingNum,
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
        console.log(`Completed IETF ${meetingNum}`);
      }

      // Generate root index
      console.log("\nGenerating root index...");
      await generateRootIndex("site");
      console.log("Root index generated at site/index.md");
    }

    console.log("\nAll done!");

    // BUILD STAGE: Build site with 11ty if requested
    if (doBuild) {
      console.log("\n=== BUILD STAGE ===");
      await buildSite(doPush);
    }
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

/**
 * Build site with 11ty and optionally push to GitHub Pages
 * @param {boolean} push - Whether to push to GitHub Pages after building
 */
async function buildSite(push = false) {
  const { execSync } = await import("child_process");

  try {
    console.log("Building site with 11ty...");
    execSync("npx @11ty/eleventy", { stdio: "inherit" });
    console.log("Successfully built site to _site/");

    if (push) {
      throw new Error("Push functionality not yet implemented");
    }
  } catch (error) {
    console.error("Error in build/push process:", error.message);
    throw error;
  }
}

main();
