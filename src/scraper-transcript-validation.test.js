/**
 * Tests for downloadTranscript's rejection of not-yet-available transcripts.
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

const { downloadTranscript } = await import('./scraper.js');

function makeResponse({ ok = true, status = 200, statusText = 'OK', contentType = 'application/json', body = '' } = {}) {
  return {
    ok,
    status,
    statusText,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}

describe('downloadTranscript', () => {
  const session = { sessionId: 'IETF126-DISPATCH-20260720-0700' };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  test('rejects a 200 response with an empty JSON array (transcript not yet generated)', async () => {
    mockFetch.mockResolvedValue(makeResponse({ body: '[]' }));
    await expect(downloadTranscript(session)).rejects.toThrow(/no entries/);
  });

  test('rejects a 200 response containing an HTML page instead of a transcript', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ contentType: 'text/html', body: '<html><body>Not found</body></html>' }),
    );
    await expect(downloadTranscript(session)).rejects.toThrow(/HTML/);
  });

  test('rejects an HTML body even when reported with a JSON content-type', async () => {
    mockFetch.mockResolvedValue(makeResponse({ body: '<!DOCTYPE html><html></html>' }));
    await expect(downloadTranscript(session)).rejects.toThrow(/HTML/);
  });

  test('rejects a JSON array whose entries all have empty text', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ body: JSON.stringify([{ startTime: '00:00:00', text: '' }]) }),
    );
    await expect(downloadTranscript(session)).rejects.toThrow(/empty/);
  });

  test('accepts a valid transcript with real content', async () => {
    const body = JSON.stringify([{ startTime: '00:00:00', text: 'hello world, welcome to the meeting' }]);
    mockFetch.mockResolvedValue(makeResponse({ body }));
    const result = await downloadTranscript(session);
    expect(result).toBe(body);
  });
});
