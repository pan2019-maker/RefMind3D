import { SpatialGridIndex } from '../canvas/spatialIndex';

export type BenchmarkResult = { nodeCount: number; buildMs: number; queryMs: number; averageHits: number };

export async function runCanvasBenchmark(nodeCount = 10_000): Promise<BenchmarkResult> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `benchmark-${index}`,
    x: (index % 250) * 180,
    y: Math.floor(index / 250) * 140,
    width: 160,
    height: 120
  }));
  const buildStart = performance.now();
  const index = new SpatialGridIndex(nodes);
  const buildMs = performance.now() - buildStart;
  const queryStart = performance.now();
  let hits = 0;
  for (let step = 0; step < 200; step += 1) {
    hits += index.query({ x: step * 120, y: step * 55, width: 1920, height: 1080 }).length;
  }
  return { nodeCount, buildMs: Math.round(buildMs * 10) / 10, queryMs: Math.round((performance.now() - queryStart) * 10) / 10, averageHits: Math.round(hits / 200) };
}
