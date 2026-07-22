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
  normalizeMinutesCorrections,
  applyCorrections,
  applyLiteralCorrections,
  splitUnits,
  numberUnits,
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

describe('splitUnits / numberUnits', () => {
  test('splits plain-line transcripts on newlines', () => {
    const result = splitUnits('line one\nline two\nline three');
    expect(result.kind).toBe('lines');
    expect(result.units).toEqual(['line one', 'line two', 'line three']);
    expect(result.data).toBeNull();
  });

  test('splits JSON-array transcripts by entry.text', () => {
    const transcript = JSON.stringify([{ text: 'hello' }, { text: 'world' }]);
    const result = splitUnits(transcript);
    expect(result.kind).toBe('json');
    expect(result.units).toEqual(['hello', 'world']);
    expect(result.data).toEqual([{ text: 'hello' }, { text: 'world' }]);
  });

  test('numberUnits prefixes each unit with its 1-based line number', () => {
    expect(numberUnits('foo\nbar')).toBe('1: foo\n2: bar');
  });
});

describe('normalizeCorrections', () => {
  test('filters invalid entries, deduplicates by line+from, and caps at 200', () => {
    const valid = Array.from({ length: 205 }, (_, i) => ({ line: i + 1, from: `wrong-${i}`, to: `right-${i}` }));
    const result = normalizeCorrections([
      null,
      { line: 1, from: '', to: 'x' },
      { line: 1, from: 'a', to: 'cd' },
      { line: 1, from: 'same', to: 'same' },
      { from: 'no-line', to: 'x' },
      { line: 0, from: 'bad-line', to: 'x' },
      valid[0],
      { line: valid[0].line, from: valid[0].from, to: 'duplicate' },
      ...valid.slice(1),
    ]);
    expect(result).toHaveLength(200);
    expect(result[0]).toEqual(valid[0]);
  });

  test('tolerates a wrapping object', () => {
    expect(normalizeCorrections({ corrections: [{ line: 3, from: 'wrong', to: 'right' }] }))
      .toEqual([{ line: 3, from: 'wrong', to: 'right' }]);
  });

  test('drops corrections whose "to" introduces a non-Latin script not present in "from"', () => {
    const result = normalizeCorrections([
      { line: 1, from: "Ying Zheng's", to: "Ying镇's" },
      { line: 2, from: 'Bob', to: 'Rob' },
    ]);
    expect(result).toEqual([{ line: 2, from: 'Bob', to: 'Rob' }]);
  });

  test('keeps the same "from" on two different lines with different "to" (no longer conflicting)', () => {
    const result = normalizeCorrections([
      { line: 1, from: 'cache', to: 'CACH' },
      { line: 9, from: 'cache', to: 'cache-line' },
    ]);
    expect(result).toEqual([
      { line: 1, from: 'cache', to: 'CACH' },
      { line: 9, from: 'cache', to: 'cache-line' },
    ]);
  });
});

describe('applyCorrections', () => {
  test('returns { text, appliedCount, applied } and skips absent sources', () => {
    const result = applyCorrections('a.b then a.b', [
      { line: 1, from: 'a.b', to: 'QUIC' },
      { line: 1, from: 'absent', to: 'unused' },
    ]);
    expect(result).toEqual({ text: 'QUIC then QUIC', appliedCount: 1, applied: [{ line: 1, from: 'a.b', to: 'QUIC' }] });
  });

  test('does not alter "t\'s" embedded inside other words on the same line', () => {
    const result = applyCorrections("it's let's go", [{ line: 1, from: "t's", to: 'TEAS' }]);
    expect(result.text).toBe("it's let's go");
    expect(result.appliedCount).toBe(0);
  });

  test('edits a standalone word matched on a word boundary', () => {
    const result = applyCorrections("well t's a thing", [{ line: 1, from: "t's", to: 'TEAS' }]);
    expect(result.text).toBe('well TEAS a thing');
    expect(result.appliedCount).toBe(1);
  });

  test('edits only the cited line, leaving an identical word on another line untouched', () => {
    const transcript = ['line with cache one', 'line two', 'line three', 'line four', 'line with cache nine'].join('\n');
    const result = applyCorrections(transcript, [{ line: 1, from: 'cache', to: 'CACH' }]);
    const lines = result.text.split('\n');
    expect(lines[0]).toBe('line with CACH one');
    expect(lines[4]).toBe('line with cache nine');
    expect(result.appliedCount).toBe(1);
  });

  test('recovers from an off-by-one line citation via the +/-2 window', () => {
    const transcript = ['one', 'two', 'three IS-IS target', 'four', 'five'].join('\n');
    const result = applyCorrections(transcript, [{ line: 2, from: 'IS-IS target', to: 'ISIS target' }]);
    expect(result.text.split('\n')[2]).toBe('three ISIS target');
    expect(result.appliedCount).toBe(1);
    expect(result.applied).toEqual([{ line: 3, from: 'IS-IS target', to: 'ISIS target' }]);
  });

  test('skips a correction whose "from" is nowhere near the cited line', () => {
    const transcript = ['one', 'two', 'three', 'four', 'five', 'six', 'target here'].join('\n');
    const result = applyCorrections(transcript, [{ line: 1, from: 'target here', to: 'x' }]);
    expect(result.text).toBe(transcript);
    expect(result.appliedCount).toBe(0);
  });

  test('supports deletion via to: ""', () => {
    const result = applyCorrections('hello filler word', [{ line: 1, from: 'filler', to: '' }]);
    expect(result.text).toBe('hello  word');
    expect(result.appliedCount).toBe(1);
  });

  test('edits the correct entry.text in a JSON-array transcript and re-serializes valid JSON', () => {
    const transcript = JSON.stringify([{ text: 'hello cache' }, { text: 'goodbye cache' }]);
    const result = applyCorrections(transcript, [{ line: 2, from: 'cache', to: 'CACHE' }]);
    const parsed = JSON.parse(result.text);
    expect(parsed).toEqual([{ text: 'hello cache' }, { text: 'goodbye CACHE' }]);
    expect(result.appliedCount).toBe(1);
  });

  test('regression: ISIS, OSFPF, and multi-word corrections still apply on their lines', () => {
    const transcript = ['Discussion of ISIS routing', 'we saw an OSFPF issue', 'the CS and P was sent'].join('\n');
    const result = applyCorrections(transcript, [
      { line: 1, from: 'ISIS', to: 'IS-IS' },
      { line: 2, from: 'OSFPF', to: 'OSPF' },
      { line: 3, from: 'CS and P', to: 'CSNP' },
    ]);
    expect(result.text.split('\n')).toEqual([
      'Discussion of IS-IS routing',
      'we saw an OSPF issue',
      'the CSNP was sent',
    ]);
    expect(result.appliedCount).toBe(3);
  });
});

