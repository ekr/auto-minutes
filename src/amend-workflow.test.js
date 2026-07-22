import { jest } from '@jest/globals';
import { amendCachedSessions } from './amend-workflow.js';

function makeDependencies(overrides = {}) {
  return {
    loadCacheManifest: jest.fn(),
    getCachedMinutes: jest.fn(),
    getCachedMetadata: jest.fn().mockResolvedValue(null),
    fetchContextForSession: jest.fn().mockResolvedValue({
      slidesAndBluesheet: null,
      wgDocuments: [],
    }),
    splitAmendComments: jest.fn((comments) => Promise.resolve({
      transcriptInstructions: '',
      minutesInstructions: comments,
    })),
    getTranscriptCorrections: jest.fn().mockResolvedValue([]),
    filterTranscriptCorrections: jest.fn((corrections) => Promise.resolve(corrections)),
    normalizeCorrections: jest.fn((raw) => (Array.isArray(raw) ? raw.map(({ from, to }) => ({ from, to })) : [])),
    applyCorrections: jest.fn((transcript, corrections) => ({
      text: transcript,
      appliedCount: 0,
      applied: [],
    })),
    getTranscriptCachePath: jest.fn((sessionId) => `cache/transcripts/${sessionId}.md`),
    downloadTranscript: jest.fn().mockResolvedValue('Downloaded transcript'),
    readFile: jest.fn().mockResolvedValue('Cached transcript text'),
    writeFile: jest.fn().mockResolvedValue(),
    existsSync: jest.fn().mockReturnValue(true),
    amendMinutes: jest.fn(),
    saveCachedMinutes: jest.fn(),
    recordUsage: jest.fn(),
    logger: { log: jest.fn(), error: jest.fn() },
    ...overrides,
  };
}

test('amends every cached session using case-insensitive WG matching without changing the manifest', async () => {
  const manifest = [
    { sessionName: 'OTHER', sessions: [{ sessionId: 'other-1' }] },
    {
      sessionName: '6lo',
      sessions: [{ sessionId: '6lo-1' }, { sessionId: '6lo-2' }],
    },
  ];
  const originalManifest = structuredClone(manifest);
  const existing = { '6lo-1': '# First', '6lo-2': '# Second' };
  const dependencies = makeDependencies({
    loadCacheManifest: jest.fn().mockResolvedValue(manifest),
    getCachedMinutes: jest.fn((meetingId, sessionId) => existing[sessionId]),
    amendMinutes: jest.fn((minutes, comments) => ({
      text: `${minutes}\n\nAmended: ${comments}`,
      usage: { model: 'gemini-test', inputTokens: 10, outputTokens: 5 },
    })),
  });

  await amendCachedSessions({
    meetingId: 123,
    groupName: '6LO',
    comments: 'Correct both sessions',
    modelName: 'gemini-test',
    dependencies,
  });

  expect(dependencies.loadCacheManifest).toHaveBeenCalledWith(123);
  expect(dependencies.getCachedMinutes.mock.calls).toEqual([
    [123, '6lo-1'],
    [123, '6lo-2'],
  ]);
  expect(dependencies.getCachedMetadata.mock.calls).toEqual([
    [123, '6lo-1'],
    [123, '6lo-2'],
  ]);
  expect(dependencies.saveCachedMinutes.mock.calls).toEqual([
    [123, '6lo-1', '# First\n\nAmended: Correct both sessions'],
    [123, '6lo-2', '# Second\n\nAmended: Correct both sessions'],
  ]);
  expect(dependencies.amendMinutes).toHaveBeenCalledTimes(2);
  expect(dependencies.recordUsage).toHaveBeenCalledTimes(2);
  expect(dependencies.logger.log.mock.calls).toEqual([
    ['Amended: 6lo-1'],
    ['Amended: 6lo-2'],
  ]);
  expect(manifest).toEqual(originalManifest);
});

