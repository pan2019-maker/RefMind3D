export interface PerformanceMetrics {
  totalNodes: number;
  renderedNodes: number;
  visibleNodes: number;
  activeModels: number;
  activeVideos: number;
  imageMemoryEntries: number;
  imageLoadsActive: number;
  imageLoadsQueued: number;
  imageCacheHits: number;
  imageCacheMisses: number;
  fps: number;
  slowFrames: number;
  lastSaveMs?: number;
}

const metrics: PerformanceMetrics = {
  totalNodes: 0, renderedNodes: 0, visibleNodes: 0, activeModels: 0, activeVideos: 0,
  imageMemoryEntries: 0, imageLoadsActive: 0, imageLoadsQueued: 0,
  imageCacheHits: 0, imageCacheMisses: 0, fps: 0, slowFrames: 0
};

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

export function performanceMetricsSnapshot(): PerformanceMetrics {
  return { ...metrics };
}

export function subscribePerformanceMetrics(listener: () => void) {
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
