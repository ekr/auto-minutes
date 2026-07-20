/**
 * Tests for downloadTranscript's rejection of not-yet-available transcripts.
 *
 * Kept in a separate file (rather than scraper.test.js) because these tests
 * mock 'node-fetch', while scraper.test.js intentionally makes live network
 * calls against the real IETF datatracker/Meetecho endpoints.
 */

import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockFetch = jest.fn();

jest.unstable_mockModule('node-fetch', () => ({
  default: mockFetch,
}));

const { downloadTranscript } = await import('./scraper.js');
const { prepareLocalTranscript, fetchCloudflareVideoId } = await import('./transcriber.js');
const { isRecordingUnavailable } = await import('./skip-classifier.js');

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

  // These feed downloadTranscript's *real* thrown error.message into
  // isRecordingUnavailable, rather than a hand-copied string literal. That
  // seam broke once already (commit 5272b9c introduced isRecordingUnavailable
  // without updating downloadTranscript's wrapping, so a normal --summarize
  // run with only unpublished recordings still exited 1; fixed in 50d257d).
  // Only a test that goes through downloadTranscript itself can catch a
  // future drift between its wrapping template and the classifier's regexes.
  describe('classification of downloadTranscript rejections', () => {
    async function rejectionMessage(promise) {
      try {
        await promise;
      } catch (error) {
        return error.message;
      }
      throw new Error('expected promise to reject');
    }

    test('an empty-JSON-array rejection classifies as recording-unavailable', async () => {
      mockFetch.mockResolvedValue(makeResponse({ body: '[]' }));
      const message = await rejectionMessage(downloadTranscript(session));
      expect(isRecordingUnavailable(message)).toBe(true);
    });

    test('an HTML-page rejection classifies as recording-unavailable', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({ contentType: 'text/html', body: '<html><body>Not found</body></html>' }),
      );
      const message = await rejectionMessage(downloadTranscript(session));
      expect(isRecordingUnavailable(message)).toBe(true);
    });

    test('an all-empty-entries rejection classifies as recording-unavailable', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({ body: JSON.stringify([{ startTime: '00:00:00', text: '' }]) }),
      );
      const message = await rejectionMessage(downloadTranscript(session));
      expect(isRecordingUnavailable(message)).toBe(true);
    });
  });
});

describe('fetchCloudflareVideoId classification', () => {
  // Same rationale as the downloadTranscript block above: fetchCloudflareVideoId's
  // "404" and "no Cloudflare video" messages are thrown unwrapped and propagate
  // straight to the catch site that calls isRecordingUnavailable(error.message).
  // Feeding its real thrown message in (rather than a hand-copied literal) catches
  // drift between the throw-site wording and the classifier's regexes.
  function makeJsonResponse({ ok = true, status = 200, statusText = 'OK', body } = {}) {
    return {
      ok,
      status,
      statusText,
      json: async () => body,
    };
  }

  async function rejectionMessage(promise) {
    try {
      await promise;
    } catch (error) {
      return error.message;
    }
    throw new Error('expected promise to reject');
  }

  beforeEach(() => {
    mockFetch.mockReset();
  });

  test('a 404 session-info response classifies as recording-unavailable', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse({ ok: false, status: 404, statusText: 'Not Found' }));
    const message = await rejectionMessage(fetchCloudflareVideoId('IETF126-DISPATCH-20260720-0700'));
    expect(isRecordingUnavailable(message)).toBe(true);
  });

  test('a videos list with no type-3 entry classifies as recording-unavailable', async () => {
    mockFetch.mockResolvedValue(
      makeJsonResponse({ body: { videos: [{ type: 1, src: 'a' }, { type: 2, src: 'b' }] } }),
    );
    const message = await rejectionMessage(fetchCloudflareVideoId('IETF126-DISPATCH-20260720-0700'));
    expect(isRecordingUnavailable(message)).toBe(true);
  });

  test('a 401 session-info response does NOT classify as recording-unavailable', async () => {
    mockFetch.mockResolvedValue(makeJsonResponse({ ok: false, status: 401, statusText: 'Unauthorized' }));
    const message = await rejectionMessage(fetchCloudflareVideoId('IETF126-DISPATCH-20260720-0700'));
    expect(isRecordingUnavailable(message)).toBe(false);
  });
});

describe('prepareLocalTranscript vs downloadTranscript classification', () => {
  test("prepareLocalTranscript's raw assertTranscriptPresent error does NOT classify as recording-unavailable", () => {
    // Unlike downloadTranscript, prepareLocalTranscript (the --transcript-file
    // path) does not wrap assertTranscriptPresent's error — an empty local
    // file is a genuine input error, not a benign "not published yet" no-op,
    // and must still fail the run.
    const tmpFile = path.join(os.tmpdir(), `auto-minutes-empty-transcript-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, '');
    try {
      let thrown;
      try {
        prepareLocalTranscript({ sessionId: 'IETF126-DISPATCH-20260720-0700' }, tmpFile);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      expect(thrown.message).toMatch(/transcript is empty/);
      expect(isRecordingUnavailable(thrown.message)).toBe(false);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});
