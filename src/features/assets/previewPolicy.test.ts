import { describe, expect, it } from 'vitest';
import { boundedGpuNodeIds, closestNodeIds, nextImagePreviewTier } from './previewPolicy';

describe('preview policy', () => {
  it('uses hysteresis around image tier boundaries', () => {
    expect(nextImagePreviewTier('thumbnail', 580, false, false)).toBe('thumbnail');
    expect(nextImagePreviewTier('thumbnail', 700, false, false)).toBe('medium');
    expect(nextImagePreviewTier('medium', 500, false, false)).toBe('medium');
    expect(nextImagePreviewTier('medium', 400, false, false)).toBe('thumbnail');
    expect(nextImagePreviewTier('preview', 1300, false, false)).toBe('preview');
  });

  it('keeps only the closest heavy resources inside a budget', () => {
    const nodes = Array.from({ length: 10 }, (_, id) => ({ id: String(id), x: id * 100, y: 0, width: 10, height: 10 }));
    expect([...closestNodeIds(nodes, { x: 0, y: 0 }, 3)]).toEqual(['0', '1', '2']);
  });

  it('never assigns more zoomed-out images to GPU than the texture budget', () => {
    const nodes = Array.from({ length: 500 }, (_, id) => ({ id: String(id), x: id * 10, y: 0, width: 100, height: 100 }));
    const ids = boundedGpuNodeIds(nodes, { x: 0, y: 0 }, 192, new Set(['0']));
    expect(ids.size).toBe(192);
    expect(ids.has('0')).toBe(false);
    expect(nodes.filter((node) => !ids.has(node.id))).toHaveLength(308);
  });
});
