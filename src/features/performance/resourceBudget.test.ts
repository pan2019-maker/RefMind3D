import { describe, expect, it } from 'vitest';
import { adaptiveImageConcurrency, adaptiveResourceBudget } from './resourceBudget';

describe('adaptive resource budget', () => {
  it('reduces live resources under frame and memory pressure', () => {
    expect(adaptiveResourceBudget(1000, 16, 60)).toEqual({ models: 4, videos: 8, fullImages: 12 });
    expect(adaptiveResourceBudget(30000, 4, 30).models).toBeLessThan(4);
  });
});

describe('adaptive image concurrency', () => {
  it('backs off when frames or memory are constrained', () => {
    expect(adaptiveImageConcurrency(16, 60)).toBe(4);
    expect(adaptiveImageConcurrency(8, 50)).toBe(2);
    expect(adaptiveImageConcurrency(4, 60)).toBe(1);
  });
});