test('uses full live context including WG documents for an amendment', async () => {
  const liveContext = {
    slidesAndBluesheet: {
      slides: [{ title: 'Live slides', url: 'https://example.test/live' }],
      bluesheet: 'Jane Smith\tExample Corp',
    },
    wgDocuments: [{
      Name: 'draft-ietf-6lo-example',
      Title: 'Example',
      'Status in the IETF process': 'I-D Exists',
    }],
  };
  const dependencies = makeDependencies({
    loadCacheManifest: jest.fn().mockResolvedValue([{
      sessionName: '6LO',
      sessions: [{ sessionId: 'IETF126-6LO-20250721-0900' }],
    }]),
    getCachedMinutes: jest.fn().mockResolvedValue('# Existing'),
    fetchContextForSession: jest.fn().mockResolvedValue(liveContext),
    amendMinutes: jest.fn().mockResolvedValue({
      text: '# Revised',
      usage: { model: 'gemini-test', inputTokens: 10, outputTokens: 5 },
    }),
  });

  await amendCachedSessions({
    meetingId: 126,
    groupName: '6lo',
    comments: 'Correct it',
    verbose: true,
    dependencies,
  });

  expect(dependencies.fetchContextForSession).toHaveBeenCalledWith(
    { sessionId: 'IETF126-6LO-20250721-0900', sessionName: '6LO' },
    true,
  );
  expect(dependencies.getCachedMetadata).not.toHaveBeenCalled();
  expect(dependencies.amendMinutes).toHaveBeenCalledWith(
    '# Existing', 'Correct it', '6LO', true, null, liveContext, null,
  );
});

test('reconstructs cached slides and bluesheet context for each amendment', async () => {
  const bluesheetText = '2 attendees.\n\nJane Smith\tExample Corp\nJohn Doe\tExample Org';
  const slides = [{ title: 'Protocol Updates', url: 'https://example.test/slides' }];
  const dependencies = makeDependencies({
    loadCacheManifest: jest.fn().mockResolvedValue([{
      sessionName: '6LO',
      sessions: [{ sessionId: '6lo-1' }],
    }]),
    getCachedMinutes: jest.fn().mockResolvedValue('# Existing'),
    getCachedMetadata: jest.fn().mockResolvedValue({
      slides,
      bluesheetText,
      polls: [{ text: 'Adopt?', yes: 10, no: 2 }],
      chat: [{ author: 'Alice', text: 'Correction' }],
    }),
    amendMinutes: jest.fn().mockResolvedValue({
      text: '# Revised',
      usage: { model: 'gemini-test', inputTokens: 10, outputTokens: 5 },
    }),
  });

  await amendCachedSessions({
    meetingId: 123,
    groupName: '6LO',
    comments: 'Correct the speaker name',
    dependencies,
  });

  expect(dependencies.amendMinutes).toHaveBeenCalledWith(
    '# Existing',
    'Correct the speaker name',
    '6LO',
    false,
    null,
    {
      slidesAndBluesheet: { slides, bluesheet: bluesheetText },
      wgDocuments: [],
      polls: [{ text: 'Adopt?', yes: 10, no: 2 }],
      chat: [{ author: 'Alice', text: 'Correction' }],
    },
    null,
  );
});

test('falls back to cached context when live context fetch throws', async () => {
  const metadata = {
    slides: [{ title: 'Cached slides', url: 'https://example.test/cached' }],
    bluesheetText: 'John Doe\tExample Org',
  };
  const dependencies = makeDependencies({
    loadCacheManifest: jest.fn().mockResolvedValue([{
      sessionName: '6LO',
      sessions: [{ sessionId: 'IETF126-6LO-20250721-0900' }],
    }]),
    getCachedMinutes: jest.fn().mockResolvedValue('# Existing'),
    fetchContextForSession: jest.fn().mockRejectedValue(new Error('network failed')),
    getCachedMetadata: jest.fn().mockResolvedValue(metadata),
    amendMinutes: jest.fn().mockResolvedValue({
      text: '# Revised',
      usage: { model: 'gemini-test', inputTokens: 10, outputTokens: 5 },
    }),
  });

  await amendCachedSessions({
    meetingId: 126,
    groupName: '6LO',
    comments: 'Fix it',
    dependencies,
  });

  expect(dependencies.amendMinutes).toHaveBeenCalledWith(
    '# Existing',
    'Fix it',
    '6LO',
    false,
    null,
    {
      slidesAndBluesheet: {
        slides: metadata.slides,
        bluesheet: metadata.bluesheetText,
      },
      wgDocuments: [],
      polls: [],
      chat: [],
    },
    null,
  );
  expect(dependencies.saveCachedMinutes).toHaveBeenCalledWith(126, 'IETF126-6LO-20250721-0900', '# Revised');
});

