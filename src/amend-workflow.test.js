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
    '# Existing', 'Correct it', '6LO', true, null, liveContext,
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
    getCachedMetadata: jest.fn().mockResolvedValue({ slides, bluesheetText }),
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
    },
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
    },
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
    },
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
    { slidesAndBluesheet: null, wgDocuments: [] },
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
