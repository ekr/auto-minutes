/**
 * Smoke test for transcribe-diarize.js: verifies it still loads and re-exports
 * the speaker-name functions from src/speaker-names.js without error.
 *
 * The script runs main() unconditionally at import time (a yargs CLI), so it
 * can't be `import()`-ed in-process without invoking process.exit() inside the
 * Jest worker. Instead we spawn it as a real CLI process with no arguments and
 * assert it fails on yargs' own "missing audio file" validation rather than a
 * module resolution/reference error — proving the imports resolved cleanly.
 */

import { spawnSync } from 'child_process';

test('transcribe-diarize.js imports the moved speaker-name functions without error', () => {
  const result = spawnSync(process.execPath, ['transcribe-diarize.js'], {
    encoding: 'utf-8',
    timeout: 15000,
  });

  expect(result.stderr).not.toMatch(/Cannot find module|is not a function|is not exported/i);
  expect(result.stderr).toContain('You must provide an audio file path.');
  expect(result.status).toBe(1);
});
