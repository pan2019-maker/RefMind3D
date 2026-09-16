export interface PerformanceMetrics {
  totalNodes: number;
  renderedNodes: number;
  visibleNodes: number;
  activeModels: number;
  activeVideos: number;
  imageMemoryEntries: number;
  imageLoadsActive: number;
  imageLoadsQueued: number;
  imageLoadConcurrency: number;
  imageCacheHits: number;
  imageCacheMisses: number;
  fps: number;
  slowFrames: number;
  frameTimeMs: number;
  qualityTier: 'full' | 'balanced' | 'responsive';
  imageTierThumbnail: number;
  imageTierMedium: number;
  imageTierPreview: number;
  imageTierFull: number;
  estimatedTextureMb: number;
  sourceRefreshes: number;
  lastSaveMs?: number;
  inputLatencyP95Ms: number;
  gpuTextureCount: number;
  projectOpenMs?: number;
  jsHeapMb: number;
  memoryPressure: boolean;
  resourceProtectionActivations: number;
}

const metrics: PerformanceMetrics = {
  totalNodes: 0, renderedNodes: 0, visibleNodes: 0, activeModels: 0, activeVideos: 0,
  imageMemoryEntries: 0, imageLoadsActive: 0, imageLoadsQueued: 0, imageLoadConcurrency: 3,
  imageCacheHits: 0, imageCacheMisses: 0, fps: 0, slowFrames: 0,
  frameTimeMs: 0, qualityTier: 'full', imageTierThumbnail: 0, imageTierMedium: 0,
  imageTierPreview: 0, imageTierFull: 0, estimatedTextureMb: 0, sourceRefreshes: 0,
  inputLatencyP95Ms: 0, gpuTextureCount: 0, jsHeapMb: 0, memoryPressure: false,
  resourceProtectionActivations: 0
};
const inputLatencySamples: number[] = [];

const EVENT_NAME = 'refmind3d-performance-metrics';

export function updatePerformanceMetrics(patch: Partial<PerformanceMetrics>) {
  Object.assign(metrics, patch);
  window.dispatchEvent(new Event(EVENT_NAME));
}

export function recordImageCacheResult(hit: boolean) {
  if (hit) metrics.imageCacheHits += 1;
  else metrics.imageCacheMisses += 1;
}

export function recordProjectSave(milliseconds: number) {
  updatePerformanceMetrics({ lastSaveMs: Math.round(milliseconds) });
}
export function recordProjectOpen(milliseconds: number) { updatePerformanceMetrics({ projectOpenMs: Math.round(milliseconds) }); }

export function recordSourceRefresh() {
  metrics.sourceRefreshes += 1;
}

export function recordInputLatency(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 1000) return;
  inputLatencySamples.push(milliseconds);
  if (inputLatencySamples.length > 120) inputLatencySamples.shift();
  const ordered = inputLatencySamples.slice().sort((a, b) => a - b);
  metrics.inputLatencyP95Ms = Math.round((ordered[Math.floor((ordered.length - 1) * .95)] || 0) * 10) / 10;
}

export function performanceMetricsSnapshot(): PerformanceMetrics {
  return { ...metrics };
}

export function subscribePerformanceMetrics(listener: () => void) {
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
