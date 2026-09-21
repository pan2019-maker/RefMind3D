import { describe, expect, it } from 'vitest';
import { buildImageRenderPlan, selectImageMipWithHysteresis, selectTileLevel } from './imageRenderPlan';

const sources = [
  { maxEdge: 512, url: 'thumb', band: 'thumbnail' as const },
  { maxEdge: 1200, url: 'medium', band: 'medium' as const },
  { maxEdge: 2400, url: 'preview', band: 'preview' as const },
  { maxEdge: 7680, url: 'original', band: 'full' as const }
];
const levels = [
  { maxEdge: 4096, urls: ['4k'], tileSize: 1024, tileColumns: 4, imageWidth: 4096, imageHeight: 2048 },
  { maxEdge: 7680, urls: ['8k'], tileSize: 1024, tileColumns: 8, imageWidth: 7680, imageHeight: 3840 }
];

describe('unified image render plan', () => {
  it.each([
    [240, 1, 'thumb'], [400, 1.25, 'medium'], [700, 1.5, 'preview'],
    [900, 2, 'original'], [1600, 2, 'original']
  ])('chooses enough decoded pixels for %spx at DPR %s', (edge, dpr, expected) => {
    expect(buildImageRenderPlan({ displayEdgeCss: edge as number, devicePixelRatio: dpr as number, sources, baseUrl: 'thumb', visible: true, cropEnabled: true }).mip.url).toBe(expected);
  });

  it('chooses the smallest sufficient tile level and then the largest fallback', () => {
    expect(selectTileLevel(2600, levels)?.maxEdge).toBe(4096);
    expect(selectTileLevel(6000, levels)?.maxEdge).toBe(7680);
    expect(selectTileLevel(9000, levels)?.maxEdge).toBe(7680);
  });

  it('keeps tiles out of crop mode and low-resolution views', () => {
    expect(buildImageRenderPlan({ displayEdgeCss: 900, devicePixelRatio: 2, sources, baseUrl: 'thumb', tileLevels: levels, visible: true, cropEnabled: false }).renderer).toBe('tiles');
    expect(buildImageRenderPlan({ displayEdgeCss: 300, devicePixelRatio: 1, sources, baseUrl: 'thumb', tileLevels: levels, visible: true, cropEnabled: false }).renderer).toBe('mip');
    expect(buildImageRenderPlan({ displayEdgeCss: 1800, devicePixelRatio: 2, sources, baseUrl: 'thumb', tileLevels: levels, visible: false, cropEnabled: true }).renderer).toBe('mip');
    expect(buildImageRenderPlan({ displayEdgeCss: 1800, devicePixelRatio: 2, sources, baseUrl: 'thumb', tileLevels: levels, visible: true, cropEnabled: true }).renderer).toBe('tiles');
  });

  it('holds the current mip around both sides of a boundary', () => {
    const medium = { url: 'medium', band: 'medium' as const, maxEdge: 1200, targetPhysicalEdge: 1100 };
    expect(selectImageMipWithHysteresis(890, 1, sources, medium).url).toBe('medium');
    expect(selectImageMipWithHysteresis(1000, 1, sources, medium).url).toBe('preview');
    const preview = { url: 'preview', band: 'preview' as const, maxEdge: 2400, targetPhysicalEdge: 1400 };
    expect(selectImageMipWithHysteresis(800, 1, sources, preview).url).toBe('preview');
    expect(selectImageMipWithHysteresis(650, 1, sources, preview).url).toBe('medium');
  });
});
