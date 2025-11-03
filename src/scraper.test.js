/**
 * Tests for IETF scraper
 */

import { fetchSessionsFromProceedings, fetchSessionsFromAgenda, downloadTranscript } from './scraper.js';

describe('IETF Scraper', () => {
  // Use meeting 123 (local file available)
  const MEETING_NUMBER = 123;

  test('fetchSessionsFromProceedings returns array of sessions', async () => {
    const sessions = await fetchSessionsFromProceedings(MEETING_NUMBER);

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
    const sessions = await fetchSessionsFromProceedings(MEETING_NUMBER);
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

describe('Meetecho Scraper', () => {
  const MEETING_NUMBER = 123;

  test('fetchSessionsFromAgenda returns array of sessions', async () => {
    const sessions = await fetchSessionsFromAgenda(MEETING_NUMBER);

    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBeGreaterThan(0);

    // Check structure of first session
    const firstSession = sessions[0];
    expect(firstSession).toHaveProperty('sessionName');
    expect(firstSession).toHaveProperty('sessionId');
    expect(firstSession).toHaveProperty('recordingUrl');
    expect(firstSession).toHaveProperty('dateTime');
    expect(typeof firstSession.sessionName).toBe('string');
    expect(typeof firstSession.sessionId).toBe('string');
    expect(typeof firstSession.recordingUrl).toBe('string');
    expect(typeof firstSession.dateTime).toBe('string');

    // Verify recording URL format
    expect(firstSession.recordingUrl).toMatch(/^https:\/\/meetecho-player\.ietf\.org\/playout\/\?session=/);

    // Verify sessionId format (should be IETF123-...)
    expect(firstSession.sessionId).toMatch(/^IETF\d+-/);

    console.log(`Found ${sessions.length} sessions from Meetecho`);
    console.log(`First session: ${firstSession.sessionName} (${firstSession.sessionId})`);
    console.log(`Date/Time: ${firstSession.dateTime}`);
  }, 30000); // 30 second timeout for network request

  test('fetchSessionsFromAgenda sessions are compatible with downloadTranscript', async () => {
    const sessions = await fetchSessionsFromAgenda(MEETING_NUMBER);
    expect(sessions.length).toBeGreaterThan(0);

    const firstSession = sessions[0];
    console.log(`Testing download for: ${firstSession.sessionName}`);
    console.log(`Session ID: ${firstSession.sessionId}`);

    // This should work since both functions use the same session object structure
    const transcript = await downloadTranscript(firstSession);

    expect(typeof transcript).toBe('string');
    expect(transcript.length).toBeGreaterThan(0);

    console.log(`Downloaded transcript length: ${transcript.length} characters`);
    console.log(`First 200 characters: ${transcript.substring(0, 200)}`);
  }, 30000); // 30 second timeout for network request
});
