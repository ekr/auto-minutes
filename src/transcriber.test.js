/**
 * Tests for the audio transcription pipeline: the DISPATCH-20260720 regression
 * (a Gemini STT stream that returns zero text chunks must never be treated as
 * a successful transcription), upload retry behaviour (transcribeAudio),
 * --stt-model parsing, chirp diarization formatting with timestamps, and the
 * chirp+Gemini name-fill hybrid.
 */

import { jest } from '@jest/globals';

const mockExistsSync = jest.fn();
const mockStatSync = jest.fn(() => ({ size: 1000, mtimeMs: 0 }));
const mockFs = {
  existsSync: mockExistsSync,
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  statSync: mockStatSync,
  readFileSync: jest.fn(),
};
jest.unstable_mockModule('fs', () => ({
  default: mockFs,
  ...mockFs,
}));

const mockMkdir = jest.fn().mockResolvedValue(undefined);
const mockWriteFile = jest.fn().mockResolvedValue(undefined);
const mockReadFile = jest.fn();
const mockUnlink = jest.fn().mockResolvedValue(undefined);
const mockRm = jest.fn().mockResolvedValue(undefined);
const mockCopyFile = jest.fn().mockResolvedValue(undefined);
const mockFileHandleRead = jest.fn(async (buffer, _offset, length) => ({ bytesRead: length, buffer }));
const mockFileHandleClose = jest.fn().mockResolvedValue(undefined);
const mockOpen = jest.fn().mockResolvedValue({ read: mockFileHandleRead, close: mockFileHandleClose });
const mockFsPromises = {
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  unlink: mockUnlink,
  rm: mockRm,
  copyFile: mockCopyFile,
  open: mockOpen,
};
jest.unstable_mockModule('fs/promises', () => ({
  default: mockFsPromises,
  ...mockFsPromises,
}));

const mockExecSync = jest.fn();
jest.unstable_mockModule('child_process', () => ({
  execSync: mockExecSync,
  spawnSync: jest.fn(),
}));

const mockGenerateContentStream = jest.fn();
const mockGenerateContent = jest.fn();
jest.unstable_mockModule('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockImplementation(() => ({
      generateContentStream: mockGenerateContentStream,
      generateContent: mockGenerateContent,
    })),
  })),
}));

const mockGetFile = jest.fn();
const mockDeleteFile = jest.fn();
jest.unstable_mockModule('@google/generative-ai/server', () => ({
  GoogleAIFileManager: jest.fn().mockImplementation(() => ({
    getFile: mockGetFile,
    deleteFile: mockDeleteFile,
  })),
}));

jest.unstable_mockModule('./scraper.js', () => ({
  downloadTranscript: jest.fn().mockRejectedValue(new Error('official transcript not available')),
}));

// Gemini Files API resumable upload protocol: a "start" POST to the well-known
// upload endpoint returns a session URL via the X-Goog-Upload-URL header; chunk
// POSTs then go to that session URL.
const UPLOAD_START_URL_SUBSTRING = '/upload/v1beta/files?';
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
const UPLOAD_SESSION_URL = 'https://upload.example/session-abc';

function makeStartResponse({ ok = true, status = 200, statusText = 'OK', uploadUrl = UPLOAD_SESSION_URL } = {}) {
  return {
    ok,
    status,
    statusText,
    headers: { get: (name) => (ok && name.toLowerCase() === 'x-goog-upload-url' ? uploadUrl : null) },
    text: async () => (ok ? '' : 'start failed'),
  };
}

function makeChunkResponse({ ok = true, status = 200, statusText = 'OK', fileName = 'files/abc' } = {}) {
  return {
    ok,
    status,
    statusText,
    text: async () => (ok ? '' : 'chunk failed'),
    json: async () => ({ file: { name: fileName, uri: 'file://fake', mimeType: 'audio/mpeg', state: 'ACTIVE' } }),
  };
}

const mockFetch = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({
  default: mockFetch,
}));

const {
  transcribeAudio,
  transcribeSession,
  getAudioCachePath,
  getTranscriptCachePath,
  isTransientError,
  uploadFileResumable,
  parseSttModel,
  formatDiarizedTranscript,
  applyNameHybrid,
  transcribeAudioDeepgram,
  formatDeepgramTranscript,
  buildDeepgramKeyterms,
} = await import('./transcriber.js');

