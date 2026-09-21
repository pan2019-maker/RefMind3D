import { selectImageMip, type ImageMipSource, type SelectedImageMip } from './previewPolicy';

export interface ImageTileLevel {
  maxEdge: number;
  urls: string[];
  tileSize: number;
  tileColumns: number;
  imageWidth: number;
  imageHeight: number;
}

export interface ImageRenderPlan {
  baseUrl: string;
  mip: SelectedImageMip;
  tileLevel?: ImageTileLevel;
  renderer: 'mip' | 'tiles';
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
}): ImageRenderPlan {
  const mip = selectImageMip(
    options.displayEdgeCss,
    options.devicePixelRatio,
    options.sources,
    options.forceFull ? Number.MAX_SAFE_INTEGER : 1.35
  );
  const tileLevel = options.visible && !options.cropEnabled
    ? selectTileLevel(mip.targetPhysicalEdge, options.tileLevels || [])
    : undefined;
  // Tiles are useful only after the normal preview would be undersampled. A
  // smaller tile set must never replace a sharper full-resolution source.
  const useTiles = Boolean(tileLevel && mip.targetPhysicalEdge > 1600 && tileLevel.maxEdge >= Math.min(mip.targetPhysicalEdge, mip.maxEdge || mip.targetPhysicalEdge));
  return { baseUrl: options.baseUrl, mip, tileLevel: useTiles ? tileLevel : undefined, renderer: useTiles ? 'tiles' : 'mip' };
}
