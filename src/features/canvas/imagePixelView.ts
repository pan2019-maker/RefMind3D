export function imagePixelViewScale(
  node: { width: number; height: number },
  source: { width: number; height: number },
  devicePixelRatio: number,
  pixelsPerSourcePixel = 1
) {
  const fittedCanvasUnitsPerPixel = Math.min(node.width / Math.max(1, source.width), node.height / Math.max(1, source.height));
  return Math.max(.001, pixelsPerSourcePixel / (fittedCanvasUnitsPerPixel * Math.max(1, devicePixelRatio)));
}
