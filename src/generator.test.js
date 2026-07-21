/**
 * Tests for the minutes generator's transcript validation and generation guards,
 * and bluesheet participant-name extraction.
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
  amendMinutes,
  initializeGemini,
  extractParticipantNames,
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

describe('amendMinutes', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockCreate.mockReset();
    initializeGemini('fake-api-key');
  });

  test('sends both existing minutes and reviewer comments to the model', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => '# Revised minutes',
        usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 7 },
      },
    });

    await amendMinutes('# Existing minutes\n\n## Summary\nOld text', 'Correct the decision to Foo.', '6LO');

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    const prompt = mockGenerateContent.mock.calls[0][0];
    expect(prompt).toContain('# Existing minutes');
    expect(prompt).toContain('Correct the decision to Foo.');
    expect(prompt).toContain('Output only the revised minutes.');
  });

  test.each([
    ['', 'a comment', 'existing minutes are empty'],
    ['# Minutes', '  \n', 'comments are empty'],
  ])('rejects empty inputs before calling the API', async (minutes, comments, message) => {
    await expect(amendMinutes(minutes, comments, '6LO')).rejects.toThrow(message);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  test('strips a surrounding Markdown code fence', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => '```markdown\n# Revised minutes\n```',
        usageMetadata: {},
      },
    });

    const result = await amendMinutes('# Minutes', 'Fix typo', '6LO');
    expect(result.text).toBe('# Revised minutes');
  });

  test('returns populated token usage', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => '# Revised minutes',
        usageMetadata: { promptTokenCount: 123, candidatesTokenCount: 45 },
      },
    });

    const result = await amendMinutes('# Minutes', 'Fix typo', '6LO', false, 'gemini-test');
    expect(result.usage).toEqual({ model: 'gemini-test', inputTokens: 123, outputTokens: 45 });
  });
});

describe('extractParticipantNames', () => {
  test('returns an empty array when bluesheet is null/undefined/empty', () => {
    expect(extractParticipantNames(null)).toEqual([]);
    expect(extractParticipantNames(undefined)).toEqual([]);
    expect(extractParticipantNames('')).toEqual([]);
  });

  test('parses tab-separated attendee names after the "attendees" header', () => {
    const bluesheet = [
      'Bluesheet for IETF-124: privacypass  Monday 09:30',
      '================================================================',
      '3 attendees.',
      '',
      'Jane Smith\tExample Corp',
      'John Doe\tAcme Inc',
      'Alex Lee\tOther Org',
    ].join('\n');

    expect(extractParticipantNames(bluesheet)).toEqual(['Jane Smith', 'John Doe', 'Alex Lee']);
  });

  test('parses names separated by two-or-more spaces instead of a tab', () => {
    const bluesheet = [
      '2 attendees.',
      'Jane Smith    Example Corp',
      'John Doe    Acme Inc',
    ].join('\n');

    expect(extractParticipantNames(bluesheet)).toEqual(['Jane Smith', 'John Doe']);
  });

  test('deduplicates repeated names', () => {
    const bluesheet = [
      'attendees.',
      'Jane Smith\tExample Corp',
      'Jane Smith\tExample Corp (second sign-in)',
    ].join('\n');

    expect(extractParticipantNames(bluesheet)).toEqual(['Jane Smith']);
  });

  test('stops collecting at a "===" or "---" separator line (variant formats)', () => {
    const bluesheet = [
      'attendees.',
      'Jane Smith\tExample Corp',
      '----------------------------------------',
      'This is not a name, it is trailing text.',
    ].join('\n');

    expect(extractParticipantNames(bluesheet)).toEqual(['Jane Smith']);
  });

  test('returns an empty array when there is no "attendees" header', () => {
    const bluesheet = 'Jane Smith\tExample Corp\nJohn Doe\tAcme Inc';
    expect(extractParticipantNames(bluesheet)).toEqual([]);
  });

  test('ignores blank lines and names too short to be real (<= 2 chars)', () => {
    const bluesheet = [
      'attendees.',
      '',
      'Jo\tShort Corp',
      'Jane Smith\tExample Corp',
    ].join('\n');

    expect(extractParticipantNames(bluesheet)).toEqual(['Jane Smith']);
  });
});
