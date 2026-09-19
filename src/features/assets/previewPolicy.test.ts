import { describe, expect, it } from 'vitest';
import { boundedGpuNodeIds, closestNodeIds, selectImageMip, shouldUseOverviewRenderer } from './previewPolicy';

describe('preview policy', () => {
  const sources = [
    { maxEdge: 512, url: '512', band: 'thumbnail' as const },
    { maxEdge: 1200, url: '1200', band: 'medium' as const },
    { maxEdge: 2400, url: '2400', band: 'preview' as const },
    { maxEdge: 3840, url: 'original', band: 'full' as const }
  ];

  it('selects the smallest mip with physical-pixel headroom', () => {
    expect(selectImageMip(200, 1, sources).url).toBe('512');
    expect(selectImageMip(500, 1, sources).url).toBe('1200');
    expect(selectImageMip(1000, 1, sources).url).toBe('2400');
    expect(selectImageMip(1900, 1, sources).url).toBe('original');
  });

  it('uses display scaling rather than canvas zoom or selection heuristics', () => {
    expect(selectImageMip(390, 1.25, sources).url).toBe('1200');
    expect(selectImageMip(900, 2, sources).url).toBe('original');
  });

  it('falls back to the highest available source without getting stuck on a thumbnail', () => {
    expect(selectImageMip(900, 2, sources.slice(0, 3)).url).toBe('2400');
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
