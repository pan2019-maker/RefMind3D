export type ResourceBudget = { models: number; videos: number; fullImages: number };
export type QualityTier = 'full' | 'balanced' | 'responsive';

export function nextQualityTier(current: QualityTier, fps: number, memoryPressure = false): QualityTier {
  if (memoryPressure || (fps > 0 && fps < 38)) return 'responsive';
  if (current === 'responsive') return fps >= 48 ? 'balanced' : 'responsive';
  if (current === 'balanced') {
    if (fps >= 58) return 'full';
    return fps < 44 ? 'responsive' : 'balanced';
  }
  return fps > 0 && fps < 52 ? 'balanced' : 'full';
}

export function adaptiveResourceBudget(nodeCount: number, deviceMemoryGb = 8, fps = 60): ResourceBudget {
  const pressure = fps > 0 && fps < 42 ? 0.5 : fps > 0 && fps < 52 ? 0.75 : 1;
  const memory = deviceMemoryGb <= 4 ? 0.5 : deviceMemoryGb <= 8 ? 0.75 : 1;
  const scale = Math.min(pressure, memory, nodeCount >= 20_000 ? 0.45 : nodeCount >= 5_000 ? 0.7 : 1);
  return {
    models: Math.max(1, Math.round(4 * scale)),
    videos: Math.max(2, Math.round(8 * scale)),
    fullImages: Math.max(4, Math.round(12 * scale))
  };
}


export function adaptiveImageConcurrency(deviceMemoryGb = 8, fps = 60) {
  if ((fps > 0 && fps < 42) || deviceMemoryGb <= 4) return 1;
  if ((fps > 0 && fps < 54) || deviceMemoryGb <= 8) return 2;
  return 4;
}
