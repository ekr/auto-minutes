/**
 * Auto-Minutes Main Entry Point
 * Orchestrates the process of generating meeting minutes from IETF transcripts
 */

import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { fetchMeetingSessions, downloadTranscript } from './scraper.js';
import { initializeClaude, generateMinutes } from './generator.js';
import { saveMinutes, generateIndex, minutesExist, generateRootIndex } from './publisher.js';

// Load environment variables
dotenv.config();

/**
 * Process a single session: download transcript, generate minutes, and save
 * @param {Object} session - Session object with sessionName and sessionId
 * @returns {Promise<string>} The session name
 */
async function processSession(session) {
  console.log(`Processing ${session.sessionName}...`);

  // Download transcript
  const transcript = await downloadTranscript(session);

  // Generate minutes
  const minutes = await generateMinutes(transcript, session.sessionName);

  // Save to file
  await saveMinutes(session.sessionName, minutes);

  console.log(`Completed ${session.sessionName}`);
  return session.sessionName;
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .usage('Usage: $0 [options] <meeting-number>')
    .example('$0 118', 'Process IETF meeting 118')
    .example('$0 -v 118', 'Process with verbose output')
    .example('$0 -s "TLS" 118', 'Process only TLS sessions from meeting 118')
    .example('$0 -p 118', 'Process and publish to GitHub Pages')
    .option('verbose', {
      alias: 'v',
      type: 'boolean',
      description: 'Run with verbose output'
    })
    .option('session', {
      alias: 's',
      type: 'string',
      description: 'Process only sessions matching this name (case-insensitive partial match)'
    })
    .option('publish', {
      alias: 'p',
      type: 'boolean',
      description: 'Publish to GitHub Pages (gh-pages branch)'
    })
    .option('no-push', {
      alias: 'n',
      type: 'boolean',
      description: 'Skip git push (only clone, copy, and commit)'
    })
    .option('model', {
      alias: 'm',
      type: 'string',
      choices: ['claude', 'gemini'],
      default: 'claude',
      description: 'LLM model to use for generating minutes'
    })
    .demandCommand(1, 'Please provide a meeting number')
    .help()
    .alias('help', 'h')
    .parse();

  const meetingNumber = parseInt(argv._[0], 10);

  if (isNaN(meetingNumber)) {
    console.error('Error: Meeting number must be a valid integer');
    process.exit(1);
  }

  const verbose = argv.verbose;
  const sessionFilter = argv.session;
  const publish = argv.publish;
  const noPush = argv.noPush;
  const model = argv.model;

  // Check for appropriate API key based on model
  if (model === 'claude') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('Error: ANTHROPIC_API_KEY not found in environment');
      console.error('Please create a .env file with your API key');
      process.exit(1);
    }
    initializeClaude(apiKey);
  } else if (model === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('Error: GEMINI_API_KEY not found in environment');
      console.error('Please create a .env file with your API key');
      process.exit(1);
    }
    const { initializeGemini } = await import('./generator.js');
    initializeGemini(apiKey);
  }

  console.log(`Processing IETF ${meetingNumber} meeting transcripts using ${model}...`);

  // Set up output directory for this meeting
  const outputDir = `output/ietf${meetingNumber}`;

  try {
    // Step 1: Fetch all sessions for the meeting
    console.log('Fetching session list...');
    const sessions = await fetchMeetingSessions(meetingNumber);
    console.log(`Found ${sessions.length} sessions`);

    if (verbose) {
      console.log('\n=== Session List Structure (JSON) ===');
      console.log(JSON.stringify(sessions, null, 2));
      console.log('=== End Session List ===\n');
    }

    // Filter sessions if session name filter is provided
    let sessionsToProcess = sessions;
    if (sessionFilter) {
      const filterLower = sessionFilter.toLowerCase();
      sessionsToProcess = sessions.filter(s =>
        s.sessionName.toLowerCase().includes(filterLower)
      );
      console.log(`Filtered to ${sessionsToProcess.length} sessions matching "${sessionFilter}"`);

      if (sessionsToProcess.length === 0) {
        console.error(`No sessions found matching "${sessionFilter}"`);
        process.exit(1);
      }
    }

    // Step 2: Group sessions by name (multiple sessions can have the same name)
    const sessionsByName = new Map();
    for (const session of sessionsToProcess) {
      if (!sessionsByName.has(session.sessionName)) {
        sessionsByName.set(session.sessionName, []);
      }
      sessionsByName.get(session.sessionName).push(session);
    }

    // Step 3: Process each session group
    const processedSessions = [];
    for (const [sessionName, sessionGroup] of sessionsByName) {
      // Check if minutes already exist for this session
      const exists = await minutesExist(sessionName, outputDir);
      if (exists) {
        console.log(`\nSkipping ${sessionName} - minutes already exist`);
        processedSessions.push(sessionName);
        continue;
      }

      console.log(`\nProcessing session group: ${sessionName} (${sessionGroup.length} session(s))`);

      // Process all sessions in the group and concatenate
      const allMinutes = [];
      for (const session of sessionGroup) {
        console.log(`  Processing ${session.sessionName} [${session.sessionId}]...`);

        // Download transcript
        let transcript;
        try {
          transcript = await downloadTranscript(session);
        } catch (error) {
          console.log(`  Skipping ${session.sessionName} [${session.sessionId}] - could not fetch transcript: ${error.message}`);
          continue;
        }

        // Generate minutes
        const minutes = await generateMinutes(transcript, session.sessionName);

        // Parse date/time from session ID (format: IETFXXX-SESSIONNAME-YYYYMMDD-HHMM)
        const sessionIdParts = session.sessionId.split('-');
        const dateStr = sessionIdParts[sessionIdParts.length - 2]; // YYYYMMDD
        const timeStr = sessionIdParts[sessionIdParts.length - 1]; // HHMM

        let dateTimeHeader = '';
        if (dateStr && timeStr && dateStr.length === 8 && timeStr.length === 4) {
          const year = dateStr.substring(0, 4);
          const month = dateStr.substring(4, 6);
          const day = dateStr.substring(6, 8);
          const hour = timeStr.substring(0, 2);
          const minute = timeStr.substring(2, 4);

          // Format as a readable date/time without timezone (it's local time)
          const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                              'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          const monthName = monthNames[parseInt(month, 10) - 1];
          const formattedDateTime = `${day} ${monthName} ${year} ${hour}:${minute}`;

          dateTimeHeader = `**Session Date/Time:** ${formattedDateTime}\n\n`;
        }

        // Add date/time header and minutes
        allMinutes.push(`${dateTimeHeader}${minutes}`);

        console.log(`  Completed ${session.sessionName} [${session.sessionId}]`);
      }

      // Skip if no transcripts were successfully processed
      if (allMinutes.length === 0) {
        console.log(`Skipping ${sessionName} - no transcripts could be fetched`);
        continue;
      }

      // Concatenate all minutes for this session name
      const combinedMinutes = allMinutes.join('\n\n---\n\n');

      // Save to file
      await saveMinutes(sessionName, combinedMinutes, outputDir);

      processedSessions.push(sessionName);
      console.log(`Saved combined minutes for: ${sessionName}`);
    }

    // Step 4: Generate index page
    console.log('Generating index...');
    await generateIndex(processedSessions, outputDir);

    console.log('All done!');

    // Step 5: Publish to GitHub Pages if requested
    if (publish) {
      console.log('\nPublishing to GitHub Pages...');
      await publishToGitHub(meetingNumber, outputDir, noPush);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

/**
 * Publish meeting minutes to GitHub Pages
 * @param {number} meetingNumber - IETF meeting number
 * @param {string} outputDir - Directory containing the minutes
 * @param {boolean} noPush - Skip the git push step
 */
async function publishToGitHub(meetingNumber, outputDir, noPush = false) {
  const { execSync } = await import('child_process');
  const fs = await import('fs/promises');
  const path = await import('path');

  const repoUrl = 'git@github.com:ekr/auto-minutes.git';
  const ghPagesDir = 'gh-pages-repo';
  const docsDir = path.join(ghPagesDir, 'docs');
  const meetingDir = `ietf${meetingNumber}`;

  try {
    // Step 1: Remove existing gh-pages repo if it exists
    try {
      await fs.rm(ghPagesDir, { recursive: true, force: true });
      console.log('Removed existing gh-pages-repo directory');
    } catch (err) {
      // Directory doesn't exist, that's fine
    }

    // Step 2: Clone the gh-pages branch
    console.log('Cloning gh-pages branch...');
    execSync(`git clone -b gh-pages --single-branch ${repoUrl} ${ghPagesDir}`, {
      stdio: 'inherit'
    });

    // Step 2.5: Reset to baseline tag
    console.log('Resetting to baseline tag...');
    process.chdir(ghPagesDir);
    execSync('git reset --hard baseline', { stdio: 'inherit' });
    process.chdir('..');

    // Step 3: Copy the meeting directory files
    console.log(`Copying ${outputDir} to gh-pages/docs...`);
    const sourcePath = path.resolve(outputDir);
    const destPath = path.join(docsDir, meetingDir);

    // Ensure destination directory exists
    await fs.mkdir(destPath, { recursive: true });

    // Read all files from the source directory
    const files = await fs.readdir(sourcePath);

    // Copy each file individually
    for (const file of files) {
      const sourceFile = path.join(sourcePath, file);
      const destFile = path.join(destPath, file);

      console.log(`  Copying ${file}...`);
      await fs.copyFile(sourceFile, destFile);
    }

    // Step 4: Generate root index.md
    console.log('Generating root index.md...');
    const rootIndexPath = path.resolve(ghPagesDir, 'docs', 'index.md');
    await generateRootIndex('output', rootIndexPath);

    // Step 5: Commit changes
    console.log('Committing changes...');
    process.chdir(ghPagesDir);

    // Git add each file individually (both .md and .txt versions)
    for (const file of files) {
      const gitPath = path.join('docs', meetingDir, file);
      console.log(`  Adding ${gitPath} to git...`);
      execSync(`git add "${gitPath}"`, { stdio: 'inherit' });
    }

    // Add root index.md
    console.log('  Adding docs/index.md to git...');
    execSync('git add docs/index.md', { stdio: 'inherit' });

    execSync(`git commit -m "Update minutes for IETF ${meetingNumber}"`, {
      stdio: 'inherit'
    });

    // Step 4: Push to GitHub (unless noPush is set)
    if (noPush) {
      console.log('Skipping git push (--no-push flag set)');
      console.log(`Repository left in: ${ghPagesDir}`);
    } else {
      console.log('Pushing to GitHub...');
      execSync('git push origin gh-pages', { stdio: 'inherit' });

      // Return to original directory
      process.chdir('..');

      // Clean up
      console.log('Cleaning up...');
      await fs.rm(ghPagesDir, { recursive: true, force: true });

      console.log('Successfully published to GitHub Pages!');
    }
  } catch (error) {
    console.error('Error publishing to GitHub:', error.message);
    // Try to clean up even on error
    try {
      process.chdir('..');
      await fs.rm(ghPagesDir, { recursive: true, force: true });
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
    throw error;
  }
}

main();
