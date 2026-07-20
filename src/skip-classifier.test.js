import { isRecordingUnavailable, shouldExitNonZero } from './skip-classifier.js';

describe('isRecordingUnavailable', () => {
  test('classifies a session-info 404 as benign', () => {
    expect(isRecordingUnavailable('Failed to fetch session info: 404 Not Found')).toBe(true);
  });

  test('classifies a missing Cloudflare video as benign', () => {
    expect(
      isRecordingUnavailable('No Cloudflare video found for session IETF124-TEST-20251103-1300 (available types: 1, 2)')
    ).toBe(true);
  });

  test('classifies an insufficient transcript as benign', () => {
    expect(
      isRecordingUnavailable('Transcript for Test WG is only 12 words (minimum 100); pass --allow-short-transcript to override')
    ).toBe(true);
  });

  test('does not classify a session-info auth failure as benign', () => {
    expect(isRecordingUnavailable('Failed to fetch session info: 401 Unauthorized')).toBe(false);
  });

  test('does not classify an unrelated error as benign', () => {
    expect(isRecordingUnavailable('ECONNRESET: socket hang up')).toBe(false);
  });

  test('handles an empty/undefined message', () => {
    expect(isRecordingUnavailable(undefined)).toBe(false);
    expect(isRecordingUnavailable('')).toBe(false);
  });
});

describe('shouldExitNonZero', () => {
  test('returns false when there are no skips', () => {
    expect(shouldExitNonZero([])).toBe(false);
  });

  test('returns false when every skip is benign (recording not available)', () => {
    const allSkipped = [
      { sessionName: 'wg1', reason: 'Failed to fetch session info: 404 Not Found', recordingUnavailable: true },
      { sessionName: 'wg2', reason: 'No Cloudflare video found for session X', recordingUnavailable: true },
    ];
    expect(shouldExitNonZero(allSkipped)).toBe(false);
  });

  test('returns true when a genuine error accompanies benign skips', () => {
    const allSkipped = [
      { sessionName: 'wg1', reason: 'Failed to fetch session info: 404 Not Found', recordingUnavailable: true },
      { sessionName: 'wg2', reason: 'Gemini API error: invalid API key', recordingUnavailable: false },
    ];
    expect(shouldExitNonZero(allSkipped)).toBe(true);
  });
});
