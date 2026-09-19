import { describe, expect, it } from 'vitest';
import { adaptiveImageConcurrency, adaptiveResourceBudget, nextQualityTier } from './resourceBudget';

describe('adaptive resource budget', () => {
  it('reduces live resources under frame and memory pressure', () => {
    expect(adaptiveResourceBudget(1000, 16, 60)).toEqual({ models: 4, videos: 8, fullImages: 12 });
    expect(adaptiveResourceBudget(30000, 4, 30).models).toBeLessThan(4);
  });
});

describe('adaptive quality hysteresis', () => {
  it('degrades quickly and recovers only after stable headroom', () => {
    expect(nextQualityTier('full', 50)).toBe('balanced');
    expect(nextQualityTier('balanced', 55)).toBe('balanced');
    expect(nextQualityTier('balanced', 59)).toBe('full');
    expect(nextQualityTier('full', 60, true)).toBe('responsive');
  });
});

describe('adaptive image concurrency', () => {
  it('backs off when frames or memory are constrained', () => {
    expect(adaptiveImageConcurrency(16, 60)).toBe(4);
    expect(adaptiveImageConcurrency(8, 50)).toBe(2);
    expect(adaptiveImageConcurrency(4, 60)).toBe(1);
  });
});
