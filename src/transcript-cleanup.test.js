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
    { from: valid[0].from, to: valid[0].to },
    ...valid.slice(1),
  ]);
  expect(result).toHaveLength(200);
  expect(result[0]).toEqual(valid[0]);
});

test('normalizeCorrections tolerates a wrapping object', () => {
  expect(normalizeCorrections({ corrections: [{ from: 'wrong', to: 'right' }] }))
    .toEqual([{ from: 'wrong', to: 'right' }]);
});

test('applyCorrections respects word boundaries (does not rewrite "it\'s" or "let\'s" for "t\'s", replaces standalone)', () => {
  const result = applyCorrections("it's time for let's go and t's here", [
    { from: "t's", to: "TEAS" },
  ]);
  expect(result.text).toBe("it's time for let's go and TEAS here");
  expect(result.appliedCount).toBe(1);
  expect(result.applied).toEqual([{ from: "t's", to: "TEAS" }]);
});

test('normalizeCorrections and applyCorrections handle common-word guard and context anchoring', () => {
  // Global common word without context is dropped
  const unanchored = normalizeCorrections([{ from: 'cache', to: 'CACH' }]);
  expect(unanchored).toEqual([]);

  // Common word with context is kept and anchored
  const contextStr = 'the complete SNP is called cache';
  const anchored = normalizeCorrections([{ from: 'cache', to: 'CACH', context: contextStr }]);
  expect(anchored).toEqual([{ from: 'cache', to: 'CACH', context: contextStr }]);

  const transcript = 'We need to clear the cache. the complete SNP is called cache. Also cache management.';
  const appliedResult = applyCorrections(transcript, anchored);
  expect(appliedResult.text).toBe('We need to clear the cache. the complete SNP is called CACH. Also cache management.');
  expect(appliedResult.appliedCount).toBe(1);
  expect(appliedResult.applied).toEqual(anchored);
});

test('normalizeCorrections drops conflicting entries mapping to distinct targets', () => {
  const raw = [
    { from: 'FlexAlgo', to: 'flex-algo' },
    { from: 'FlexAlgo', to: 'Flex-Algo' },
    { from: 'OSFPF', to: 'OSPF' },
  ];
  const normalized = normalizeCorrections(raw);
  expect(normalized).toEqual([{ from: 'OSFPF', to: 'OSPF' }]);
});

test('normalizeCorrections drops entries failing the charset guard', () => {
  const raw = [
    { from: "Ying Zheng's", to: "Ying镇's" },
    { from: 'Francois', to: 'François' },
  ];
  const normalized = normalizeCorrections(raw);
  expect(normalized).toEqual([{ from: 'Francois', to: 'François' }]);
});

test('normalizeCorrections drops common words when context does not contain from or equals from', () => {
  const noMatch = normalizeCorrections([{ from: 'cache', to: 'CACH', context: 'some phrase without target' }]);
  expect(noMatch).toEqual([]);

  const exactMatch = normalizeCorrections([{ from: 'cache', to: 'CACH', context: 'cache' }]);
  expect(exactMatch).toEqual([]);

  const paddedMatch = normalizeCorrections([{ from: 'cache', to: 'CACH', context: ' cache ' }]);
  expect(paddedMatch).toEqual([]);
});

test('applyCorrections does not perform unanchored replacement when context is invalid or missing from text', () => {
  const transcript = 'We need to clear the cache everywhere.';

  // Invalid context (does not contain 'from')
  const res1 = applyCorrections(transcript, [
    { from: 'cache', to: 'CACH', context: 'unrelated context phrase' },
  ]);
  expect(res1.text).toBe(transcript);
  expect(res1.appliedCount).toBe(0);
  expect(res1.applied).toEqual([]);

  // Missing context (contains 'from' but context phrase is not in transcript)
  const res2 = applyCorrections(transcript, [
    { from: 'cache', to: 'CACH', context: 'the complete SNP is called cache' },
  ]);
  expect(res2.text).toBe(transcript);
  expect(res2.appliedCount).toBe(0);
  expect(res2.applied).toEqual([]);
});

test('applyCorrections avoids substring over-replacement when applying anchored context', () => {
  const transcript = 'We need to clear the caches.';
  const res = applyCorrections(transcript, [
    { from: 'cache', to: 'CACH', context: 'the cache' },
  ]);
  expect(res.text).toBe('We need to clear the caches.');
  expect(res.appliedCount).toBe(0);
  expect(res.applied).toEqual([]);
});

test('applyCorrections handles distinctive term replacements as regressions', () => {
  const raw = [
    { from: 'ISIS', to: 'IS-IS' },
    { from: 'OSFPF', to: 'OSPF' },
    { from: 'CS and P', to: 'CSNP' },
  ];
  const normalized = normalizeCorrections(raw);
  expect(normalized).toHaveLength(3);

  const transcript = 'The ISIS protocol and OSFPF router with CS and P packets.';
  const result = applyCorrections(transcript, normalized);
  expect(result.text).toBe('The IS-IS protocol and OSPF router with CSNP packets.');
  expect(result.appliedCount).toBe(3);
  expect(result.applied).toHaveLength(3);
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

