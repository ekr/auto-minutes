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
    .example("$0 --push", "Publish and push to GitHub Pages")
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
    .option("publish", {
      alias: "p",
      type: "boolean",
      description: "Publish to GitHub Pages (clone, copy, commit)",
    })
    .option("push", {
      alias: "P",
      type: "boolean",
      description: "Publish and push to GitHub Pages",
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
      if (!argv.summarize && !argv.output && !argv.publish && !argv.push) {
        throw new Error(
          "Must specify at least one action: --summarize, --output, --publish, or --push",
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
  const doPublish = argv.publish || argv.push;
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

        const processedSessionIds = [];
        for (const session of sessionGroup) {
          console.log(
            `  Processing ${session.sessionName} [${session.sessionId}]...`,
          );

          // Generate minutes (uses cache if available, otherwise downloads and generates)
          const minutes = await generateSessionMinutes(meetingNumber, session);

          // Skip if no minutes were generated (transcript unavailable)
          if (!minutes) {
            console.log(`  Skipping ${session.sessionName} [${session.sessionId}] - no transcript`);
            continue;
          }

          processedSessionIds.push(session.sessionId);
          console.log(
            `  Completed ${session.sessionName} [${session.sessionId}]`,
          );
        }

        // Only add to manifest if at least one session was processed
        if (processedSessionIds.length > 0) {
          sessionGroups.push({
            sessionName,
            sessionIds: processedSessionIds,
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
      console.log(`Found ${cachedMeetings.length} cached meetings: ${cachedMeetings.join(', ')}`);

      for (const meetingNum of cachedMeetings) {
        console.log(`\n--- Processing IETF ${meetingNum} ---`);
        const outputDir = `output/ietf${meetingNum}`;

        console.log("Loading cache manifest...");
        const sessionGroups = await loadCacheManifest(meetingNum);
        console.log(`Found ${sessionGroups.length} session groups`);

        const processedSessions = [];
        for (const group of sessionGroups) {
          console.log(`\nGenerating output for: ${group.sessionName}`);

          const allMinutes = [];
          for (const sessionId of group.sessionIds) {
            const minutes = await getCachedMinutes(meetingNum, sessionId);
            const { dateTimeHeader } = parseSessionId(sessionId);
            allMinutes.push(`${dateTimeHeader}${minutes}`);
          }

          // Concatenate all minutes for this session name
          const combinedMinutes = allMinutes.join("\n\n---\n\n");

          // Save to output
          await saveMinutes(group.sessionName, combinedMinutes, outputDir);
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
      await generateRootIndex("output", "output/index.md");
      console.log("Root index generated at output/index.md");
    }

    console.log("\nAll done!");

    // Step 5: Publish to GitHub Pages if requested
    if (doPublish) {
      console.log("\nPublishing to GitHub Pages...");
      await publishToGitHub(!doPush);
    }
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

/**
 * Publish meeting minutes to GitHub Pages
 * @param {boolean} noPush - Skip the git push step
 */
async function publishToGitHub(noPush = false) {
  const { execSync } = await import("child_process");
  const fs = await import("fs/promises");
  const path = await import("path");

  const repoUrl = "git@github.com:ekr/auto-minutes.git";
  const ghPagesDir = "gh-pages-repo";
  const docsDir = path.join(ghPagesDir, "docs");

  try {
    // Step 1: Remove existing gh-pages repo if it exists
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

    // Step 2.5: Reset to baseline tag
    console.log("Resetting to baseline tag...");
    process.chdir(ghPagesDir);
    execSync("git reset --hard baseline", { stdio: "inherit" });
    process.chdir("..");

    // Step 3: Copy files from ALL meeting directories based on their manifests
    console.log("Copying meeting files based on manifests...");

    // Get all meeting directories from output/
    const outputBase = "output";
    const meetings = await fs.readdir(outputBase, { withFileTypes: true });
    const meetingDirs = meetings
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("ietf"))
      .map((entry) => entry.name);

    for (const meetingDirName of meetingDirs) {
      const sourcePath = path.join(outputBase, meetingDirName);
      const destPath = path.join(docsDir, meetingDirName);
      const manifestPath = path.join(sourcePath, ".manifest.json");

      // Check if manifest exists
      let filesToCopy;
      try {
        const manifestContent = await fs.readFile(manifestPath, "utf-8");
        const manifest = JSON.parse(manifestContent);
        filesToCopy = manifest.files;
        console.log(
          `  ${meetingDirName}: copying ${filesToCopy.length} files from manifest`,
        );
      } catch (error) {
        console.warn(`  ${meetingDirName}: no manifest found, skipping`);
        continue;
      }

      // Ensure destination directory exists
      await fs.mkdir(destPath, { recursive: true });

      // Copy each file from the manifest
      for (const file of filesToCopy) {
        const sourceFile = path.join(sourcePath, file);
        const destFile = path.join(destPath, file);

        try {
          await fs.copyFile(sourceFile, destFile);
        } catch (error) {
          console.warn(`    Warning: could not copy ${file}: ${error.message}`);
        }
      }
    }

    // Step 4: Generate root index.md
    console.log("Generating root index.md...");
    const rootIndexPath = path.resolve(ghPagesDir, "docs", "index.md");
    await generateRootIndex("output", rootIndexPath);

    // Step 4.5: Copy Jekyll config, logo, and layouts
    console.log("Copying Jekyll config, logo, and layouts...");
    const configTemplatePath = path.resolve("templates", "_config.yml");
    const configDestPath = path.resolve(ghPagesDir, "docs", "_config.yml");
    await fs.copyFile(configTemplatePath, configDestPath);

    const logoTemplatePath = path.resolve("templates", "logo.jpg");
    const logoDestPath = path.resolve(ghPagesDir, "docs", "logo.jpg");
    try {
      await fs.copyFile(logoTemplatePath, logoDestPath);
    } catch (error) {
      console.warn("Warning: Could not copy logo.jpg:", error.message);
    }

    // Copy layout directory
    const layoutsSrcDir = path.resolve("templates", "_layouts");
    const layoutsDestDir = path.resolve(ghPagesDir, "docs", "_layouts");
    try {
      await fs.mkdir(layoutsDestDir, { recursive: true });
      const layoutFiles = await fs.readdir(layoutsSrcDir);
      for (const layoutFile of layoutFiles) {
        await fs.copyFile(
          path.join(layoutsSrcDir, layoutFile),
          path.join(layoutsDestDir, layoutFile),
        );
      }
    } catch (error) {
      console.warn("Warning: Could not copy layouts:", error.message);
    }

    // Step 5: Commit changes
    console.log("Committing changes...");
    process.chdir(ghPagesDir);

    // Git add all files from all meeting directories
    for (const meetingDirName of meetingDirs) {
      const manifestPath = path.join(
        "..",
        outputBase,
        meetingDirName,
        ".manifest.json",
      );

      try {
        const manifestContent = await fs.readFile(manifestPath, "utf-8");
        const manifest = JSON.parse(manifestContent);

        for (const file of manifest.files) {
          const gitPath = path.join("docs", meetingDirName, file);
          execSync(`git add "${gitPath}"`, { stdio: "inherit" });
        }
      } catch (error) {
        // Skip if no manifest
      }
    }

    // Add root index.md, Jekyll config, logo, and layouts
    console.log(
      "Adding docs/index.md, docs/_config.yml, docs/logo.jpg, and docs/_layouts/ to git...",
    );
    execSync("git add docs/index.md", { stdio: "inherit" });
    execSync("git add docs/_config.yml", { stdio: "inherit" });
    try {
      execSync("git add docs/logo.jpg", { stdio: "inherit" });
    } catch (error) {
      // Logo might not exist, that's okay
    }
    try {
      execSync("git add docs/_layouts/", { stdio: "inherit" });
    } catch (error) {
      // Layouts might not exist, that's okay
    }

    execSync(`git commit -m "Update meeting minutes"`, {
      stdio: "inherit",
    });

    // Step 4: Push to GitHub (unless noPush is set)
    if (noPush) {
      console.log("Skipping git push (--no-push flag set)");
      console.log(`Repository left in: ${ghPagesDir}`);
    } else {
      console.log("Pushing to GitHub...");
      execSync("git push origin gh-pages", { stdio: "inherit" });

      // Return to original directory
      process.chdir("..");

      // Clean up
      console.log("Cleaning up...");
      await fs.rm(ghPagesDir, { recursive: true, force: true });

      console.log("Successfully published to GitHub Pages!");
    }
  } catch (error) {
    console.error("Error publishing to GitHub:", error.message);
    // Try to clean up even on error
    try {
      process.chdir("..");
      await fs.rm(ghPagesDir, { recursive: true, force: true });
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
    throw error;
  }
}

main();
