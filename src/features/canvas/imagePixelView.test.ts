import { describe, expect, it } from 'vitest';
import { imagePixelViewScale } from './imagePixelView';

describe('original pixel inspection', () => {
  it('maps one source pixel to one physical display pixel', () => {
    expect(imagePixelViewScale({ width: 1000, height: 500 }, { width: 4000, height: 2000 }, 2)).toBe(2);
    expect(imagePixelViewScale({ width: 1000, height: 500 }, { width: 4000, height: 2000 }, 2, 2)).toBe(4);
  });
});