function makeStreamResult(chunkTexts, finishReason = 'STOP') {
  return {
    stream: (async function* () {
      for (const t of chunkTexts) {
        yield {
          text: () => t,
          candidates: [{ finishReason, safetyRatings: [] }],
        };
      }
    })(),
    response: Promise.resolve({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }),
  };
}

// A fake successful stream: one chunk of text, then a resolved aggregated response.
function makeSuccessfulStreamResult(text = 'hello world') {
  return {
    stream: (async function* () {
      yield {
        candidates: [{ finishReason: 'STOP', safetyRatings: [] }],
        text: () => text,
      };
    })(),
    response: Promise.resolve({
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }),
  };
}

beforeEach(() => {
  mockExistsSync.mockReset();
  mockStatSync.mockReset().mockReturnValue({ size: 1000, mtimeMs: 0 });
  mockReadFile.mockReset();
  mockWriteFile.mockClear();
  mockUnlink.mockClear();
  mockExecSync.mockReset();
  mockGenerateContentStream.mockReset();
  mockGenerateContent.mockReset();
  mockGetFile.mockReset().mockResolvedValue({ state: 'ACTIVE', mimeType: 'audio/mpeg', uri: 'files/abc' });
  mockDeleteFile.mockReset().mockResolvedValue({});
  mockOpen.mockReset().mockResolvedValue({ read: mockFileHandleRead, close: mockFileHandleClose });
  mockFileHandleRead.mockReset().mockImplementation(async (buffer, _offset, length) => ({ bytesRead: length, buffer }));
  mockFileHandleClose.mockReset().mockResolvedValue(undefined);
  // Default: a single-chunk resumable upload that always succeeds, so tests that
  // don't care about upload mechanics (streaming/caching tests) get a working upload.
  mockFetch.mockReset().mockImplementation(async (url) => {
    if (typeof url === 'string' && url.includes(UPLOAD_START_URL_SUBSTRING)) {
      return makeStartResponse();
    }
    return makeChunkResponse();
  });
});

describe('transcribeAudio', () => {
  test('retries MAX_STREAM_RETRIES times and then throws when the stream yields no text', async () => {
    mockGenerateContentStream.mockImplementation(() => Promise.resolve(makeStreamResult([], 'STOP')));

    await expect(transcribeAudio('/tmp/fake.mp3', 'fake-key')).rejects.toThrow(
      /Gemini STT returned no transcript text/,
    );
    // MAX_STREAM_RETRIES (3) + the initial attempt = 4 calls
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(4);
  });

  test('retries with the initial prompt (not a continuation prompt) after an empty attempt', async () => {
    mockGenerateContentStream
      .mockImplementationOnce(() => Promise.resolve(makeStreamResult([], 'STOP')))
      .mockImplementationOnce(() => Promise.resolve(makeStreamResult(['**Speaker:** hello world'], 'STOP')));

    const result = await transcribeAudio('/tmp/fake.mp3', 'fake-key');

    expect(result.text).toContain('hello world');
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(2);

    const firstPrompt = mockGenerateContentStream.mock.calls[0][0][1].text;
    const secondPrompt = mockGenerateContentStream.mock.calls[1][0][1].text;
    expect(secondPrompt).toBe(firstPrompt);
    expect(secondPrompt).not.toMatch(/Continue transcribing/);
  });

  test('succeeds immediately when the stream yields text on the first attempt', async () => {
    mockGenerateContentStream.mockImplementation(() =>
      Promise.resolve(makeStreamResult(['**Speaker:** hello world, this is a real transcript.'], 'STOP')),
    );

    const result = await transcribeAudio('/tmp/fake.mp3', 'fake-key');
    expect(result.text).toContain('hello world');
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
  });
});

