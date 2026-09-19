import { describe, expect, it } from 'vitest';
import { boundedGpuNodeIds, closestNodeIds, imagePreviewSource, nextImagePreviewTier, shouldUseOverviewRenderer } from './previewPolicy';

describe('preview policy', () => {
  it('uses hysteresis around image tier boundaries', () => {
    expect(nextImagePreviewTier('thumbnail', 400, false, false)).toBe('thumbnail');
    expect(nextImagePreviewTier('thumbnail', 700, false, false)).toBe('medium');
    expect(nextImagePreviewTier('medium', 500, false, false)).toBe('medium');
    expect(nextImagePreviewTier('medium', 300, false, false)).toBe('thumbnail');
    expect(nextImagePreviewTier('preview', 900, false, false)).toBe('preview');
  });

  it('selects cache tiers using physical pixels on scaled displays', () => {
    expect(nextImagePreviewTier(undefined, 900, false, false, 1)).toBe('medium');
    expect(nextImagePreviewTier(undefined, 900, false, false, 2)).toBe('preview');
    expect(nextImagePreviewTier('medium', 900, false, false, 2)).toBe('preview');
  });

  it('does not force a visible large node to thumbnail at low canvas zoom', () => {
    expect(nextImagePreviewTier(undefined, 390, true, false, 1.25)).toBe('medium');
    expect(nextImagePreviewTier('thumbnail', 390, true, false, 1.25)).toBe('medium');
    expect(nextImagePreviewTier(undefined, 240, true, false, 1.25)).toBe('thumbnail');
  });

  it('maps DOM and GPU tiers to the same prepared image sources', () => {
    const sources = { thumbnail: '512', medium: '1200', preview: '2400', full: 'original' };
    expect(imagePreviewSource('thumbnail', sources)).toBe('512');
    expect(imagePreviewSource('medium', sources)).toBe('1200');
    expect(imagePreviewSource('preview', sources)).toBe('2400');
    expect(imagePreviewSource('full', sources)).toBe('original');
  });

  it('promotes nearby or selected large images to full resolution with hysteresis', () => {
    expect(nextImagePreviewTier('preview', 1100, false, true, 2)).toBe('full');
    expect(nextImagePreviewTier('full', 1000, false, true, 2)).toBe('full');
    expect(nextImagePreviewTier('full', 800, false, true, 2)).toBe('preview');
    expect(nextImagePreviewTier('full', 1600, false, false, 2)).toBe('preview');
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

  it('switches to the bounded overview renderer only for dense extreme zooms', () => {
    expect(shouldUseOverviewRenderer(0.08, 500)).toBe(true);
    expect(shouldUseOverviewRenderer(0.2, 500)).toBe(false);
    expect(shouldUseOverviewRenderer(0.08, 20)).toBe(false);
  });
});
