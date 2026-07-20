import { jest } from '@jest/globals';
import { computeCostSummary } from './accounting.js';

describe('computeCostSummary', () => {
  test('prices a Deepgram audio record per minute of audio', () => {
    const summary = computeCostSummary([
      { model: 'deepgram:nova-3', audioSeconds: 3600, inputTokens: 0, outputTokens: 0 },
    ]);

    expect(summary.rows).toHaveLength(1);
    const [row] = summary.rows;
    expect(row.kind).toBe('audio');
    expect(row.model).toBe('deepgram:nova-3');
    expect(row.costKnown).toBe(true);
    expect(row.cost).toBeCloseTo(60 * 0.0052, 6);
    expect(summary.totalCost).toBeCloseTo(60 * 0.0052, 6);
    expect(summary.allKnown).toBe(true);
  });

  test('combines a Gemini token record and a Deepgram audio record into separate rows', () => {
    const summary = computeCostSummary([
      { model: 'gemini-3.5-flash', inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { model: 'deepgram:nova-3', audioSeconds: 1800, inputTokens: 0, outputTokens: 0 },
    ]);

    expect(summary.rows).toHaveLength(2);
    const tokenRow = summary.rows.find((r) => r.kind === 'tokens');
    const audioRow = summary.rows.find((r) => r.kind === 'audio');
    expect(tokenRow.model).toBe('gemini-3.5-flash');
    expect(tokenRow.cost).toBeCloseTo(1.5 + 9.0, 6);
    expect(audioRow.model).toBe('deepgram:nova-3');
    expect(audioRow.cost).toBeCloseTo(30 * 0.0052, 6);
    expect(summary.totalCost).toBeCloseTo(1.5 + 9.0 + 30 * 0.0052, 6);
    expect(summary.allKnown).toBe(true);
  });

  test('marks an unpriced audio model as unknown and the total as approximate', () => {
    const summary = computeCostSummary([
      { model: 'deepgram:nova-9', audioSeconds: 600, inputTokens: 0, outputTokens: 0 },
    ]);

    const [row] = summary.rows;
    expect(row.kind).toBe('audio');
    expect(row.costKnown).toBe(false);
    expect(row.cost).toBe(0);
    expect(summary.allKnown).toBe(false);
    expect(summary.totalCost).toBe(0);
  });

  test('prices a deepgram:nova-3+names run as a Deepgram audio row plus a Gemini token row', () => {
    const summary = computeCostSummary([
      { model: 'deepgram:nova-3', audioSeconds: 3600, inputTokens: 0, outputTokens: 0 },
      { model: 'gemini-3.5-flash', inputTokens: 2000, outputTokens: 500 },
    ]);

    expect(summary.rows).toHaveLength(2);
    expect(summary.rows.map((r) => r.model).sort()).toEqual(['deepgram:nova-3', 'gemini-3.5-flash']);
    const expectedTotal = 60 * 0.0052 + (2000 / 1_000_000) * 1.5 + (500 / 1_000_000) * 9.0;
    expect(summary.totalCost).toBeCloseTo(expectedTotal, 6);
    expect(summary.allKnown).toBe(true);
  });

  test('returns no rows and no cost for an empty record set', () => {
    const summary = computeCostSummary([]);
    expect(summary.rows).toEqual([]);
    expect(summary.totalCost).toBe(0);
    expect(summary.allKnown).toBe(true);
  });
});

// usageRecords is module-level singleton state accumulated by recordUsage(), so
// each test gets a fresh module instance via jest.resetModules() + dynamic import.
describe('printSummary', () => {
  test('does not log anything when no usage has been recorded', async () => {
    jest.resetModules();
    const { printSummary } = await import('./accounting.js');

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => printSummary()).not.toThrow();
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  test('prints a Deepgram line with audio minutes and an estimated cost', async () => {
    jest.resetModules();
    const { printSummary, recordUsage } = await import('./accounting.js');
    recordUsage({ model: 'deepgram:nova-3', audioSeconds: 1200, inputTokens: 0, outputTokens: 0 });

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    printSummary();
    const output = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    logSpy.mockRestore();

    expect(output).toContain('Audio Transcription (STT)');
    expect(output).toMatch(/deepgram:nova-3\s+20\.0\s+\$0\.10/);
    expect(output).not.toContain('Token Usage & Cost');
    expect(output).toMatch(/Total\s+20\.0\s+\$0\.10/);
  });

  test('renders a deepgram:nova-3+names mixed run with unambiguous token, audio, and grand totals', async () => {
    jest.resetModules();
    const { printSummary, recordUsage } = await import('./accounting.js');
    recordUsage({ model: 'gemini-3.5-flash', inputTokens: 2000, outputTokens: 500 });
    recordUsage({ model: 'deepgram:nova-3', audioSeconds: 3600, inputTokens: 0, outputTokens: 0 });

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    printSummary();
    const output = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    logSpy.mockRestore();

    expect(output).toContain('Token Usage & Cost');
    expect(output).toContain('Audio Transcription (STT)');

    // The token table's own Total row must show the token-only cost ($0.0075 → $0.01),
    // not a total inflated by the Deepgram audio spend.
    expect(output).toMatch(/Total\s+2,000\s+500\s+\$0\.01/);

    // The audio table's own Total row must show the audio minutes and audio-only cost,
    // not folded under token headers.
    expect(output).toMatch(/Total\s+60\.0\s+\$0\.31/);

    // A combined grand total sums both, so the reader can see the true overall spend.
    expect(output).toMatch(/Grand Total.*\$0\.32/);
  });
});
