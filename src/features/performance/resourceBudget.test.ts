import { describe, expect, it } from 'vitest';
import { adaptiveResourceBudget } from './resourceBudget';

describe('adaptive resource budget', () => {
  it('reduces live resources under frame and memory pressure', () => {
    expect(adaptiveResourceBudget(1000, 16, 60)).toEqual({ models: 4, videos: 8, fullImages: 12 });
    expect(adaptiveResourceBudget(30000, 4, 30).models).toBeLessThan(4);
  });
});
