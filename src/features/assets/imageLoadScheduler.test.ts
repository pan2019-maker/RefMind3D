import { describe, expect, it } from 'vitest';
import { ImageLoadScheduler } from './imageLoadScheduler';

describe('ImageLoadScheduler', () => {
  it('enforces concurrency and promotes visible work over queued prewarm work', async () => {
    const scheduler = new ImageLoadScheduler(1);
    const starts: string[] = [];
    let releaseFirst!: () => void;
    const first = scheduler.schedule('first', 0, () => new Promise<void>((resolve) => {
      starts.push('first');
      releaseFirst = resolve;
    }));
    const prewarm = scheduler.schedule('prewarm', 2, async () => { starts.push('prewarm'); });
    const visible = scheduler.schedule('visible', 0, async () => { starts.push('visible'); });
    await Promise.resolve();
    expect(starts).toEqual(['first']);
    releaseFirst();
    await Promise.all([first, prewarm, visible]);
    expect(starts).toEqual(['first', 'visible', 'prewarm']);
  });

  it('deduplicates the same cache key', async () => {
    const scheduler = new ImageLoadScheduler(2);
    let runs = 0;
    const first = scheduler.schedule('same', 1, async () => ++runs);
    const second = scheduler.schedule('same', 0, async () => ++runs);
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(runs).toBe(1);
  });

  it('cancels queued work after its last consumer leaves', async () => {
    const scheduler = new ImageLoadScheduler(1);
    let releaseBlocker!: () => void;
    const blocker = scheduler.schedule('blocker', 0, () => new Promise<void>((resolve) => { releaseBlocker = resolve; }));
    await Promise.resolve();
    let ran = false;
    const queued = scheduler.schedule('queued', 2, async () => { ran = true; });
    scheduler.release('queued');
    await expect(queued).rejects.toMatchObject({ name: 'ImageLoadCancelledError' });
    releaseBlocker();
    await blocker;
    expect(ran).toBe(false);
  });
});
