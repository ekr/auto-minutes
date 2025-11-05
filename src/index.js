/**
 * Auto-Minutes Main Entry Point
 * Orchestrates the process of generating meeting minutes from IETF transcripts
 */

import dotenv from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { fetchSessionsFromProceedings, fetchSessionsFromAgenda, downloadTranscript } from "./scraper.js";
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

// Global verbose flag
let verbose = false;

/**
 * Generate minutes for a session (checks cache first, otherwise downloads and generates)
 * @param {number} meetingNumber - IETF meeting number
 * @param {Object} session - Session object with sessionName and sessionId
 * @returns {Promise<Object>} Object with {minutes: string, wasGenerated: boolean}
 */
async function generateSessionMinutes(meetingNumber, session) {
  // Check cache first
  if (await cacheExists(meetingNumber, session.sessionId)) {
    console.log(`  Loading from cache: ${session.sessionId}`);
    const minutes = await getCachedMinutes(meetingNumber, session.sessionId);
    return { minutes, wasGenerated: false };
  }

  // Download transcript
  console.log(`  Downloading transcript: ${session.sessionId}`);
  let transcript;
  try {
    transcript = await downloadTranscript(session);
  } catch (error) {
    console.log(`  Could not fetch transcript: ${error.message}`);
    return { minutes: "", wasGenerated: false }; // Return empty minutes if transcript unavailable
  }

  // Generate minutes using LLM
  console.log(`  Generating minutes with LLM: ${session.sessionId}`);
  const minutes = await generateMinutes(transcript, session.sessionName, verbose);

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

async function main() {
  const argv = yargs(hideBin(process.argv))
    .usage("Usage: $0 [options]")
    .example("$0 --summarize 123", "Generate LLM summaries for IETF 123")
    .example("$0 --summarize 123 --source agenda", "Fetch sessions from Meetecho agenda")
    .example("$0 --output", "Generate output markdown files from cache")
    .example("$0 --summarize 123 --output", "Generate summaries and output")
    .example("$0 --build", "Build site with 11ty (outputs to _site/)")
    .example("$0 --output --build", "Generate output and build site")
    .example("$0 --pages", "Build and prepare GitHub Pages")
    .example("$0 --preview 123:6LO", "Preview minutes for IETF 123 6LO session")
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
    .option("pages", {
      alias: "p",
      type: "boolean",
      description: "Build and prepare GitHub Pages (gh-pages branch)",
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
    .option("source", {
      type: "string",
      choices: ["proceedings", "agenda"],
      default: "proceedings",
      description: "Source to fetch sessions from (proceedings or agenda)",
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

  const meetingNumber = argv.summarize;
  verbose = argv.verbose;
  const doSummarize = !!argv.summarize;
  const doOutput = argv.output;
  const doBuild = argv.build || argv.pages;
  const doPages = argv.pages;
  const doPreview = argv.preview;
  const model = argv.model;
  const source = argv.source;

  // Check for appropriate API key based on model (only needed for summarize or preview)
  if (doSummarize || doPreview) {
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
    // PREVIEW MODE: Generate and print minutes for a specific session
    if (doPreview) {
      console.log("\n=== PREVIEW MODE ===");
      console.log(`Using ${model} model...`);

      // Parse the meeting:session-name format
      const parts = doPreview.split(":");
      if (parts.length !== 2) {
        throw new Error(
          "Invalid --preview format. Use: --preview meeting:session-name (e.g., --preview 123:6LO)",
        );
      }

      const previewMeetingNumber = parseInt(parts[0], 10);
      const previewSessionName = parts[1];

      if (isNaN(previewMeetingNumber)) {
        throw new Error(`Invalid meeting number: ${parts[0]}`);
      }

      console.log(
        `Previewing: IETF ${previewMeetingNumber}, Session: ${previewSessionName}`,
      );

      // Fetch all sessions for the meeting
      const fetchFunction =
        source === "agenda" ? fetchSessionsFromAgenda : fetchSessionsFromProceedings;
      console.log(`Fetching session list from ${source}...`);
      const allSessions = await fetchFunction(previewMeetingNumber);
      console.log(`Found ${allSessions.length} total sessions`);

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

        // Download transcript (no cache)
        console.log("  Downloading transcript...");
        let transcript;
        try {
          transcript = await downloadTranscript(session);
        } catch (error) {
          console.error(`  Error downloading transcript: ${error.message}`);
          continue;
        }

        // Generate minutes using LLM (no cache)
        console.log("  Generating minutes with LLM...");
        const minutes = await generateMinutes(
          transcript,
          session.sessionName,
          verbose,
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
      console.log(`\n=== SUMMARIZE STAGE: IETF ${meetingNumber} ===`);
      console.log(`Using ${model} model...`);

      // Step 1: Fetch all sessions for the meeting
      const fetchFunction = source === "agenda" ? fetchSessionsFromAgenda : fetchSessionsFromProceedings;
      console.log(`Fetching session list from ${source}...`);
      const sessions = await fetchFunction(meetingNumber);
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
      let anyNewMinutes = false;
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
          const result = await generateSessionMinutes(meetingNumber, session);

          // Track if any new minutes were generated
          if (result.wasGenerated) {
            anyNewMinutes = true;
          }

          // Skip if no minutes were generated (transcript unavailable)
          if (!result.minutes) {
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

      // Save manifest to cache only if new minutes were generated
      if (anyNewMinutes) {
        console.log("\nSaving cache manifest...");
        await saveCacheManifest(meetingNumber, sessionGroups);
        console.log(`Cached ${sessionGroups.length} session groups`);
      } else {
        console.log("\nNo new minutes generated, skipping manifest update");
      }
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