describe('normalizeMinutesCorrections', () => {
  test('filters invalid entries, deduplicates by from, and caps at 200', () => {
    const valid = Array.from({ length: 205 }, (_, i) => ({ from: `wrong-${i}`, to: `right-${i}` }));
    const result = normalizeMinutesCorrections([
      null,
      { from: '', to: 'x' },
      { from: 'a', to: 'cd' },
      { from: 'same', to: 'same' },
      valid[0],
      { from: valid[0].from, to: 'duplicate' },
      ...valid.slice(1),
    ]);
    expect(result).toHaveLength(200);
    expect(result[0]).toEqual(valid[0]);
  });

  test('tolerates a wrapping object', () => {
    expect(normalizeMinutesCorrections({ corrections: [{ from: 'wrong', to: 'right' }] }))
      .toEqual([{ from: 'wrong', to: 'right' }]);
  });

  test('drops corrections whose "to" introduces a non-Latin script not present in "from"', () => {
    const result = normalizeMinutesCorrections([
      { from: "Ying Zheng's", to: "Ying镇's" },
      { from: 'Bob', to: 'Rob' },
    ]);
    expect(result).toEqual([{ from: 'Bob', to: 'Rob' }]);
  });
});

describe('applyLiteralCorrections', () => {
  test('applies a {from,to} globally with word boundaries', () => {
    const result = applyLiteralCorrections('Martin Thompson spoke. Later, Thompson replied.', [
      { from: 'Thompson', to: 'Thomson' },
    ]);
    expect(result.text).toBe('Martin Thomson spoke. Later, Thomson replied.');
    expect(result.applied).toEqual([{ from: 'Thompson', to: 'Thomson' }]);
  });

  test('does not match a substring embedded in another word', () => {
    const result = applyLiteralCorrections('Thompsonville is not Thompson', [
      { from: 'Thompson', to: 'Thomson' },
    ]);
    expect(result.text).toBe('Thompsonville is not Thomson');
  });

  test('leaves text untouched and reports no applied entries when "from" is absent', () => {
    const result = applyLiteralCorrections('Nothing to see here', [
      { from: 'Thompson', to: 'Thomson' },
    ]);
    expect(result.text).toBe('Nothing to see here');
    expect(result.applied).toEqual([]);
  });

  test('applies multiple corrections in sequence', () => {
    const result = applyLiteralCorrections('Bob and Alice', [
      { from: 'Bob', to: 'Rob' },
      { from: 'Alice', to: 'Eve' },
    ]);
    expect(result.text).toBe('Rob and Eve');
    expect(result.applied).toEqual([{ from: 'Bob', to: 'Rob' }, { from: 'Alice', to: 'Eve' }]);
  });

  test('treats a null/empty "to" as deletion', () => {
    const result = applyLiteralCorrections('hello filler word', [{ from: 'filler', to: '' }]);
    expect(result.text).toBe('hello  word');
    expect(result.applied).toEqual([{ from: 'filler', to: '' }]);
  });
});

test.each([
  '```json\n[{"line":1,"from":"quick","to":"QUIC"}]\n```',
  '[{"line":1,"from":"quick","to":"QUIC"}]',
])('getCorrectionsFromGemini parses JSON and accumulates usage', async responseText => {
  mockGenerateContent.mockResolvedValueOnce({
    response: {
      text: () => responseText,
      usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 8 },
    },
  });
  const usage = { inputTokens: 0, outputTokens: 0, model: 'gemini-3.5-flash' };
  const result = await getCorrectionsFromGemini('key', 'gemini-3.5-flash', 'quick', '', false, usage);
  expect(result).toEqual([{ line: 1, from: 'quick', to: 'QUIC' }]);
  expect(usage).toEqual({ inputTokens: 40, outputTokens: 8, model: 'gemini-3.5-flash' });
  const contents = mockGenerateContent.mock.calls.at(-1)[0];
  expect(contents.some(item => item.fileData)).toBe(false);
});

test('getCorrectionsFromGemini sends the transcript numbered by line', async () => {
  mockGenerateContent.mockResolvedValueOnce({
    response: { text: () => '[]', usageMetadata: null },
  });
  await getCorrectionsFromGemini('key', 'gemini-3.5-flash', 'foo\nbar', '', false, null);
  const prompt = mockGenerateContent.mock.calls.at(-1)[0][0].text;
  expect(prompt).toContain('1: foo\n2: bar');
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
