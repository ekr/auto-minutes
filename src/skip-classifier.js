/**
 * Classifies skipped-session reasons so `--summarize` can tell a benign
 * "recording not available yet" no-op from a genuine failure when deciding
 * the process exit code.
 */

/**
 * Whether a transcript/recording-fetch failure is a benign "not available
 * yet" condition (recording not published, no Cloudflare video, transcript
 * too short) rather than a genuine failure (auth/API errors, network issues,
 * etc).
 * @param {string} message - error.message from the transcript-fetch catch site
 * @returns {boolean}
 */
export function isRecordingUnavailable(message) {
  if (!message) return false;
  return (
    /^Failed to fetch session info: 404/.test(message) ||
    /^No Cloudflare video found for session/.test(message) ||
    /is only \d+ words \(minimum \d+\)/.test(message)
  );
}

/**
 * Decide whether a completed --summarize run should exit non-zero, given the
 * sessions it skipped. A run where every skip is a benign "recording not
 * available yet" condition is a successful no-op, not a failure; a run with
 * at least one genuine failure (auth/API error, crash, etc) must still fail.
 * @param {Array<{recordingUnavailable?: boolean}>} allSkipped
 * @returns {boolean} true if the process should exit non-zero
 */
export function shouldExitNonZero(allSkipped) {
  return allSkipped.some((s) => !s.recordingUnavailable);
}
