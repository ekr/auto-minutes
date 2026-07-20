/**
 * Tests for speaker-names.js: offset parsing/formatting and speaker-map application.
 */

import { jest } from '@jest/globals';

const mockGenerateContent = jest.fn();

jest.unstable_mockModule('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent: mockGenerateContent }),
  })),
}));

const { parseOffset, formatOffset, applySpeakerMap, normalizeSpeakerMap, extractJSON, getSpeakerMapFromGemini } = await import('./speaker-names.js');

describe('parseOffset', () => {
  test('parses a REST duration string like "12.340s"', () => {
    expect(parseOffset('12.340s')).toBeCloseTo(12.34);
  });

  test('parses a plain number of seconds', () => {
    expect(parseOffset(12.34)).toBeCloseTo(12.34);
  });

  test('parses a {seconds, nanos} duration object', () => {
    expect(parseOffset({ seconds: 12, nanos: 340000000 })).toBeCloseTo(12.34);
  });

  test('returns null (never NaN) for missing or unparseable input', () => {
    expect(parseOffset(undefined)).toBeNull();
    expect(parseOffset(null)).toBeNull();
    expect(parseOffset('not-a-duration')).toBeNull();
    expect(parseOffset({})).not.toBeNaN();
  });
});

describe('formatOffset', () => {
  test('formats seconds under a minute', () => {
    expect(formatOffset(12)).toBe('00:00:12');
  });

  test('formats hours/minutes/seconds', () => {
    expect(formatOffset(3723)).toBe('01:02:03');
  });
});

describe('normalizeSpeakerMap', () => {
  test('coerces bare numeric keys to "Speaker N"', () => {
    expect(normalizeSpeakerMap({ '1': 'Jane Smith' })).toEqual({ 'Speaker 1': 'Jane Smith' });
  });

  test('strips markdown bold markers from keys and trims values', () => {
    expect(normalizeSpeakerMap({ '**Speaker 2**': ' John Doe ' })).toEqual({ 'Speaker 2': 'John Doe' });
  });
});

describe('applySpeakerMap', () => {
  test('renames "Speaker N:" labels to bold names', () => {
    const result = applySpeakerMap('Speaker 1: Hello everyone.', { 'Speaker 1': 'Jane Smith' });
    expect(result).toContain('**Jane Smith**: Hello everyone.');
  });

  test('preserves a leading "[HH:MM:SS] " timestamp prefix while renaming the label', () => {
    const result = applySpeakerMap('[00:14:32] Speaker 1: Hello everyone.', { 'Speaker 1': 'Jane Smith' });
    expect(result).toContain('[00:14:32] **Jane Smith**: Hello everyone.');
  });
});

describe('extractJSON', () => {
  test('extracts JSON from a ```json fenced block', () => {
    const text = 'Here you go:\n```json\n{"Speaker 1": "Jane"}\n```\n';
    expect(extractJSON(text)).toEqual({ 'Speaker 1': 'Jane' });
  });

  test('extracts bare JSON braces with no fencing', () => {
    expect(extractJSON('prefix {"Speaker 1": "Jane"} suffix')).toEqual({ 'Speaker 1': 'Jane' });
  });

  test('throws when no JSON braces are found', () => {
    expect(() => extractJSON('no json here')).toThrow();
  });
});

describe('getSpeakerMapFromGemini', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
  });

  test('parses the mapping and records token usage; sends no fileData when file is null (text-only)', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify({ 'Speaker 1': 'Jane Smith' }),
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 },
      },
    });

    const usage = {};
    const result = await getSpeakerMapFromGemini('key', 'gemini-3.5-flash', null, 'Speaker 1: hi', null, false, usage);

    expect(result).toEqual({ 'Speaker 1': 'Jane Smith' });
    expect(usage).toEqual({ inputTokens: 120, outputTokens: 30 });

    const contents = mockGenerateContent.mock.calls[0][0];
    expect(contents.some(c => c.fileData)).toBe(false);
  });
});
