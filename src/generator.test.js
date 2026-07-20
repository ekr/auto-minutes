/**
 * Tests for the minutes generator's transcript validation and generation guards
 */

import { jest } from '@jest/globals';

const mockGenerateContent = jest.fn();
const mockCreate = jest.fn();

jest.unstable_mockModule('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockImplementation(() => ({
      generateContent: mockGenerateContent,
    })),
  })),
}));

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

const {
  assertTranscriptPresent,
  transcriptWordCount,
  assertTranscriptSubstantial,
  generateMinutes,
  initializeGemini,
} = await import('./generator.js');

describe('assertTranscriptPresent', () => {
  test('throws on an empty string', () => {
    expect(() => assertTranscriptPresent('', 'Test Session')).toThrow(
      'Cannot generate minutes for Test Session: transcript is empty',
    );
  });

  test('throws on a whitespace-only string', () => {
    expect(() => assertTranscriptPresent('   \n\t  ', 'Test Session')).toThrow(
      'Cannot generate minutes for Test Session: transcript is empty',
    );
  });

  test('throws "no entries" (not "is empty") on a JSON empty array', () => {
    expect(() => assertTranscriptPresent('[]', 'Test Session')).toThrow(
      'Cannot generate minutes for Test Session: transcript has no entries',
    );
  });

  test('throws "no entries" on a JSON empty array with surrounding whitespace', () => {
    expect(() => assertTranscriptPresent('  []  \n', 'Test Session')).toThrow(
      'Cannot generate minutes for Test Session: transcript has no entries',
    );
  });

  test('does not throw on a JSON array with entries', () => {
    expect(() =>
      assertTranscriptPresent(
        JSON.stringify([{ startTime: '00:00:00', text: 'hello' }]),
        'Test Session',
      ),
    ).not.toThrow();
  });

  test('does not throw a parse error on non-JSON plain Markdown text', () => {
    expect(() =>
      assertTranscriptPresent('**Jane Smith:** Hello everyone, welcome to the meeting.', 'Test Session'),
    ).not.toThrow();
  });
});

describe('transcriptWordCount', () => {
  test('counts words across Meetecho JSON entries', () => {
    const transcript = JSON.stringify([
      { startTime: '00:00:00', text: 'hello world' },
      { startTime: '00:00:05', text: 'this is a test' },
    ]);
    expect(transcriptWordCount(transcript)).toBe(6);
  });

  test('counts words in STT Markdown plain text', () => {
    const transcript = '**Jane Smith:** Hello everyone welcome to the meeting.';
    expect(transcriptWordCount(transcript)).toBe(8);
  });

  test('returns 0 for an empty JSON array', () => {
    expect(transcriptWordCount('[]')).toBe(0);
  });

  test('returns 0 for a JSON array whose entries all have empty text', () => {
    const transcript = JSON.stringify([{ startTime: '00:00:00', text: '' }, { startTime: '00:00:05', text: '   ' }]);
    expect(transcriptWordCount(transcript)).toBe(0);
  });

  test('returns 0 for an empty string', () => {
    expect(transcriptWordCount('')).toBe(0);
  });

  test('falls back to plain-text counting on malformed/non-array JSON', () => {
    expect(transcriptWordCount('not valid json at all')).toBe(5);
  });
});

describe('assertTranscriptSubstantial', () => {
  test('throws when word count is below the minimum', () => {
    const shortTranscript = 'only a few words here';
    expect(() =>
      assertTranscriptSubstantial(shortTranscript, 'Test Session', { minWords: 100 }),
    ).toThrow(
      'Transcript for Test Session is only 5 words (minimum 100); pass --allow-short-transcript to override',
    );
  });

  test('does not throw when allowShort is true, regardless of word count', () => {
    expect(() =>
      assertTranscriptSubstantial('short', 'Test Session', { minWords: 100, allowShort: true }),
    ).not.toThrow();
  });

  test('does not throw when word count meets the minimum', () => {
    const words = new Array(150).fill('word').join(' ');
    expect(() =>
      assertTranscriptSubstantial(words, 'Test Session', { minWords: 100 }),
    ).not.toThrow();
  });

  test('uses a default minimum of 100 words when not specified', () => {
    expect(() => assertTranscriptSubstantial('short transcript', 'Test Session')).toThrow(
      /minimum 100/,
    );
  });
});

describe('generateMinutes', () => {
  beforeEach(() => {
    mockGenerateContent.mockClear();
    mockCreate.mockClear();
  });

  test('throws on an empty transcript before calling any API client', async () => {
    initializeGemini('fake-api-key');

    await expect(generateMinutes('', 'Test Session')).rejects.toThrow(
      'Cannot generate minutes for Test Session: transcript is empty',
    );
    expect(mockGenerateContent).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('throws on a transcript that is a JSON empty array before calling any API client', async () => {
    initializeGemini('fake-api-key');

    await expect(generateMinutes('[]', 'Test Session')).rejects.toThrow(
      'Cannot generate minutes for Test Session: transcript has no entries',
    );
    expect(mockGenerateContent).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
