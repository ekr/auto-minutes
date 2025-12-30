/**
 * Tests for IETF scraper
 */

import { fetchSessionsFromProceedings, fetchSessionsFromAgenda, downloadTranscript, isValidSessionId, fetchSessionsWithValidation, fetchValidSessions } from './scraper.js';

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

describe('Session ID Validation', () => {
  test('isValidSessionId accepts valid session IDs', () => {
    expect(isValidSessionId('IETF123-6LO-20250723-0730')).toBe(true);
    expect(isValidSessionId('IETF112-AVTCORE-20211112-1200')).toBe(true);
    expect(isValidSessionId('IETF999-RTG-AREA-20250101-1200')).toBe(true);
    expect(isValidSessionId('IETF1-TEST-12345678-1234')).toBe(true);
  });

  test('isValidSessionId rejects invalid session IDs', () => {
    expect(isValidSessionId('invalid-format')).toBe(false);
    expect(isValidSessionId('IETF123-TEST-20250723')).toBe(false); // Missing time
    expect(isValidSessionId('IETF123-TEST-2025-0730')).toBe(false); // Wrong date format
    expect(isValidSessionId('123-TEST-20250723-0730')).toBe(false); // Missing IETF prefix
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId(null)).toBe(false);
    expect(isValidSessionId(undefined)).toBe(false);
    expect(isValidSessionId(123)).toBe(false);
  });

  test('fetchSessionsWithValidation returns validation stats', async () => {
    const MEETING_NUMBER = 123;
    const result = await fetchSessionsWithValidation(fetchSessionsFromProceedings, MEETING_NUMBER);

    expect(result).toHaveProperty('validSessions');
    expect(result).toHaveProperty('invalidSessions');
    expect(result).toHaveProperty('stats');
    expect(Array.isArray(result.validSessions)).toBe(true);
    expect(Array.isArray(result.invalidSessions)).toBe(true);
    expect(result.stats.total).toBe(result.stats.valid + result.stats.invalid);

    // All returned sessions should have valid IDs
    for (const session of result.validSessions) {
      expect(isValidSessionId(session.sessionId)).toBe(true);
    }

    // All invalid sessions should have invalid IDs
    for (const session of result.invalidSessions) {
      expect(isValidSessionId(session.sessionId)).toBe(false);
    }

    console.log(`Validation stats: ${result.stats.total} total, ${result.stats.valid} valid, ${result.stats.invalid} invalid (${result.stats.validationRate})`);
  }, 30000);

  test('fetchSessionsWithValidation works with both fetch functions', async () => {
    const MEETING_NUMBER = 123;

    // Test with proceedings
    const proceedingsResult = await fetchSessionsWithValidation(
      fetchSessionsFromProceedings,
      MEETING_NUMBER
    );
    expect(proceedingsResult.validSessions.length).toBeGreaterThan(0);

    // Test with agenda
    const agendaResult = await fetchSessionsWithValidation(
      fetchSessionsFromAgenda,
      MEETING_NUMBER
    );
    expect(agendaResult.validSessions.length).toBeGreaterThan(0);

    console.log(`Proceedings: ${proceedingsResult.stats.valid} valid sessions`);
    console.log(`Agenda: ${agendaResult.stats.valid} valid sessions`);
  }, 30000);

  test('fetchValidSessions returns only valid sessions', async () => {
    const MEETING_NUMBER = 123;
    const validSessions = await fetchValidSessions(fetchSessionsFromProceedings, MEETING_NUMBER);

    expect(Array.isArray(validSessions)).toBe(true);
    expect(validSessions.length).toBeGreaterThan(0);

    // All returned sessions should have valid IDs
    for (const session of validSessions) {
      expect(isValidSessionId(session.sessionId)).toBe(true);
    }

    console.log(`fetchValidSessions returned ${validSessions.length} valid sessions`);
  }, 30000);
});
