export type ImagePreviewTier = 'thumbnail' | 'medium' | 'preview' | 'full';

export function shouldUseOverviewRenderer(scale: number, imageCount: number) {
  return scale < 0.12 && imageCount >= 50;
}

export function nextImagePreviewTier(
  current: ImagePreviewTier | undefined,
  displaySize: number,
  lowZoom: boolean,
  allowFullResolution: boolean,
  devicePixelRatio = 1
): ImagePreviewTier {
  if (lowZoom) return 'thumbnail';
  // Cache tiers are sized in physical pixels, while layout measurements are
  // CSS pixels. Ignoring display scaling kept a 1200 px cache stretched over
  // much larger HiDPI surfaces and made images visibly soft after zooming in.
  const physicalSize = displaySize * Math.min(3, Math.max(1, devicePixelRatio));
  if (!current) {
    if (physicalSize <= 440) return 'thumbnail';
    if (physicalSize <= 960) return 'medium';
    if (allowFullResolution && physicalSize > 2000) return 'full';
    return 'preview';
  }
  if (current === 'thumbnail') return physicalSize > 520 ? 'medium' : 'thumbnail';
  if (current === 'medium') {
    if (physicalSize < 360) return 'thumbnail';
    if (physicalSize > 1080) return allowFullResolution && physicalSize > 2200 ? 'full' : 'preview';
    return 'medium';
  }
  if (current === 'preview') {
    if (physicalSize < 820) return 'medium';
    return allowFullResolution && physicalSize > 2200 ? 'full' : 'preview';
  }
  return !allowFullResolution || physicalSize < 1800 ? 'preview' : 'full';
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
