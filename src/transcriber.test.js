/**
 * Tests for the audio transcription pipeline: the DISPATCH-20260720 regression
 * (a Gemini STT stream that returns zero text chunks must never be treated as
 * a successful transcription) and upload retry behaviour (transcribeAudio).
 */

import { jest } from '@jest/globals';

const mockExistsSync = jest.fn();
const mockFs = {
  existsSync: mockExistsSync,
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  statSync: jest.fn(() => ({ size: 1000, mtimeMs: 0 })),
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
const mockFsPromises = {
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  unlink: mockUnlink,
  rm: mockRm,
  copyFile: mockCopyFile,
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
jest.unstable_mockModule('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockImplementation(() => ({
      generateContentStream: mockGenerateContentStream,
    })),
  })),
}));

const mockUploadFile = jest.fn();
const mockGetFile = jest.fn();
const mockDeleteFile = jest.fn();
jest.unstable_mockModule('@google/generative-ai/server', () => ({
  GoogleAIFileManager: jest.fn().mockImplementation(() => ({
    uploadFile: mockUploadFile,
    getFile: mockGetFile,
    deleteFile: mockDeleteFile,
  })),
}));

jest.unstable_mockModule('./scraper.js', () => ({
  downloadTranscript: jest.fn().mockRejectedValue(new Error('official transcript not available')),
}));

const {
  transcribeAudio,
  transcribeSession,
  getAudioCachePath,
  getTranscriptCachePath,
  isTransientError,
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
  mockReadFile.mockReset();
  mockWriteFile.mockClear();
  mockUnlink.mockClear();
  mockExecSync.mockReset();
  mockGenerateContentStream.mockReset();
  mockUploadFile.mockReset().mockResolvedValue({ file: { name: 'files/abc' } });
  mockGetFile.mockReset().mockResolvedValue({ state: 'ACTIVE', mimeType: 'audio/mpeg', uri: 'files/abc' });
  mockDeleteFile.mockReset().mockResolvedValue({});
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

describe('transcribeAudio upload retry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockUploadFile.mockReset();
    mockGetFile.mockReset();
    mockDeleteFile.mockReset();
    mockGenerateContentStream.mockReset();

    mockGetFile.mockResolvedValue({ state: 'ACTIVE', mimeType: 'audio/mpeg', uri: 'file://fake' });
    mockDeleteFile.mockResolvedValue(undefined);
    mockGenerateContentStream.mockResolvedValue(makeSuccessfulStreamResult());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('retries a transient upload failure then succeeds', async () => {
    mockUploadFile
      .mockRejectedValueOnce(new Error('[408 Request Timeout]'))
      .mockResolvedValueOnce({ file: { name: 'files/abc' } });

    const promise = transcribeAudio('/tmp/fake.mp3', 'fake-key', 'gemini-3.5-flash', false, null);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(mockUploadFile).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('hello world');
    expect(mockDeleteFile).toHaveBeenCalledWith('files/abc');
  });

  test('exhausts retries and propagates the final error', async () => {
    mockUploadFile.mockRejectedValue(new Error('[503 Service Unavailable]'));

    const promise = transcribeAudio('/tmp/fake.mp3', 'fake-key', 'gemini-3.5-flash', false, null);
    // Attach a catch handler immediately so the eventual rejection isn't
    // reported as unhandled while we advance timers below.
    const assertion = expect(promise).rejects.toThrow('[503 Service Unavailable]');
    await jest.runAllTimersAsync();
    await assertion;

    expect(mockUploadFile).toHaveBeenCalledTimes(4);
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  test('does not retry a permanent error', async () => {
    mockUploadFile.mockRejectedValue(new Error('[401 Unauthorized]'));

    const promise = transcribeAudio('/tmp/fake.mp3', 'fake-key', 'gemini-3.5-flash', false, null);
    const assertion = expect(promise).rejects.toThrow('[401 Unauthorized]');
    await jest.runAllTimersAsync();
    await assertion;

    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  test('does not retry a credit-depletion 429 error', async () => {
    mockUploadFile.mockRejectedValue(
      new Error('[429 Too Many Requests] Your prepayment credits are depleted'),
    );

    const promise = transcribeAudio('/tmp/fake.mp3', 'fake-key', 'gemini-3.5-flash', false, null);
    const assertion = expect(promise).rejects.toThrow('credits are depleted');
    await jest.runAllTimersAsync();
    await assertion;

    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });
});
