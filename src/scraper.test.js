/**
 * Tests for IETF scraper
 */

import { fetchMeetingSessions, downloadTranscript } from './scraper.js';

describe('IETF Scraper', () => {
  // Use meeting 123 (local file available)
  const MEETING_NUMBER = 123;

  test('fetchMeetingSessions returns array of sessions', async () => {
    const sessions = await fetchMeetingSessions(MEETING_NUMBER);

    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBeGreaterThan(0);

    // Check structure of first session
    const firstSession = sessions[0];
    expect(firstSession).toHaveProperty('sessionName');
    expect(firstSession).toHaveProperty('sessionId');
    expect(typeof firstSession.sessionName).toBe('string');
    expect(typeof firstSession.sessionId).toBe('string');

    console.log(`Found ${sessions.length} sessions`);
    console.log(`First session: ${firstSession.sessionName} (${firstSession.sessionId})`);
  }, 30000); // 30 second timeout for network request

  test('downloadTranscript fetches actual transcript content', async () => {
    // First get a session to have a real session object
    const sessions = await fetchMeetingSessions(MEETING_NUMBER);
    expect(sessions.length).toBeGreaterThan(0);

    const firstSession = sessions[0];
    console.log(`Testing download for: ${firstSession.sessionName}`);
    console.log(`Session ID: ${firstSession.sessionId}`);

    const transcript = await downloadTranscript(firstSession);

    expect(typeof transcript).toBe('string');
    expect(transcript.length).toBeGreaterThan(0);

    console.log(`Downloaded transcript length: ${transcript.length} characters`);
    console.log(`First 200 characters: ${transcript.substring(0, 200)}`);
  }, 30000); // 30 second timeout for network request
});
