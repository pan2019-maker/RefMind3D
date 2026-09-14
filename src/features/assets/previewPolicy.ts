export type ImagePreviewTier = 'thumbnail' | 'medium' | 'preview' | 'full';

export function nextImagePreviewTier(
  current: ImagePreviewTier | undefined,
  displaySize: number,
  lowZoom: boolean,
  allowFullResolution: boolean
): ImagePreviewTier {
  if (lowZoom) return 'thumbnail';
  if (!current) {
    if (displaySize <= 520) return 'thumbnail';
    if (displaySize <= 1400) return 'medium';
    if (allowFullResolution && displaySize > 2400) return 'full';
    return 'preview';
  }
  if (current === 'thumbnail') return displaySize > 620 ? 'medium' : 'thumbnail';
  if (current === 'medium') {
    if (displaySize < 440) return 'thumbnail';
    return displaySize > 1600 ? (allowFullResolution && displaySize > 2800 ? 'full' : 'preview') : 'medium';
  }
  if (current === 'preview') {
    if (displaySize < 1200) return 'medium';
    return allowFullResolution && displaySize > 2800 ? 'full' : 'preview';
  }
  return !allowFullResolution || displaySize < 2200 ? 'preview' : 'full';
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
