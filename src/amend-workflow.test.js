import { jest } from '@jest/globals';
import { amendCachedSessions } from './amend-workflow.js';

function makeDependencies(overrides = {}) {
  return {
    loadCacheManifest: jest.fn(),
    getCachedMinutes: jest.fn(),
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