describe('transcribeSession', () => {
  const sessionId = 'IETF126-DISPATCH-20260720-0700';
  const session = { sessionId };

  test('does not write to the transcript cache when Gemini STT produces no transcript', async () => {
    mockExistsSync.mockImplementation((p) => p === getAudioCachePath(sessionId));
    mockGenerateContentStream.mockImplementation(() => Promise.resolve(makeStreamResult([], 'STOP')));

    await expect(transcribeSession(session, 'gemini', 'fake-key')).rejects.toThrow(
      /no transcript text/,
    );
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  test('deletes a poisoned cached transcript and re-transcribes instead of returning it', async () => {
    mockExistsSync.mockImplementation(
      (p) => p === getAudioCachePath(sessionId) || p === getTranscriptCachePath(sessionId),
    );
    mockReadFile.mockResolvedValue('');
    mockExecSync.mockReturnValue('1.0'); // 1 second of audio — trivially satisfies the word floor
    mockGenerateContentStream.mockImplementation(() =>
      Promise.resolve(makeStreamResult(['**Speaker:** This is a real transcript with real words.'], 'STOP')),
    );

    const result = await transcribeSession(session, 'gemini', 'fake-key');

    expect(mockUnlink).toHaveBeenCalledWith(getTranscriptCachePath(sessionId));
    expect(result.text).toContain('real transcript');
    expect(mockWriteFile).toHaveBeenCalled();
  });

  test('returns the cached transcript without calling Gemini when the cache is valid', async () => {
    mockExistsSync.mockImplementation((p) => p === getTranscriptCachePath(sessionId));
    mockReadFile.mockResolvedValue('**Speaker:** A perfectly good cached transcript.');

    const result = await transcribeSession(session, 'gemini', 'fake-key');

    expect(result.text).toBe('**Speaker:** A perfectly good cached transcript.');
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, model: null });
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  test('duration check throws when word count is far below what the audio length implies', async () => {
    mockExistsSync.mockImplementation((p) => p === getAudioCachePath(sessionId));
    mockExecSync.mockReturnValue('6300'); // 105 minutes
    mockGenerateContentStream.mockImplementation(() => Promise.resolve(makeStreamResult(['hi'], 'STOP')));

    await expect(transcribeSession(session, 'gemini', 'fake-key')).rejects.toThrow(
      /minimum \d+ words expected/,
    );
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  test('duration check passes when word count meets the floor for the audio length', async () => {
    mockExistsSync.mockImplementation((p) => p === getAudioCachePath(sessionId));
    mockExecSync.mockReturnValue('6300'); // 105 minutes
    const words = new Array(11000).fill('word').join(' ');
    mockGenerateContentStream.mockImplementation(() => Promise.resolve(makeStreamResult([words], 'STOP')));

    const result = await transcribeSession(session, 'gemini', 'fake-key');
    expect(result.text.trim().split(/\s+/).length).toBe(11000);
    expect(mockWriteFile).toHaveBeenCalled();
  });
});

describe('isTransientError', () => {
  test('returns true for 408/429/500/502/503/504 status codes in message', () => {
    for (const code of [408, 429, 500, 502, 503, 504]) {
      expect(isTransientError(new Error(`[${code} Some Status]`))).toBe(true);
    }
  });

  test('returns true for common Node network error codes', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND']) {
      const error = new Error('network blip');
      error.code = code;
      expect(isTransientError(error)).toBe(true);
    }
  });

  test('returns true for socket hang up / network / fetch failed messages', () => {
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
  });

  test('returns false for permanent 400/401/403/404 errors', () => {
    for (const code of [400, 401, 403, 404]) {
      expect(isTransientError(new Error(`[${code} Bad Request]`))).toBe(false);
    }
  });

  test('returns false for credit-depletion 429 errors', () => {
    expect(
      isTransientError(new Error('[429 Too Many Requests] Your prepayment credits are depleted')),
    ).toBe(false);
  });

  test('returns false for null/undefined', () => {
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});

describe('uploadFileResumable', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function chunkCalls() {
    return mockFetch.mock.calls.filter(([url]) => url === UPLOAD_SESSION_URL);
  }

  test('happy path: file smaller than one chunk uploads in a single "upload, finalize" request', async () => {
    mockStatSync.mockReturnValue({ size: 1000, mtimeMs: 0 });
    mockFetch
      .mockReset()
      .mockImplementationOnce(async () => makeStartResponse())
      .mockImplementationOnce(async () => makeChunkResponse({ fileName: 'files/abc' }));

    const result = await uploadFileResumable('/tmp/fake.mp3', 'fake-key');

    expect(result).toEqual({ file: { name: 'files/abc', uri: 'file://fake', mimeType: 'audio/mpeg', state: 'ACTIVE' } });
    expect(chunkCalls()).toHaveLength(1);
    expect(chunkCalls()[0][1].headers['X-Goog-Upload-Offset']).toBe('0');
    expect(chunkCalls()[0][1].headers['X-Goog-Upload-Command']).toBe('upload, finalize');
  });

  test('multi-chunk: a file spanning 3 chunks sends 3 chunk POSTs at increasing offsets, finalize only on the last', async () => {
    mockStatSync.mockReturnValue({ size: UPLOAD_CHUNK_SIZE * 2 + 100, mtimeMs: 0 });
    mockFetch
      .mockReset()
      .mockImplementationOnce(async () => makeStartResponse())
      .mockImplementationOnce(async () => makeChunkResponse())
      .mockImplementationOnce(async () => makeChunkResponse())
      .mockImplementationOnce(async () => makeChunkResponse());

    await uploadFileResumable('/tmp/fake.mp3', 'fake-key');

    const calls = chunkCalls();
    expect(calls).toHaveLength(3);
    expect(calls[0][1].headers['X-Goog-Upload-Offset']).toBe('0');
    expect(calls[0][1].headers['X-Goog-Upload-Command']).toBe('upload');
    expect(calls[1][1].headers['X-Goog-Upload-Offset']).toBe(String(UPLOAD_CHUNK_SIZE));
    expect(calls[1][1].headers['X-Goog-Upload-Command']).toBe('upload');
    expect(calls[2][1].headers['X-Goog-Upload-Offset']).toBe(String(UPLOAD_CHUNK_SIZE * 2));
    expect(calls[2][1].headers['X-Goog-Upload-Command']).toBe('upload, finalize');
  });

  test('transient chunk retry: a chunk that 408s once is re-sent at the same offset and the upload completes', async () => {
    mockStatSync.mockReturnValue({ size: UPLOAD_CHUNK_SIZE + 100, mtimeMs: 0 });
    mockFetch
      .mockReset()
      .mockImplementationOnce(async () => makeStartResponse())
      .mockImplementationOnce(async () => makeChunkResponse()) // chunk 1 (offset 0)
      .mockImplementationOnce(async () => makeChunkResponse({ ok: false, status: 408, statusText: 'Request Timeout' })) // chunk 2 attempt 1
      .mockImplementationOnce(async () => makeChunkResponse()); // chunk 2 attempt 2

    const promise = uploadFileResumable('/tmp/fake.mp3', 'fake-key');
    await jest.runAllTimersAsync();
    await promise;

    const calls = chunkCalls();
    // chunk 1 (offset 0) + chunk 2 attempt 1 (408, offset CHUNK_SIZE) + chunk 2 attempt 2 (retry, same offset)
    expect(calls).toHaveLength(3);
    expect(calls[1][1].headers['X-Goog-Upload-Offset']).toBe(String(UPLOAD_CHUNK_SIZE));
    expect(calls[2][1].headers['X-Goog-Upload-Offset']).toBe(String(UPLOAD_CHUNK_SIZE));
  });

  test('exhausts retries: a chunk that always 408s is attempted MAX_UPLOAD_ATTEMPTS times and the error propagates', async () => {
    mockStatSync.mockReturnValue({ size: 1000, mtimeMs: 0 });
    mockFetch
      .mockReset()
      .mockImplementationOnce(async () => makeStartResponse())
      .mockImplementation(async () => makeChunkResponse({ ok: false, status: 408, statusText: 'Request Timeout' }));

    const promise = uploadFileResumable('/tmp/fake.mp3', 'fake-key');
    const assertion = expect(promise).rejects.toThrow('[408 Request Timeout]');
    await jest.runAllTimersAsync();
    await assertion;

    expect(chunkCalls()).toHaveLength(4); // MAX_UPLOAD_ATTEMPTS
  });

  test('permanent error fast-fail: start returns 400 and the error propagates without retry', async () => {
    mockFetch.mockReset().mockImplementation(async () => makeStartResponse({ ok: false, status: 400, statusText: 'Bad Request' }));

    await expect(uploadFileResumable('/tmp/fake.mp3', 'fake-key')).rejects.toThrow('[400 Bad Request]');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('missing upload URL: start returns 200 with no X-Goog-Upload-URL header throws a clear error', async () => {
    mockFetch.mockReset().mockImplementation(async () => makeStartResponse({ uploadUrl: null }));

    await expect(uploadFileResumable('/tmp/fake.mp3', 'fake-key')).rejects.toThrow(/X-Goog-Upload-URL/);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('transcribeAudio upload wiring', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockGetFile.mockReset().mockResolvedValue({ state: 'ACTIVE', mimeType: 'audio/mpeg', uri: 'file://fake' });
    mockDeleteFile.mockReset().mockResolvedValue(undefined);
    mockGenerateContentStream.mockReset().mockResolvedValue(makeSuccessfulStreamResult());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('uploads via the resumable helper and cleans up the remote file on success', async () => {
    mockFetch
      .mockReset()
      .mockImplementationOnce(async () => makeStartResponse())
      .mockImplementationOnce(async () => makeChunkResponse({ fileName: 'files/abc' }));

    const result = await transcribeAudio('/tmp/fake.mp3', 'fake-key', 'gemini-3.5-flash', false, null);

    expect(result.text).toBe('hello world');
    expect(mockDeleteFile).toHaveBeenCalledWith('files/abc');
  });

  test('propagates an exhausted-retry upload error without calling Gemini or deleting a remote file', async () => {
    mockFetch
      .mockReset()
      .mockImplementationOnce(async () => makeStartResponse())
      .mockImplementation(async () => makeChunkResponse({ ok: false, status: 503, statusText: 'Service Unavailable' }));

    const promise = transcribeAudio('/tmp/fake.mp3', 'fake-key', 'gemini-3.5-flash', false, null);
    const assertion = expect(promise).rejects.toThrow('[503 Service Unavailable]');
    await jest.runAllTimersAsync();
    await assertion;

    expect(mockGenerateContentStream).not.toHaveBeenCalled();
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });
});

describe('parseSttModel', () => {
  test('plain google model has no hybrid suffix', () => {
    expect(parseSttModel('google')).toEqual({ baseSttModel: 'google', hybridNames: false });
  });

  test('gemini model has no hybrid suffix', () => {
    expect(parseSttModel('gemini')).toEqual({ baseSttModel: 'gemini', hybridNames: false });
  });

  test('strips "+names" and keeps the chirp variant intact', () => {
    expect(parseSttModel('google:chirp_3+names')).toEqual({ baseSttModel: 'google:chirp_3', hybridNames: true });
    expect(parseSttModel('google:chirp_2+names')).toEqual({ baseSttModel: 'google:chirp_2', hybridNames: true });
    expect(parseSttModel('google+names')).toEqual({ baseSttModel: 'google', hybridNames: true });
  });

  test('strips "+names" and keeps the deepgram variant intact', () => {
    expect(parseSttModel('deepgram:nova-3+names')).toEqual({ baseSttModel: 'deepgram:nova-3', hybridNames: true });
    expect(parseSttModel('deepgram+names')).toEqual({ baseSttModel: 'deepgram', hybridNames: true });
  });

  test('plain deepgram model has no hybrid suffix', () => {
    expect(parseSttModel('deepgram:nova-3')).toEqual({ baseSttModel: 'deepgram:nova-3', hybridNames: false });
  });
});

describe('formatDiarizedTranscript', () => {
  test('formats turns with "[HH:MM:SS] Speaker N: ..." and breaks on speaker changes', () => {
    const words = [
      { word: 'Hello', speakerLabel: '1', startOffset: '0s' },
      { word: 'everyone.', speakerLabel: '1', startOffset: '0.5s' },
      { word: 'Hi', speakerLabel: '2', startOffset: '12.340s' },
      { word: 'there.', speakerLabel: '2', startOffset: '12.8s' },
      { word: 'Thanks.', speakerLabel: '1', startOffset: '3723s' },
    ];

    const result = formatDiarizedTranscript(words);

    expect(result).toBe(
      '[00:00:00] Speaker 1: Hello everyone.\n' +
      '[00:00:12] Speaker 2: Hi there.\n' +
      '[01:02:03] Speaker 1: Thanks.'
    );
  });

  test('degrades gracefully (no prefix, never "[NaN:NaN:NaN]") when offsets are missing', () => {
    const words = [
      { word: 'Hello', speakerLabel: '1' },
      { word: 'world.', speakerLabel: '1' },
    ];

    const result = formatDiarizedTranscript(words);

    expect(result).toBe('Speaker 1: Hello world.');
    expect(result).not.toContain('NaN');
  });
});

describe('applyNameHybrid', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
  });

  test('maps generic speaker labels to real names, preserves timestamps, and records usage', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify({ 'Speaker 1': 'Jane Smith' }),
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 },
      },
    });

    const chirpTranscript = '[00:14:32] Speaker 1: Hello everyone.';
    const result = await applyNameHybrid(chirpTranscript, 'fake-key', null, false);

    expect(result.text).toContain('[00:14:32] **Jane Smith**: Hello everyone.');
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30, model: 'gemini-3.5-flash' });
  });

  test('feeds bluesheet participant names from context into the Gemini naming prompt', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify({ 'Speaker 1': 'Jane Smith' }),
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 },
      },
    });

    const context = {
      slidesAndBluesheet: {
        bluesheet: [
          'Bluesheet for IETF-124: privacypass  Monday 09:30',
          '================================================================',
          '2 attendees.',
          '',
          'Jane Smith\tExample Corp',
          'John Doe\tAcme Inc',
        ].join('\n'),
      },
    };

    const chirpTranscript = '[00:14:32] Speaker 1: Hello everyone.';
    const result = await applyNameHybrid(chirpTranscript, 'fake-key', context, false);

    const contents = mockGenerateContent.mock.calls[0][0];
    const promptText = contents.map(c => c.text).join('\n');
    expect(promptText).toContain('Jane Smith');
    expect(promptText).toContain('John Doe');
    expect(result.text).toContain('[00:14:32] **Jane Smith**: Hello everyone.');
  });

  test('passes null participantsList when context has no bluesheet', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify({ 'Speaker 1': 'Jane Smith' }),
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      },
    });

    await applyNameHybrid('Speaker 1: hi', 'fake-key', {}, false);

    const contents = mockGenerateContent.mock.calls[0][0];
    const promptText = contents.map(c => c.text).join('\n');
    expect(promptText).not.toContain('A list of expected participants');
  });

  test('is text-only: never sends audio fileData to Gemini', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify({ 'Speaker 1': 'Jane Smith' }),
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      },
    });

    await applyNameHybrid('Speaker 1: hi', 'fake-key', null, false);

    const contents = mockGenerateContent.mock.calls[0][0];
    expect(contents.some(c => c.fileData)).toBe(false);
  });

  test('fails soft: falls back to the unmodified chirp transcript when name mapping errors', async () => {
    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockGenerateContent.mockRejectedValue(new Error('gemini unavailable'));

    const chirpTranscript = '[00:14:32] Speaker 1: Hello everyone.';
    const resultPromise = applyNameHybrid(chirpTranscript, 'fake-key', null, false);
    await jest.advanceTimersByTimeAsync(20000);
    const result = await resultPromise;

    expect(result.text).toBe(chirpTranscript);
    expect(result.usage).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    errorSpy.mockRestore();
    jest.useRealTimers();
  }, 15000);
});