test('falls back to cached context when live slides and bluesheet are empty', async () => {
  const metadata = {
    slides: [{ title: 'Cached slides', url: 'https://example.test/cached' }],
    bluesheetText: 'John Doe\tExample Org',
  };
  const dependencies = makeDependencies({
    loadCacheManifest: jest.fn().mockResolvedValue([{
      sessionName: '6LO',
      sessions: [{ sessionId: 'IETF126-6LO-20250721-0900' }],
    }]),
    getCachedMinutes: jest.fn().mockResolvedValue('# Existing'),
    fetchContextForSession: jest.fn().mockResolvedValue({
      slidesAndBluesheet: { slides: [], bluesheet: null },
      wgDocuments: [],
    }),
    getCachedMetadata: jest.fn().mockResolvedValue(metadata),
    amendMinutes: jest.fn().mockResolvedValue({
      text: '# Revised',
      usage: { model: 'gemini-test', inputTokens: 10, outputTokens: 5 },
    }),
  });

  await amendCachedSessions({
    meetingId: 126,
    groupName: '6LO',
    comments: 'Fix it',
    dependencies,
  });

  expect(dependencies.getCachedMetadata).toHaveBeenCalledWith(
    126,
    'IETF126-6LO-20250721-0900',
  );
  expect(dependencies.amendMinutes).toHaveBeenCalledWith(
    '# Existing',
    'Fix it',
    '6LO',
    false,
    null,
    {
      slidesAndBluesheet: {
        slides: metadata.slides,
        bluesheet: metadata.bluesheetText,
      },
      wgDocuments: [],
      polls: [],
      chat: [],
    },
    null,
  );
});

test('combines cached slides and bluesheet with live WG documents', async () => {
  const metadata = {
    slides: [{ title: 'Cached slides', url: 'https://example.test/cached' }],
    bluesheetText: 'John Doe\tExample Org',
  };
  const wgDocuments = [{
    Name: 'draft-ietf-6lo-example',
    Title: 'Example',
    'Status in the IETF process': 'I-D Exists',
  }];
  const dependencies = makeDependencies({
    loadCacheManifest: jest.fn().mockResolvedValue([{
      sessionName: '6LO',
      sessions: [{ sessionId: 'IETF126-6LO-20250721-0900' }],
    }]),
    getCachedMinutes: jest.fn().mockResolvedValue('# Existing'),
    fetchContextForSession: jest.fn().mockResolvedValue({
      slidesAndBluesheet: { slides: [], bluesheet: null },
      wgDocuments,
    }),
    getCachedMetadata: jest.fn().mockResolvedValue(metadata),
    amendMinutes: jest.fn().mockResolvedValue({
      text: '# Revised',
      usage: { model: 'gemini-test', inputTokens: 10, outputTokens: 5 },
    }),
  });

  await amendCachedSessions({
    meetingId: 126,
    groupName: '6LO',
    comments: 'Fix it',
    dependencies,
  });

  expect(dependencies.getCachedMetadata).toHaveBeenCalledWith(
    126,
    'IETF126-6LO-20250721-0900',
  );
  expect(dependencies.amendMinutes).toHaveBeenCalledWith(
    '# Existing',
    'Fix it',
    '6LO',
    false,
    null,
    {
      slidesAndBluesheet: {
        slides: metadata.slides,
        bluesheet: metadata.bluesheetText,
      },
      wgDocuments,
      polls: [],
      chat: [],
    },
    null,
  );
});

test.each([
  ['missing', jest.fn().mockResolvedValue(null)],
  ['unreadable', jest.fn().mockRejectedValue(new Error('invalid metadata'))],
])('keeps empty live context when cached metadata is %s', async (_description, getCachedMetadata) => {
  const dependencies = makeDependencies({
    loadCacheManifest: jest.fn().mockResolvedValue([{
      sessionName: '6LO',
      sessions: [{ sessionId: '6lo-1' }],
    }]),
    getCachedMinutes: jest.fn().mockResolvedValue('# Existing'),
    getCachedMetadata,
    amendMinutes: jest.fn().mockResolvedValue({
      text: '# Revised',
      usage: { model: 'gemini-test', inputTokens: 10, outputTokens: 5 },
    }),
  });

  await amendCachedSessions({
    meetingId: 123,
    groupName: '6LO',
    comments: 'Fix it',
    dependencies,
  });

  expect(dependencies.amendMinutes).toHaveBeenCalledWith(
    '# Existing', 'Fix it', '6LO', false, null,
    { slidesAndBluesheet: null, wgDocuments: [] }, null,
  );
});

