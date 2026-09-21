import { describe, expect, it, vi } from 'vitest';
import { assessBenchmarkSuite, runCanvasBenchmark, runCanvasBenchmarkSuite } from './benchmark';

describe('canvas benchmark', () => {
  it('queries a large synthetic board', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    const result = await runCanvasBenchmark(1_000);
    expect(result.nodeCount).toBe(1_000);
    expect(result.averageHits).toBeGreaterThan(0);
  });

  it('keeps the 1K / 5K / 10K release performance matrix inside its budgets', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    const assessment = assessBenchmarkSuite(await runCanvasBenchmarkSuite());
    expect(assessment.failures).toEqual([]);
    expect(assessment.passed).toBe(true);
  });

  it('reports the exact regression that exceeded a budget', () => {
    const assessment = assessBenchmarkSuite([{ nodeCount: 1_000, buildMs: 500, queryMs: 1, transformMs: 1, tileSelectionMs: 1, soakCycles: 80, soakMs: 1, estimatedPeakMb: 1, averageHits: 1 }]);
    expect(assessment.passed).toBe(false);
    expect(assessment.failures[0]).toContain('index');
  });
});