function makeDeepgramResponse({ ok = true, status = 200, statusText = 'OK', body = {} } = {}) {
  return {
    ok,
    status,
    statusText,
    text: async () => (ok ? '' : JSON.stringify(body)),
    json: async () => body,
  };
}

const DEEPGRAM_TRANSCRIPT_BODY = {
  results: {
    channels: [
      {
        alternatives: [
          {
            transcript: 'Hello there, Hi',
            words: [
              { word: 'hello', punctuated_word: 'Hello', start: 0.0, end: 0.4, speaker: 0 },
              { word: 'there', punctuated_word: 'there,', start: 0.4, end: 0.8, speaker: 0 },
              { word: 'hi', punctuated_word: 'Hi', start: 5.0, end: 5.3, speaker: 1 },
            ],
          },
        ],
      },
    ],
  },
};

describe('formatDeepgramTranscript', () => {
  test('formats turns with "[HH:MM:SS] Speaker N: ..." and breaks on speaker changes', () => {
    const words = [
      { word: 'hello', punctuated_word: 'Hello', start: 0, speaker: 0 },
      { word: 'world', punctuated_word: 'world.', start: 0.3, speaker: 0 },
      { word: 'hi', punctuated_word: 'Hi', start: 65, speaker: 1 },
    ];
    expect(formatDeepgramTranscript(words)).toBe('[00:00:00] Speaker 0: Hello world.\n[00:01:05] Speaker 1: Hi');
  });

  test('falls back to the raw word when punctuated_word is absent', () => {
    const words = [{ word: 'hello', start: 0, speaker: 0 }];
    expect(formatDeepgramTranscript(words)).toBe('[00:00:00] Speaker 0: hello');
  });
});

