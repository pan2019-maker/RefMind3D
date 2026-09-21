import { selectImageMip, type ImageMipSource, type SelectedImageMip } from './previewPolicy';

export interface ImageTileLevel {
  maxEdge: number;
  urls: string[];
  tileSize: number;
  tileColumns: number;
  imageWidth: number;
  imageHeight: number;
  overlap?: number;
}

export interface ImageRenderPlan {
  baseUrl: string;
  mip: SelectedImageMip;
  tileLevel?: ImageTileLevel;
  renderer: 'mip' | 'tiles';
}

export function selectImageMipWithHysteresis(
  displayEdgeCss: number,
  devicePixelRatio: number,
  sources: readonly ImageMipSource[],
  previous?: SelectedImageMip,
  headroom = 1.35
) {
  const desired = selectImageMip(displayEdgeCss, devicePixelRatio, sources, headroom);
  if (!previous?.url || previous.url === desired.url) return desired;
  const available = sources.filter((source) => source.url && source.maxEdge > 0).slice().sort((a, b) => a.maxEdge - b.maxEdge);
  const previousIndex = available.findIndex((source) => source.url === previous.url);
  const desiredIndex = available.findIndex((source) => source.url === desired.url);
  if (previousIndex < 0 || desiredIndex < 0) return desired;
  const physicalTarget = desired.targetPhysicalEdge;
  if (desiredIndex > previousIndex && physicalTarget <= available[previousIndex].maxEdge * 1.08) {
    return { ...previous, targetPhysicalEdge: physicalTarget };
  }
  const lower = available[Math.max(0, previousIndex - 1)];
  if (desiredIndex < previousIndex && physicalTarget >= lower.maxEdge * .82) {
    return { ...previous, targetPhysicalEdge: physicalTarget };
  }
  return desired;
}

export function selectTileLevel(targetPhysicalEdge: number, levels: readonly ImageTileLevel[]) {
  const available = levels
    .filter((level) => level.urls.length > 0 && level.maxEdge > 0 && level.tileColumns > 0)
    .slice()
    .sort((a, b) => a.maxEdge - b.maxEdge);
  return available.find((level) => level.maxEdge >= targetPhysicalEdge) || available[available.length - 1];
}

/** One decision shared by the DOM and GPU renderers. */
export function buildImageRenderPlan(options: {
  displayEdgeCss: number;
  devicePixelRatio: number;
  sources: readonly ImageMipSource[];
  baseUrl: string;
  tileLevels?: readonly ImageTileLevel[];
  visible: boolean;
  cropEnabled: boolean;
  forceFull?: boolean;
  previousMip?: SelectedImageMip;
}): ImageRenderPlan {
  const mip = selectImageMipWithHysteresis(
    options.displayEdgeCss,
    options.devicePixelRatio,
    options.sources,
    options.previousMip,
    options.forceFull ? Number.MAX_SAFE_INTEGER : 1.35
  );
  const tileLevel = options.visible
    ? selectTileLevel(mip.targetPhysicalEdge, options.tileLevels || [])
    : undefined;
  // Tiles are useful only after the normal preview would be undersampled. A
  // smaller tile set must never replace a sharper full-resolution source.
  const useTiles = Boolean(tileLevel && mip.targetPhysicalEdge > 1600 && tileLevel.maxEdge >= Math.min(mip.targetPhysicalEdge, mip.maxEdge || mip.targetPhysicalEdge));
  return { baseUrl: options.baseUrl, mip, tileLevel: useTiles ? tileLevel : undefined, renderer: useTiles ? 'tiles' : 'mip' };
}
