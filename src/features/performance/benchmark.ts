import { SpatialGridIndex } from '../canvas/spatialIndex';

export type BenchmarkResult = { nodeCount: number; buildMs: number; queryMs: number; transformMs: number; tileSelectionMs: number; soakCycles: number; soakMs: number; estimatedPeakMb: number; averageHits: number };

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
  const queryMs = performance.now() - queryStart;
  const transformStart = performance.now();
  if (typeof document !== 'undefined') {
    const surface = document.createElement('div');
    for (let index = 0; index < Math.min(nodeCount, 2_000); index += 1) surface.appendChild(document.createElement('div'));
    for (let frame = 0; frame < 120; frame += 1) surface.style.transform = `translate3d(${frame * 7}px,${frame * 3}px,0) scale(${1 + frame / 1000})`;
    surface.replaceChildren();
  }
  const transformMs = performance.now() - transformStart;
  const tileStart = performance.now(); let visibleTiles = 0;
  for (let frame = 0; frame < 120; frame += 1) for (let image = 0; image < 1_000; image += 1) {
    const tileX = (frame * 173 + image * 997) % 8_192; const tileY = (frame * 89 + image * 313) % 8_192;
    visibleTiles += Math.ceil((Math.min(8_192, tileX + 1_920) - tileX) / 1_024) * Math.ceil((Math.min(8_192, tileY + 1_080) - tileY) / 1_024);
  }
  const tileSelectionMs = performance.now() - tileStart;
  const soakCycles = 80; const soakStart = performance.now();
  for (let cycle = 0; cycle < soakCycles; cycle += 1) {
    const probe = JSON.stringify({ cycle, nodes: nodes.slice(cycle, cycle + 250) });
    JSON.parse(probe); index.query({ x: cycle * 70, y: cycle * 31, width: 2560, height: 1440 });
    if (cycle % 8 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const soakMs = performance.now() - soakStart;
  return { nodeCount, buildMs: Math.round(buildMs * 10) / 10, queryMs: Math.round(queryMs * 10) / 10, transformMs: Math.round(transformMs * 10) / 10, tileSelectionMs: Math.round(tileSelectionMs * 10) / 10, soakCycles, soakMs: Math.round(soakMs * 10) / 10, estimatedPeakMb: Math.round((visibleTiles / 120 * 4 + Math.min(nodeCount, 2_000) * .02) * 10) / 10, averageHits: Math.round(hits / 200) };
}

export async function runCanvasBenchmarkSuite(nodeCounts = [1_000, 5_000, 10_000]) {
  const results: BenchmarkResult[] = [];
  for (const nodeCount of nodeCounts) results.push(await runCanvasBenchmark(nodeCount));
  return results;
}