describe('buildDeepgramKeyterms', () => {
  test('seeds keyterms from bluesheet participants and active drafts, filtering non-WG drafts', () => {
    const context = {
      slidesAndBluesheet: {
        bluesheet: [
          'Bluesheet for IETF-124: privacypass  Monday 09:30',
          '================================================================',
          '2 attendees.',
          '',
          'Jane Smith\tExample Corp',
          'John Doe\tAcme Inc',
        ].join('\n'),
      },
      wgDocuments: [
        { Name: 'draft-ietf-foo-bar', Title: 'Foo Bar', 'Status in the IETF process': 'Active' },
        { Name: 'draft-individual-baz', Title: 'Not a WG draft', 'Status in the IETF process': 'Active' },
      ],
    };

    expect(buildDeepgramKeyterms(context)).toEqual(['Jane Smith', 'John Doe', 'draft-ietf-foo-bar']);
  });

  test('dedupes participant names case-insensitively, keeping the first-seen casing', () => {
    const bluesheet = [
      'Bluesheet for IETF-124: test',
      '====',
      '2 attendees.',
      '',
      'Jane Smith\tExample Corp',
      'JANE SMITH\tExample Corp',
    ].join('\n');

    expect(buildDeepgramKeyterms({ slidesAndBluesheet: { bluesheet } })).toEqual(['Jane Smith']);
  });

  test('caps the combined list at 100 terms', () => {
    const bluesheetLines = [
      'Bluesheet for IETF-124: test',
      '====',
      '150 attendees.',
      '',
      ...Array.from({ length: 150 }, (_, i) => `Person ${i}\tAffiliation`),
    ];

    const keyterms = buildDeepgramKeyterms({ slidesAndBluesheet: { bluesheet: bluesheetLines.join('\n') } });

    expect(keyterms).toHaveLength(100);
  });

  test('returns an empty list when context is null', () => {
    expect(buildDeepgramKeyterms(null)).toEqual([]);
  });
});

