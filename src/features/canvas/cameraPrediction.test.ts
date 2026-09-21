import { describe, expect, it } from 'vitest';
import { predictedViewport } from './cameraPrediction';

describe('camera prediction', () => {
  const current = { x: 100, y: 100, width: 1000, height: 600 };
  it('moves the prefetch corridor in the camera direction', () => {
    expect(predictedViewport(current, { x: 1, y: 0, speed: 2 }).x).toBeGreaterThan(current.x);
    expect(predictedViewport(current, { x: -1, y: 0, speed: 2 }).x).toBeLessThan(current.x);
  });
  it('looks further ahead at higher speed', () => {
    expect(predictedViewport(current, { x: 1, y: 0, speed: 7 }).x).toBeGreaterThan(predictedViewport(current, { x: 1, y: 0, speed: 1 }).x);
  });
});