test('reports a missing manifest as cached minutes that must be summarized first', async () => {
  const dependencies = makeDependencies({
    loadCacheManifest: jest.fn().mockRejectedValue(new Error('ENOENT')),
  });

  await expect(amendCachedSessions({
    meetingId: 123,
    groupName: '6LO',
    comments: 'Fix it',
    dependencies,
  })).rejects.toThrow('No cached minutes for 123; run --summarize first');

  expect(dependencies.getCachedMinutes).not.toHaveBeenCalled();
});

test('reports an absent WG and lists groups available in the manifest', async () => {
  const dependencies = makeDependencies({
    loadCacheManifest: jest.fn().mockResolvedValue([
      { sessionName: 'Zebra', sessions: [] },
      { sessionName: 'Alpha', sessions: [] },
    ]),
  });

  await expect(amendCachedSessions({
    meetingId: '2026-04-14',
    groupName: '6LO',
    comments: 'Fix it',
    dependencies,
  })).rejects.toThrow(
    'No cached minutes for 6LO in 2026-04-14; run --summarize first. Available: Alpha, Zebra',
  );

  expect(dependencies.getCachedMinutes).not.toHaveBeenCalled();
});

test('fails when a manifest session has no cached minutes file', async () => {
  const dependencies = makeDependencies({
    loadCacheManifest: jest.fn().mockResolvedValue([{
      sessionName: '6LO',
      sessions: [{ sessionId: 'missing' }],
    }]),
    getCachedMinutes: jest.fn().mockRejectedValue(
      new Error("ENOENT: no such file or directory, open 'cache/minutes/ietf123/missing.md'"),
    ),
  });

  await expect(amendCachedSessions({
    meetingId: 123,
    groupName: '6LO',
    comments: 'Fix it',
    dependencies,
  })).rejects.toThrow('Failed to amend 1 session(s): missing');

  expect(dependencies.amendMinutes).not.toHaveBeenCalled();
  expect(dependencies.saveCachedMinutes).not.toHaveBeenCalled();
  expect(dependencies.logger.error).toHaveBeenCalledWith(
    expect.stringContaining('Could not amend missing: ENOENT'),
  );
});

test('continues after a session fails, then reports the partial failure', async () => {
  const dependencies = makeDependencies({
    loadCacheManifest: jest.fn().mockResolvedValue([{
      sessionName: '6LO',
      sessions: [{ sessionId: 'bad' }, { sessionId: 'good' }],
    }]),
    getCachedMinutes: jest.fn()
      .mockRejectedValueOnce(new Error('cache read failed'))
      .mockResolvedValueOnce('# Good'),
    amendMinutes: jest.fn().mockResolvedValue({
      text: '# Revised good',
      usage: { model: 'claude-test', inputTokens: 4, outputTokens: 3 },
    }),
  });

  await expect(amendCachedSessions({
    meetingId: 123,
    groupName: '6LO',
    comments: 'Fix it',
    dependencies,
  })).rejects.toThrow('Failed to amend 1 session(s): bad');

  expect(dependencies.getCachedMinutes).toHaveBeenNthCalledWith(2, 123, 'good');
  expect(dependencies.saveCachedMinutes).toHaveBeenCalledWith(123, 'good', '# Revised good');
  expect(dependencies.logger.error).toHaveBeenCalledWith('Could not amend bad: cache read failed');
  expect(dependencies.logger.log).toHaveBeenCalledWith('Amended: good');
});

