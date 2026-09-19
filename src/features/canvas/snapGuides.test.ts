import { describe, expect, it } from 'vitest';
import { snapMovingBounds } from './snapGuides';

describe('smart guides', () => {
  it('snaps centers and edges independently', () => {
    const result = snapMovingBounds(
      { x: 96, y: 205, width: 100, height: 100 },
      [{ id: 'fixed', x: 200, y: 100, width: 100, height: 100 }],
      6
    );
    expect(result.dx).toBe(4);
    expect(result.dy).toBe(-5);
    expect(result.guides).toHaveLength(2);
  });

  it('continues an existing equal-spacing rhythm', () => {
    const result = snapMovingBounds(
      { x: 217, y: 0, width: 100, height: 100 },
      [
        { id: 'a', x: 0, y: 0, width: 100, height: 100 },
        { id: 'b', x: 110, y: 0, width: 100, height: 100 }
      ],
      8
    );
    expect(result.dx).toBe(3);
  });
});
