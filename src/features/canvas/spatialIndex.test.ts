import { describe, expect, it } from 'vitest';
import { SpatialGridIndex } from './spatialIndex';

describe('SpatialGridIndex', () => {
  const items = [
    { id: 'origin', x: 0, y: 0, width: 100, height: 100 },
    { id: 'near', x: 900, y: 900, width: 300, height: 300 },
    { id: 'far', x: 50_000, y: 50_000, width: 100, height: 100 }
  ];

  it('returns only nodes intersecting the requested world rectangle', () => {
    const index = new SpatialGridIndex(items, 512);
    expect(index.query({ x: -10, y: -10, width: 130, height: 130 }).map((item) => item.id)).toEqual(['origin']);
  });

  it('deduplicates nodes spanning several cells', () => {
    const index = new SpatialGridIndex(items, 256);
    expect(index.query({ x: 850, y: 850, width: 500, height: 500 }).map((item) => item.id)).toEqual(['near']);
  });

  it('keeps very large group rectangles queryable without cell explosion', () => {
    const huge = { id: 'group', x: -100_000, y: -100_000, width: 200_000, height: 200_000 };
    const index = new SpatialGridIndex([huge], 256);
    expect(index.query({ x: 40_000, y: 40_000, width: 100, height: 100 })).toEqual([huge]);
  });

  it('queries a 5000-node board without returning distant nodes', () => {
    const board = Array.from({ length: 5_000 }, (_, index) => ({
      id: `node-${index}`,
      x: (index % 100) * 400,
      y: Math.floor(index / 100) * 400,
      width: 160,
      height: 120
    }));
    const index = new SpatialGridIndex(board);
    const visible = index.query({ x: 10_000, y: 5_000, width: 1_600, height: 900 });
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(40);
  });

  it('incrementally moves, updates and removes nodes', () => {
    const index = new SpatialGridIndex(items, 512);
    const moved = { ...items[0], x: 4_000 };
    const renamed = { ...items[1], title: 'updated without geometry changes' };
    index.sync([moved, renamed]);
    expect(index.query({ x: -10, y: -10, width: 130, height: 130 })).toEqual([]);
    expect(index.query({ x: 3_990, y: -10, width: 130, height: 130 })).toEqual([moved]);
    expect(index.query({ x: 850, y: 850, width: 500, height: 500 })).toEqual([renamed]);
    expect(index.query({ x: 49_000, y: 49_000, width: 2_000, height: 2_000 })).toEqual([]);
  });
});
