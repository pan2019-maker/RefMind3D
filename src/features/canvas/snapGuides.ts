export interface SnapRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapGuide {
  axis: 'x' | 'y';
  value: number;
}

function anchors(start: number, size: number) {
  return [start, start + size / 2, start + size];
}

export function snapMovingBounds(
  moving: Omit<SnapRect, 'id'>,
  stationary: SnapRect[],
  threshold: number
): { dx: number; dy: number; guides: SnapGuide[] } {
  let bestX: { delta: number; value: number } | undefined;
  let bestY: { delta: number; value: number } | undefined;
  const movingX = anchors(moving.x, moving.width);
  const movingY = anchors(moving.y, moving.height);
  for (const node of stationary) {
    for (const fixed of anchors(node.x, node.width)) {
      for (const candidate of movingX) {
        const delta = fixed - candidate;
        if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, value: fixed };
      }
    }
    for (const fixed of anchors(node.y, node.height)) {
      for (const candidate of movingY) {
        const delta = fixed - candidate;
        if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { delta, value: fixed };
      }
    }
  }
  return {
    dx: bestX?.delta || 0,
    dy: bestY?.delta || 0,
    guides: [
      ...(bestX ? [{ axis: 'x' as const, value: bestX.value }] : []),
      ...(bestY ? [{ axis: 'y' as const, value: bestY.value }] : [])
    ]
  };
}
