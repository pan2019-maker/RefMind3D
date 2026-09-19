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
  kind?: 'anchor' | 'spacing';
}

function anchors(start: number, size: number) {
  return [start, start + size / 2, start + size];
}

function commonGap(rects: SnapRect[], axis: 'x' | 'y') {
  const sorted = rects.slice().sort((a, b) => a[axis] - b[axis]);
  const gaps: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const size = axis === 'x' ? previous.width : previous.height;
    const gap = sorted[index][axis] - (previous[axis] + size);
    if (gap >= 0 && gap <= 400) gaps.push(gap);
  }
  if (gaps.length === 0) return undefined;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
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
  const horizontalGap = commonGap(stationary, 'x');
  const verticalGap = commonGap(stationary, 'y');
  if (horizontalGap !== undefined) for (const node of stationary) {
    for (const target of [node.x + node.width + horizontalGap, node.x - moving.width - horizontalGap]) {
      const delta = target - moving.x;
      if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, value: target };
    }
  }
  if (verticalGap !== undefined) for (const node of stationary) {
    for (const target of [node.y + node.height + verticalGap, node.y - moving.height - verticalGap]) {
      const delta = target - moving.y;
      if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { delta, value: target };
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
