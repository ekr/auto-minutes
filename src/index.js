/**
 * Auto-Minutes Main Entry Point
 * Orchestrates the process of generating meeting minutes from IETF transcripts
 */

import dotenv from 'dotenv';
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
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: node src/index.js <meeting-number>');
    console.error('Example: node src/index.js 118');
    process.exit(1);
  }

  const meetingNumber = parseInt(args[0], 10);

  if (isNaN(meetingNumber)) {
    console.error('Error: Meeting number must be a valid integer');
    process.exit(1);
  }

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

    // Step 2: Process each session
    const processedSessions = [];
    for (const session of sessions) {
      const sessionName = await processSession(session);
      processedSessions.push(sessionName);
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
