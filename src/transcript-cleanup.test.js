import { jest } from '@jest/globals';

const mockGenerateContent = jest.fn();
jest.unstable_mockModule('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockImplementation(() => ({ generateContent: mockGenerateContent })),
  })),
}));

const {
  buildCleanupReference,
  getCorrectionsFromGemini,
  normalizeCorrections,
  applyCorrections,
  parseJson,
} = await import('./transcript-cleanup.js');

test('buildCleanupReference includes names, active drafts, and slide titles', () => {
  const reference = buildCleanupReference({
    slidesAndBluesheet: {
      bluesheet: '2 attendees.\nJane Smith\tExample\nJohn Doe\tExample',
      slides: [{ title: 'QUIC Extensions' }],
    },
    wgDocuments: [{ Name: 'draft-ietf-quic-example', 'Status in the IETF process': 'Active' }],
  });
  expect(reference).toContain('Jane Smith');
  expect(reference).toContain('draft-ietf-quic-example');
  expect(reference).toContain('QUIC Extensions');
  expect(buildCleanupReference(null)).toBe('');
});

test('normalizeCorrections filters invalid entries, deduplicates, and caps at 200', () => {
  const valid = Array.from({ length: 205 }, (_, i) => ({ from: `wrong-${i}`, to: `right-${i}` }));
  const result = normalizeCorrections([
    null,
    { from: '', to: 'x' },
    { from: 'ab', to: 'cd' },
    { from: 'same', to: 'same' },
    valid[0],
    { from: valid[0].from, to: 'duplicate' },
    ...valid.slice(1),
  ]);
  expect(result).toHaveLength(200);
  expect(result[0]).toEqual(valid[0]);
});

test('normalizeCorrections tolerates a wrapping object', () => {
  expect(normalizeCorrections({ corrections: [{ from: 'wrong', to: 'right' }] }))
    .toEqual([{ from: 'wrong', to: 'right' }]);
});

test('applyCorrections replaces every literal occurrence and skips absent sources', () => {
  const result = applyCorrections('a.b then a.b', [
    { from: 'a.b', to: 'QUIC' },
    { from: 'absent', to: 'unused' },
  ]);
  expect(result).toEqual({ text: 'QUIC then QUIC', appliedCount: 1, applied: [{ from: 'a.b', to: 'QUIC' }] });
});

test.each([
  '```json\n[{"from":"quick","to":"QUIC"}]\n```',
  '[{"from":"quick","to":"QUIC"}]',
])('getCorrectionsFromGemini parses JSON and accumulates usage', async responseText => {
  mockGenerateContent.mockResolvedValueOnce({
    response: {
      text: () => responseText,
      usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 8 },
    },
  });
  const usage = { inputTokens: 0, outputTokens: 0, model: 'gemini-3.5-flash' };
  const result = await getCorrectionsFromGemini('key', 'gemini-3.5-flash', 'quick', '', false, usage);
  expect(result).toEqual([{ from: 'quick', to: 'QUIC' }]);
  expect(usage).toEqual({ inputTokens: 40, outputTokens: 8, model: 'gemini-3.5-flash' });
  const contents = mockGenerateContent.mock.calls.at(-1)[0];
  expect(contents.some(item => item.fileData)).toBe(false);
});

describe('parseJson', () => {
  test('parses clean JSON objects and arrays', () => {
    expect(parseJson('{"a": 1}')).toEqual({ a: 1 });
    expect(parseJson('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  test('parses JSON with extra trailing brace (the feared Gemini extra brace)', () => {
    const raw = `{\n  "transcriptInstructions": "Usama Saleem is actually Muhammad Usama Sardar",\n  "minutesInstructions": ""\n}\n}`;
    expect(parseJson(raw)).toEqual({
      transcriptInstructions: "Usama Saleem is actually Muhammad Usama Sardar",
      minutesInstructions: "",
    });
  });

  test('parses markdown code blocks with extra trailing brace', () => {
    const raw = '```json\n{\n  "transcriptInstructions": "foo",\n  "minutesInstructions": "bar"\n}\n}\n```';
    expect(parseJson(raw)).toEqual({
      transcriptInstructions: "foo",
      minutesInstructions: "bar",
    });
  });

  test('parses JSON arrays with extra trailing bracket', () => {
    const raw = '[{"from":"quick","to":"QUIC"}]]';
    expect(parseJson(raw)).toEqual([{ from: 'quick', to: 'QUIC' }]);
  });

  test('parses JSON with surrounding non-JSON text', () => {
    const raw = 'Here is your JSON response:\n{"key": "value"}\nHope this helps!';
    expect(parseJson(raw)).toEqual({ key: 'value' });
  });

  test('throws on unparseable non-JSON text', () => {
    expect(() => parseJson('no json here')).toThrow(SyntaxError);
  });
});
