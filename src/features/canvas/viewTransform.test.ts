import { describe, expect, it } from 'vitest';
import { screenToWorld, stableWorldOrigin, worldToScreen } from './viewTransform';

describe('stable canvas transforms', () => {
  it('round trips points on extremely distant boards', () => {
    const view = { x: -9_876_543_210.25, y: 7_654_321_098.5, scale: 3.75 };
    const viewport = { width: 1920, height: 1080 };
    const origin = stableWorldOrigin(view, viewport);
    const point = { x: 2_633_746_123.125, y: -2_041_151_987.75 };
    const restored = screenToWorld(worldToScreen(point, view, origin), view, origin);
    expect(restored.x).toBeCloseTo(point.x, 5);
    expect(restored.y).toBeCloseTo(point.y, 5);
  });
});
