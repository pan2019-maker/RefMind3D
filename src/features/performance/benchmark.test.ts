import { describe, expect, it, vi } from 'vitest';
import { runCanvasBenchmark } from './benchmark';

describe('canvas benchmark', () => {
  it('queries a large synthetic board', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    const result = await runCanvasBenchmark(1_000);
    expect(result.nodeCount).toBe(1_000);
    expect(result.averageHits).toBeGreaterThan(0);
  });
});