test('handles transcript instructions and rewrites existing cached transcript, passing diff to amendMinutes', async () => {
  const dependencies = makeDependencies({
    loadCacheManifest: jest.fn().mockResolvedValue([{
      sessionName: '6LO',
      sessions: [{ sessionId: '6lo-1' }],
    }]),
    splitAmendComments: jest.fn().mockResolvedValue({
      transcriptInstructions: 'Fix Bob to Rob',
      minutesInstructions: 'Update minutes writeup',
      usage: { model: 'test', inputTokens: 5, outputTokens: 2 },
    }),
    getCachedMinutes: jest.fn().mockResolvedValue('# Existing minutes'),
    existsSync: jest.fn().mockReturnValue(true),
    readFile: jest.fn().mockResolvedValue('Bob Smith discussed QUIC.'),
    getTranscriptCorrections: jest.fn().mockResolvedValue([{ from: 'Bob Smith', to: 'Rob Smith' }]),
    normalizeCorrections: jest.fn(raw => raw),
    applyCorrections: jest.fn().mockReturnValue({
      text: 'Rob Smith discussed QUIC.',
      appliedCount: 1,
      applied: [{ from: 'Bob Smith', to: 'Rob Smith' }],
    }),
    writeFile: jest.fn().mockResolvedValue(),
    amendMinutes: jest.fn().mockResolvedValue({
      text: '# Revised minutes',
      usage: { model: 'test', inputTokens: 10, outputTokens: 5 },
    }),
  });

  await amendCachedSessions({
    meetingId: 123,
    groupName: '6LO',
    comments: 'Fix Bob to Rob and update writeup',
    dependencies,
  });

  expect(dependencies.readFile).toHaveBeenCalledWith('cache/transcripts/6lo-1.md', 'utf8');
  expect(dependencies.writeFile).toHaveBeenCalledWith(
    'cache/transcripts/6lo-1.md',
    'Rob Smith discussed QUIC.',
    'utf8',
  );
  expect(dependencies.amendMinutes).toHaveBeenCalledWith(
    '# Existing minutes',
    'Update minutes writeup',
    '6LO',
    false,
    null,
    expect.anything(),
    '- "Bob Smith" → "Rob Smith"',
  );
});

test('runs filterTranscriptCorrections pass to filter out over-aggressive transcript edits', async () => {
  const filteredResult = [{ from: 'Bob Smith', to: 'Rob Smith' }];
  filteredResult.usage = { model: 'test', inputTokens: 4, outputTokens: 2 };
  const filterMock = jest.fn().mockResolvedValue(filteredResult);

  const dependencies = makeDependencies({
    loadCacheManifest: jest.fn().mockResolvedValue([{
      sessionName: '6LO',
      sessions: [{ sessionId: '6lo-1' }],
    }]),
    splitAmendComments: jest.fn().mockResolvedValue({
      transcriptInstructions: 'Fix Bob to Rob',
      minutesInstructions: 'Update minutes writeup',
    }),
    getCachedMinutes: jest.fn().mockResolvedValue('# Existing minutes'),
    existsSync: jest.fn().mockReturnValue(true),
    readFile: jest.fn().mockResolvedValue('Bob Smith discussed 6lo.'),
    getTranscriptCorrections: jest.fn().mockResolvedValue([
      { from: 'Bob Smith', to: 'Rob Smith' },
      { from: '6lo', to: '6LO' },
    ]),
    filterTranscriptCorrections: filterMock,
    normalizeCorrections: jest.fn(raw => (Array.isArray(raw) ? raw.map(({ from, to }) => ({ from, to })) : [])),
    applyCorrections: jest.fn().mockReturnValue({
      text: 'Rob Smith discussed 6lo.',
      appliedCount: 1,
      applied: [{ from: 'Bob Smith', to: 'Rob Smith' }],
    }),
    writeFile: jest.fn().mockResolvedValue(),
    amendMinutes: jest.fn().mockResolvedValue({
      text: '# Revised minutes',
    }),
  });

  await amendCachedSessions({
    meetingId: 123,
    groupName: '6LO',
    comments: 'Fix Bob to Rob and update writeup',
    dependencies,
  });

  expect(dependencies.filterTranscriptCorrections).toHaveBeenCalledWith(
    [
      { from: 'Bob Smith', to: 'Rob Smith' },
      { from: '6lo', to: '6LO' },
    ],
    'Fix Bob to Rob',
    '6LO',
    false,
    null,
  );
  expect(dependencies.applyCorrections).toHaveBeenCalledWith(
    'Bob Smith discussed 6lo.',
    [{ from: 'Bob Smith', to: 'Rob Smith' }],
  );
  expect(dependencies.recordUsage).toHaveBeenCalledWith({
    model: 'test',
    inputTokens: 4,
    outputTokens: 2,
  });
});


