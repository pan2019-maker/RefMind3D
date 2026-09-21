export type ImageResolutionBand = 'thumbnail' | 'medium' | 'preview' | 'full';

export interface ImageMipSource {
  maxEdge: number;
  url: string;
  band: ImageResolutionBand;
}

export interface SelectedImageMip {
  url: string;
  band: ImageResolutionBand;
  targetPhysicalEdge: number;
  maxEdge: number;
}

/**
 * Selects the smallest decoded image that still has enough physical pixels for
 * the node on screen. It intentionally knows nothing about canvas zoom,
 * selection state or resource budgets: those heuristics previously allowed a
 * 512 px thumbnail to remain visible while a large node was being inspected.
 */
export function selectImageMip(
  displayEdgeCss: number,
  devicePixelRatio: number,
  sources: readonly ImageMipSource[],
  headroom = 1.35
): SelectedImageMip {
  const physicalEdge = Math.max(1, displayEdgeCss) * Math.min(3, Math.max(1, devicePixelRatio));
  const targetPhysicalEdge = Math.ceil(physicalEdge * Math.max(1, headroom));
  const available = sources
    .filter((source) => source.url && source.maxEdge > 0)
    .slice()
    .sort((a, b) => a.maxEdge - b.maxEdge);
  const selected = available.find((source) => source.maxEdge >= targetPhysicalEdge)
    || available[available.length - 1];
  return {
    url: selected?.url || '',
    band: selected?.band || 'full',
    targetPhysicalEdge,
    maxEdge: selected?.maxEdge || 0
  };
}

export function shouldUseOverviewRenderer(scale: number, imageCount: number) {
  return scale < 0.12 && imageCount >= 50;
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
