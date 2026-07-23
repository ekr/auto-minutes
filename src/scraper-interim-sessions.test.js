/**
 * Tests for interim session discovery handling meeting records that host
 * more than one Meetecho session (e.g. a morning and afternoon slot under
 * one `interim-*` slug).
 *
 * Kept in a separate file (rather than scraper.test.js) because these tests
 * mock 'node-fetch', while scraper.test.js intentionally makes live network
 * calls against the real IETF datatracker/Meetecho endpoints.
 */

import { jest } from '@jest/globals';

const mockFetch = jest.fn();

jest.unstable_mockModule('node-fetch', () => ({
  default: mockFetch,
}));

const {
  fetchInterimSession,
  fetchAllInterimSessions,
  fetchInterimSessionsInRange,
} = await import('./scraper.js');

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function htmlResponse(html) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => html,
  };
}

function meetechoLink(sessionId) {
  return `<a href="https://meetecho-player.ietf.org/playout/?session=${sessionId}">recording</a>`;
}

const meetingsPage = (meetings) => jsonResponse({ objects: meetings, meta: { next: null } });

describe('interim session discovery with multiple Meetecho links per meeting', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  test('fetchInterimSession returns one session per Meetecho link, in page order', async () => {
    mockFetch
      .mockResolvedValueOnce(meetingsPage([{ number: 'interim-2026-moq-08', date: '2026-06-11' }]))
      .mockResolvedValueOnce(htmlResponse(`
        <html><body>
          ${meetechoLink('IETF-MOQ-20260611-0830')}
          ${meetechoLink('IETF-MOQ-20260611-1230')}
        </body></html>
      `));

    const sessions = await fetchInterimSession('2026-06-11', 'moq');

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      sessionName: 'MOQ',
      sessionId: 'IETF-MOQ-20260611-0830',
      meetingSlug: 'interim-2026-moq-08',
    });
    expect(sessions[1]).toMatchObject({
      sessionName: 'MOQ',
      sessionId: 'IETF-MOQ-20260611-1230',
      meetingSlug: 'interim-2026-moq-08',
    });
  });

  test('fetchInterimSession behaves exactly as before for a single Meetecho link', async () => {
    mockFetch
      .mockResolvedValueOnce(meetingsPage([{ number: 'interim-2026-moq-09', date: '2026-06-12' }]))
      .mockResolvedValueOnce(htmlResponse(`<html><body>${meetechoLink('IETF-MOQ-20260612-0900')}</body></html>`));

    const sessions = await fetchInterimSession('2026-06-12', 'moq');

    expect(sessions).toEqual([{
      sessionName: 'MOQ',
      sessionId: 'IETF-MOQ-20260612-0900',
      recordingUrl: 'https://meetecho-player.ietf.org/playout/?session=IETF-MOQ-20260612-0900',
      meetingSlug: 'interim-2026-moq-09',
    }]);
  });

  test('fetchInterimSession dedupes repeated links to the same session ID', async () => {
    mockFetch
      .mockResolvedValueOnce(meetingsPage([{ number: 'interim-2026-moq-08', date: '2026-06-11' }]))
      .mockResolvedValueOnce(htmlResponse(`
        <html><body>
          ${meetechoLink('IETF-MOQ-20260611-0830')}
          ${meetechoLink('IETF-MOQ-20260611-0830')}
        </body></html>
      `));

    const sessions = await fetchInterimSession('2026-06-11', 'moq');

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('IETF-MOQ-20260611-0830');
  });

  test('fetchAllInterimSessions expands a single meeting slug into multiple sessions', async () => {
    mockFetch
      .mockResolvedValueOnce(meetingsPage([{ number: 'interim-2026-moq-08', date: '2026-06-11' }]))
      .mockResolvedValueOnce(htmlResponse(`
        <html><body>
          ${meetechoLink('IETF-MOQ-20260611-0830')}
          ${meetechoLink('IETF-MOQ-20260611-1230')}
        </body></html>
      `));

    const sessions = await fetchAllInterimSessions('2026-06-11');

    expect(sessions.map(s => s.sessionId)).toEqual([
      'IETF-MOQ-20260611-0830',
      'IETF-MOQ-20260611-1230',
    ]);
    expect(sessions.every(s => s.sessionName === 'MOQ' && s.meetingSlug === 'interim-2026-moq-08')).toBe(true);
  });

  test('fetchInterimSessionsInRange expands a single meeting slug into multiple sessions for its date', async () => {
    mockFetch
      .mockResolvedValueOnce(meetingsPage([{ number: 'interim-2026-moq-08', date: '2026-06-11' }]))
      .mockResolvedValueOnce(htmlResponse(`
        <html><body>
          ${meetechoLink('IETF-MOQ-20260611-0830')}
          ${meetechoLink('IETF-MOQ-20260611-1230')}
        </body></html>
      `));

    const result = await fetchInterimSessionsInRange('2026-06-11', '2026-06-11');

    expect(result.has('2026-06-11')).toBe(true);
    const sessions = result.get('2026-06-11');
    expect(sessions.map(s => s.sessionId)).toEqual([
      'IETF-MOQ-20260611-0830',
      'IETF-MOQ-20260611-1230',
    ]);
  });
});
