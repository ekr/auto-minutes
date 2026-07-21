/**
 * CLI-level tests for the --stt-model "+names" validation added in
 * src/index.js's yargs .check() (the guard commit f247271 introduced to stop
 * "google:chirp_2+names" from reaching the pipeline and firing a real,
 * billed, useless Gemini call).
 *
 * yargs' .parse() runs unconditionally at import time, so index.js can't be
 * `import()`-ed in-process without invoking process.exit() inside the Jest
 * worker (same constraint as transcribe-diarize.js). Spawn it as a real CLI
 * process instead and assert on stderr/exit code.
 */

import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function runCli(args) {
  return spawnSync(process.execPath, ['src/index.js', ...args], {
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...process.env, GEMINI_API_KEY: '' },
  });
}

test('rejects google:chirp_2+names (chirp_2 has no speaker labels to map)', () => {
  const result = runCli(['--preview', '123:6LO', '--audio', '--stt-model', 'google:chirp_2+names']);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    '--stt-model "google:chirp_2+names" is invalid: the "+names" hybrid requires chirp_3 diarization'
  );
});

test('rejects an unknown --stt-model base', () => {
  const result = runCli(['--preview', '123:6LO', '--audio', '--stt-model', 'bogus']);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('--stt-model "bogus" is invalid');
});

test.each(['google:chirp_3+names', 'google+names'])(
  'accepts %s past CLI validation',
  (sttModel) => {
    const result = runCli(['--preview', '123:6LO', '--audio', '--stt-model', sttModel]);

    // Validation passes; the process instead fails later for lack of a
    // GEMINI_API_KEY, proving it got past the --stt-model .check().
    expect(result.stderr).not.toMatch(/--stt-model ".*" is invalid/);
    expect(result.stderr).toContain('GEMINI_API_KEY not found in environment');
    expect(result.status).toBe(1);
  }
);

test.each(['deepgram', 'deepgram:nova-2', 'deepgram:nova-3', 'deepgram:nova-3+names', 'deepgram+names'])(
  'accepts %s past CLI validation',
  (sttModel) => {
    const result = runCli(['--preview', '123:6LO', '--audio', '--stt-model', sttModel]);

    expect(result.stderr).not.toMatch(/--stt-model ".*" is invalid/);
    expect(result.status).toBe(1);
  }
);

test('rejects a bogus deepgram variant', () => {
  const result = runCli(['--preview', '123:6LO', '--audio', '--stt-model', 'deepgram:foo+bar']);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('--stt-model "deepgram:foo+bar" is invalid');
});

test('--amend requires --comments', () => {
  const result = runCli(['--amend', '123:6LO']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('--amend requires --comments <file>');
});

test('--comments requires --amend', () => {
  const result = runCli(['--comments', 'comments.txt', '--output']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('--comments requires --amend <selector>');
});

test('--amend requires a WG-scoped selector', () => {
  const result = runCli(['--amend', '123', '--comments', 'comments.txt']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('--amend requires a WG selector (NUMBER:GROUP or YYYY-MM-DD:GROUP)');
});

test('--amend cannot be combined with --summarize', () => {
  const result = runCli(['--amend', '123:6LO', '--comments', 'comments.txt', '--summarize', '123']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('--amend cannot be combined with --summarize');
});

test('--amend rejects a nonexistent comments file before API initialization', () => {
  const missingPath = 'definitely-does-not-exist-comments.txt';
  const result = runCli(['--amend', '123:6LO', '--comments', missingPath]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`--comments '${missingPath}' does not exist`);
});

test('--amend rejects a whitespace-only comments file before API initialization', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'auto-minutes-comments-'));
  const commentsPath = join(tempDir, 'comments.txt');
  writeFileSync(commentsPath, '  \n\t');

  try {
    const result = runCli(['--amend', '123:6LO', '--comments', commentsPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot amend minutes: comments are empty');
    expect(result.stderr).not.toContain('GEMINI_API_KEY not found in environment');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