describe('transcribeAudioDeepgram', () => {
  const ORIGINAL_KEY = process.env.DEEPGRAM_API_KEY;

  beforeEach(() => {
    process.env.DEEPGRAM_API_KEY = 'fake-deepgram-key';
    mockReadFile.mockReset().mockResolvedValue(Buffer.from('fake audio bytes'));
    jest.useFakeTimers();
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env.DEEPGRAM_API_KEY;
    } else {
      process.env.DEEPGRAM_API_KEY = ORIGINAL_KEY;
    }
    jest.useRealTimers();
  });

  test('throws a clear error when DEEPGRAM_API_KEY is missing', async () => {
    delete process.env.DEEPGRAM_API_KEY;

    await expect(transcribeAudioDeepgram('/tmp/fake.mp3')).rejects.toThrow(
      /DEEPGRAM_API_KEY is required for --stt-model deepgram/,
    );
  });

  test('formats diarized words into "[HH:MM:SS] Speaker N: ..." turns, preferring punctuated_word', async () => {
    mockFetch.mockReset().mockImplementation(async () => makeDeepgramResponse({ body: DEEPGRAM_TRANSCRIPT_BODY }));

    const transcript = await transcribeAudioDeepgram('/tmp/fake.mp3', 'nova-3', false, []);

    expect(transcript).toBe('[00:00:00] Speaker 0: Hello there,\n[00:00:05] Speaker 1: Hi');
  });

  test('falls back to alternatives[0].transcript when no diarized words are present', async () => {
    mockFetch.mockReset().mockImplementation(async () => makeDeepgramResponse({
      body: { results: { channels: [{ alternatives: [{ transcript: 'plain transcript, no diarization' }] }] } },
    }));

    const transcript = await transcribeAudioDeepgram('/tmp/fake.mp3', 'nova-3', false, []);

    expect(transcript).toBe('plain transcript, no diarization');
  });

  test('sends "keyterm" query params for nova-3 and "keywords" for nova-2', async () => {
    mockFetch.mockReset().mockImplementation(async () => makeDeepgramResponse({ body: DEEPGRAM_TRANSCRIPT_BODY }));

    await transcribeAudioDeepgram('/tmp/fake.mp3', 'nova-3', false, ['Jane Smith', 'draft-ietf-foo-bar']);
    const nova3Url = mockFetch.mock.calls[0][0];
    expect(nova3Url).toContain('keyterm=Jane+Smith');
    expect(nova3Url).toContain('keyterm=draft-ietf-foo-bar');
    expect(nova3Url).not.toContain('keywords=');

    mockFetch.mockClear();
    await transcribeAudioDeepgram('/tmp/fake.mp3', 'nova-2', false, ['Jane Smith']);
    const nova2Url = mockFetch.mock.calls[0][0];
    expect(nova2Url).toContain('keywords=Jane+Smith');
    expect(nova2Url).not.toContain('keyterm=');
  });

  test('transient retry: a 503 is retried and a subsequent 200 succeeds', async () => {
    mockFetch
      .mockReset()
      .mockImplementationOnce(async () => makeDeepgramResponse({ ok: false, status: 503, statusText: 'Service Unavailable' }))
      .mockImplementationOnce(async () => makeDeepgramResponse({ body: DEEPGRAM_TRANSCRIPT_BODY }));

    const promise = transcribeAudioDeepgram('/tmp/fake.mp3', 'nova-3', false, []);
    await jest.runAllTimersAsync();
    const transcript = await promise;

    expect(transcript).toContain('Speaker 0');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('permanent error: a 401 fails on the first attempt without retry', async () => {
    mockFetch.mockReset().mockImplementation(async () => makeDeepgramResponse({ ok: false, status: 401, statusText: 'Unauthorized' }));

    const promise = transcribeAudioDeepgram('/tmp/fake.mp3', 'nova-3', false, []);
    const assertion = expect(promise).rejects.toThrow('[401 Unauthorized]');
    await jest.runAllTimersAsync();
    await assertion;

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('transcribeSession deepgram dispatch', () => {
  const sessionId = 'IETF126-DISPATCH-20260720-0700';
  const session = { sessionId };
  const ORIGINAL_KEY = process.env.DEEPGRAM_API_KEY;

  beforeEach(() => {
    process.env.DEEPGRAM_API_KEY = 'fake-deepgram-key';
    mockReadFile.mockReset().mockResolvedValue(Buffer.from('fake audio bytes'));
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env.DEEPGRAM_API_KEY;
    } else {
      process.env.DEEPGRAM_API_KEY = ORIGINAL_KEY;
    }
  });

  test('calls transcribeAudioDeepgram and, for a "+names" hybrid, applyNameHybrid, aggregating usage', async () => {
    mockExistsSync.mockImplementation((p) => p === getAudioCachePath(sessionId));
    mockFetch.mockReset().mockImplementation(async (url) => {
      if (typeof url === 'string' && url.startsWith('https://api.deepgram.com/')) {
        return makeDeepgramResponse({ body: DEEPGRAM_TRANSCRIPT_BODY });
      }
      return makeChunkResponse();
    });
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify({ 'Speaker 0': 'Jane Smith', 'Speaker 1': 'John Doe' }),
        usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 8 },
      },
    });

    const result = await transcribeSession(session, 'deepgram:nova-3+names', 'fake-gemini-key');

    expect(result.text).toContain('**Jane Smith**');
    expect(result.text).toContain('**John Doe**');
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 8, model: 'gemini-3.5-flash' });
    expect(mockWriteFile).toHaveBeenCalled();
  });

  test('deepgram without "+names" produces "Speaker N" labels and zero usage', async () => {
    mockExistsSync.mockImplementation((p) => p === getAudioCachePath(sessionId));
    mockFetch.mockReset().mockImplementation(async (url) => {
      if (typeof url === 'string' && url.startsWith('https://api.deepgram.com/')) {
        return makeDeepgramResponse({ body: DEEPGRAM_TRANSCRIPT_BODY });
      }
      return makeChunkResponse();
    });

    const result = await transcribeSession(session, 'deepgram:nova-3', 'fake-gemini-key');

    expect(result.text).toContain('Speaker 0');
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, model: 'deepgram:nova-3' });
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  test('"deepgram" alone (no model suffix) defaults to nova-3', async () => {
    mockExistsSync.mockImplementation((p) => p === getAudioCachePath(sessionId));
    mockFetch.mockReset().mockImplementation(async (url) => {
      if (typeof url === 'string' && url.startsWith('https://api.deepgram.com/')) {
        return makeDeepgramResponse({ body: DEEPGRAM_TRANSCRIPT_BODY });
      }
      return makeChunkResponse();
    });

    const result = await transcribeSession(session, 'deepgram', 'fake-gemini-key');

    expect(result.usage.model).toBe('deepgram:nova-3');
    expect(mockFetch.mock.calls[0][0]).toContain('model=nova-3');
  });
});