test('downloads transcript when no cached transcript exists and applies corrections', async () => {
  const dependencies = makeDependencies({
    loadCacheManifest: jest.fn().mockResolvedValue([{
      sessionName: '6LO',
      sessions: [{ sessionId: '6lo-1', recordingUrl: 'http://example.test' }],
    }]),
    splitAmendComments: jest.fn().mockResolvedValue({
      transcriptInstructions: 'Fix Bob to Rob',
      minutesInstructions: '',
    }),
    getCachedMinutes: jest.fn().mockResolvedValue('# Existing minutes'),
    existsSync: jest.fn().mockReturnValue(false),
    downloadTranscript: jest.fn().mockResolvedValue('Downloaded Bob Smith transcript.'),
    getTranscriptCorrections: jest.fn().mockResolvedValue([{ from: 'Bob Smith', to: 'Rob Smith' }]),
    normalizeCorrections: jest.fn(raw => raw),
    applyCorrections: jest.fn().mockReturnValue({
      text: 'Downloaded Rob Smith transcript.',
      appliedCount: 1,
      applied: [{ from: 'Bob Smith', to: 'Rob Smith' }],
    }),
    writeFile: jest.fn().mockResolvedValue(),
    amendMinutes: jest.fn().mockResolvedValue({
      text: '# Revised minutes',
      usage: { model: 'test', inputTokens: 10, outputTokens: 5 },
    }),
  });

  await amendCachedSessions({
    meetingId: 123,
    groupName: '6LO',
    comments: 'Fix transcript only',
    dependencies,
  });

  expect(dependencies.downloadTranscript).toHaveBeenCalledWith({
    sessionId: '6lo-1',
    sessionName: '6LO',
    recordingUrl: 'http://example.test',
  });
  expect(dependencies.writeFile).toHaveBeenCalledWith(
    'cache/transcripts/6lo-1.md',
    'Downloaded Rob Smith transcript.',
    'utf8',
  );
  expect(dependencies.amendMinutes).toHaveBeenCalledWith(
    '# Existing minutes',
    '',
    '6LO',
    false,
    null,
    expect.anything(),
    '- "Bob Smith" → "Rob Smith"',
  );
});

test('skips transcript step when transcriptInstructions is empty', async () => {
  const dependencies = makeDependencies({
    loadCacheManifest: jest.fn().mockResolvedValue([{
      sessionName: '6LO',
      sessions: [{ sessionId: '6lo-1' }],
    }]),
    splitAmendComments: jest.fn().mockResolvedValue({
      transcriptInstructions: '',
      minutesInstructions: 'Only edit minutes',
    }),
    getCachedMinutes: jest.fn().mockResolvedValue('# Existing minutes'),
    amendMinutes: jest.fn().mockResolvedValue({
      text: '# Revised minutes',
      usage: { model: 'test', inputTokens: 10, outputTokens: 5 },
    }),
  });

  await amendCachedSessions({
    meetingId: 123,
    groupName: '6LO',
    comments: 'Only edit minutes',
    dependencies,
  });

  expect(dependencies.readFile).not.toHaveBeenCalled();
  expect(dependencies.downloadTranscript).not.toHaveBeenCalled();
  expect(dependencies.amendMinutes).toHaveBeenCalledWith(
    '# Existing minutes',
    'Only edit minutes',
    '6LO',
    false,
    null,
    expect.anything(),
    null,
  );
});

