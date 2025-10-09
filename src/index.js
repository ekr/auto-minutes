/**
 * Auto-Minutes Main Entry Point
 * Orchestrates the process of generating meeting minutes from IETF transcripts
 */

import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { fetchMeetingSessions, downloadTranscript } from './scraper.js';
import { initializeClaude, generateMinutes } from './generator.js';
import { saveMinutes, generateIndex } from './publisher.js';

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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY not found in environment');
    console.error('Please create a .env file with your API key');
    process.exit(1);
  }

  console.log(`Processing IETF ${meetingNumber} meeting transcripts...`);

  // Initialize Claude
  initializeClaude(apiKey);

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
      console.log(`\nProcessing session group: ${sessionName} (${sessionGroup.length} session(s))`);

      // Process all sessions in the group and concatenate
      const allMinutes = [];
      for (const session of sessionGroup) {
        console.log(`  Processing ${session.sessionName} [${session.sessionId}]...`);

        // Download transcript
        const transcript = await downloadTranscript(session);

        // Generate minutes
        const minutes = await generateMinutes(transcript, session.sessionName);

        // Add session ID header and minutes
        allMinutes.push(`<!-- Session ID: ${session.sessionId} -->\n\n${minutes}`);

        console.log(`  Completed ${session.sessionName} [${session.sessionId}]`);
      }

      // Concatenate all minutes for this session name
      const combinedMinutes = allMinutes.join('\n\n---\n\n');

      // Save to file
      await saveMinutes(sessionName, combinedMinutes);

      processedSessions.push(sessionName);
      console.log(`Saved combined minutes for: ${sessionName}`);
    }

    // Step 3: Generate index page
    console.log('Generating index...');
    await generateIndex(processedSessions);

    console.log('All done!');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
