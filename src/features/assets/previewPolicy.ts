export type ImagePreviewTier = 'thumbnail' | 'medium' | 'preview' | 'full';

export interface ImagePreviewSources {
  thumbnail: string;
  medium: string;
  preview: string;
  full: string;
}

export function imagePreviewSource(tier: ImagePreviewTier, sources: ImagePreviewSources) {
  if (tier === 'thumbnail') return sources.thumbnail;
  if (tier === 'medium') return sources.medium;
  if (tier === 'full') return sources.full;
  return sources.preview;
}

export function shouldUseOverviewRenderer(scale: number, imageCount: number) {
  return scale < 0.12 && imageCount >= 50;
}

export function nextImagePreviewTier(
  current: ImagePreviewTier | undefined,
  displaySize: number,
  _lowZoom: boolean,
  allowFullResolution: boolean,
  devicePixelRatio = 1
): ImagePreviewTier {
  // Cache tiers are sized in physical pixels, while layout measurements are
  // CSS pixels. Canvas zoom alone must not force a thumbnail: a large node can
  // still occupy hundreds of physical pixels at a low global zoom level.
  const physicalSize = displaySize * Math.min(3, Math.max(1, devicePixelRatio));
  if (!current) {
    if (physicalSize <= 384) return 'thumbnail';
    if (physicalSize <= 900) return 'medium';
    if (allowFullResolution && physicalSize > 1800) return 'full';
    return 'preview';
  }
  if (current === 'thumbnail') return physicalSize > 420 ? 'medium' : 'thumbnail';
  if (current === 'medium') {
    if (physicalSize < 320) return 'thumbnail';
    if (physicalSize > 1000) return allowFullResolution && physicalSize > 2000 ? 'full' : 'preview';
    return 'medium';
  }
  if (current === 'preview') {
    if (physicalSize < 720) return 'medium';
    return allowFullResolution && physicalSize > 2000 ? 'full' : 'preview';
  }
  return !allowFullResolution || physicalSize <= 1600 ? 'preview' : 'full';
}

export function closestNodeIds<T extends { id: string; x: number; y: number; width: number; height: number }>(
  nodes: T[], center: { x: number; y: number }, limit: number
) {
  return new Set(nodes.slice().sort((a, b) => {
    const ad = Math.hypot(a.x + a.width / 2 - center.x, a.y + a.height / 2 - center.y);
    const bd = Math.hypot(b.x + b.width / 2 - center.x, b.y + b.height / 2 - center.y);
    return ad - bd;
  }).slice(0, limit).map((node) => node.id));
}

/**
 * Keeps GPU composition bounded. Nodes outside the GPU budget deliberately
 * remain on the normal thumbnail path, so zooming out can never hide them just
 * because more images became visible than the texture pool can hold.
 */
export function boundedGpuNodeIds<T extends { id: string; x: number; y: number; width: number; height: number }>(
  nodes: T[], center: { x: number; y: number }, limit: number, excludedIds: ReadonlySet<string>
) {
  return closestNodeIds(nodes.filter((node) => !excludedIds.has(node.id)), center, Math.max(0, limit));
}