test('splits comments once across multiple sessions in a WG', async () => {
  const dependencies = makeDependencies({
    loadCacheManifest: jest.fn().mockResolvedValue([{
      sessionName: '6LO',
      sessions: [{ sessionId: '6lo-1' }, { sessionId: '6lo-2' }],
    }]),
    splitAmendComments: jest.fn().mockResolvedValue({
      transcriptInstructions: 'Fix Bob to Rob',
      minutesInstructions: 'Fix minutes',
    }),
    getCachedMinutes: jest.fn().mockResolvedValue('# Existing'),
    existsSync: jest.fn().mockReturnValue(true),
    readFile: jest.fn().mockResolvedValue('Bob Smith'),
    getTranscriptCorrections: jest.fn().mockResolvedValue([{ from: 'Bob Smith', to: 'Rob Smith' }]),
    normalizeCorrections: jest.fn(raw => raw),
    applyCorrections: jest.fn().mockReturnValue({
      text: 'Rob Smith',
      appliedCount: 1,
      applied: [{ from: 'Bob Smith', to: 'Rob Smith' }],
    }),
    amendMinutes: jest.fn().mockResolvedValue({ text: '# Revised' }),
  });

  await amendCachedSessions({
    meetingId: 123,
    groupName: '6LO',
    comments: 'Fix Bob and fix minutes',
    dependencies,
  });

  expect(dependencies.splitAmendComments).toHaveBeenCalledTimes(1);
  expect(dependencies.getTranscriptCorrections).toHaveBeenCalledTimes(2);
  expect(dependencies.amendMinutes).toHaveBeenCalledTimes(2);
});

test('fails the whole run when the transcript step throws (e.g. an LLM API error), instead of silently skipping', async () => {
  const dependencies = makeDependencies({
    loadCacheManifest: jest.fn().mockResolvedValue([{
      sessionName: '6LO',
      sessions: [{ sessionId: '6lo-1' }],
    }]),
    splitAmendComments: jest.fn().mockResolvedValue({
      transcriptInstructions: 'Fix Bob to Rob',
      minutesInstructions: '',
    }),
    getCachedMinutes: jest.fn().mockResolvedValue('# Existing minutes'),
    existsSync: jest.fn().mockReturnValue(true),
    readFile: jest.fn().mockResolvedValue('Bob Smith discussed QUIC.'),
    getTranscriptCorrections: jest.fn().mockRejectedValue(
      new Error('[GoogleGenerativeAI Error]: ... [503 Service Unavailable] The service is currently unavailable.'),
    ),
  });

  await expect(amendCachedSessions({
    meetingId: 123,
    groupName: '6LO',
    comments: 'Fix Bob to Rob',
    dependencies,
  })).rejects.toThrow('Failed to amend 1 session(s): 6lo-1');

  expect(dependencies.amendMinutes).not.toHaveBeenCalled();
  expect(dependencies.saveCachedMinutes).not.toHaveBeenCalled();
  expect(dependencies.logger.error).toHaveBeenCalledWith(
    expect.stringContaining('Transcript step failed for 6lo-1: [GoogleGenerativeAI Error]'),
  );
  expect(dependencies.logger.error).toHaveBeenCalledWith(
    expect.stringContaining('Could not amend 6lo-1:'),
  );
});

test('resolves without failure when the transcript step runs cleanly but yields no changes and there are no minutes instructions', async () => {
  const dependencies = makeDependencies({
    loadCacheManifest: jest.fn().mockResolvedValue([{
      sessionName: '6LO',
      sessions: [{ sessionId: '6lo-1' }],
    }]),
    splitAmendComments: jest.fn().mockResolvedValue({
      transcriptInstructions: 'Fix Bob to Rob',
      minutesInstructions: '',
    }),
    getCachedMinutes: jest.fn().mockResolvedValue('# Existing minutes'),
    existsSync: jest.fn().mockReturnValue(true),
    readFile: jest.fn().mockResolvedValue('Bob Smith discussed QUIC.'),
    getTranscriptCorrections: jest.fn().mockResolvedValue([]),
    normalizeCorrections: jest.fn().mockReturnValue([]),
    applyCorrections: jest.fn().mockReturnValue({
      text: 'Bob Smith discussed QUIC.',
      appliedCount: 0,
      applied: [],
    }),
  });

  await expect(amendCachedSessions({
    meetingId: 123,
    groupName: '6LO',
    comments: 'Fix Bob to Rob',
    dependencies,
  })).resolves.toBeUndefined();

  expect(dependencies.amendMinutes).not.toHaveBeenCalled();
  expect(dependencies.saveCachedMinutes).not.toHaveBeenCalled();
  expect(dependencies.logger.error).not.toHaveBeenCalled();
  expect(dependencies.logger.log).toHaveBeenCalledWith(
    'Skipped amending 6lo-1: no minutes instructions or transcript changes',
  );
});
