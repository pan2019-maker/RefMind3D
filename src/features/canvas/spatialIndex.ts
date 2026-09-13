export interface SpatialRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpatialItem extends SpatialRect {
  id: string;
}

/**
 * A compact uniform-grid index tuned for reference boards. The index is rebuilt
 * only when node geometry changes; camera movement then touches just the cells
 * around the viewport instead of scanning the whole project.
 */
export class SpatialGridIndex<T extends SpatialItem> {
  private readonly cells = new Map<string, T[]>();
  private readonly oversized: T[] = [];

  constructor(items: T[], private readonly cellSize = 1024) {
    for (const item of items) this.insert(item);
  }

  private cellRange(item: SpatialRect) {
    const left = Math.floor(item.x / this.cellSize);
    const top = Math.floor(item.y / this.cellSize);
    const right = Math.floor((item.x + Math.max(0, item.width)) / this.cellSize);
    const bottom = Math.floor((item.y + Math.max(0, item.height)) / this.cellSize);
    return { left, top, right, bottom };
  }

  private insert(item: T) {
    const range = this.cellRange(item);
    const cellCount = (range.right - range.left + 1) * (range.bottom - range.top + 1);
    // Very large group boxes should not be duplicated into thousands of cells.
    if (cellCount > 256) {
      this.oversized.push(item);
      return;
    }
    for (let y = range.top; y <= range.bottom; y += 1) {
      for (let x = range.left; x <= range.right; x += 1) {
        const key = `${x}:${y}`;
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(item);
        else this.cells.set(key, [item]);
      }
    }
  }

  query(rect: SpatialRect): T[] {
    const range = this.cellRange(rect);
    const found = new Map<string, T>();
    for (let y = range.top; y <= range.bottom; y += 1) {
      for (let x = range.left; x <= range.right; x += 1) {
        for (const item of this.cells.get(`${x}:${y}`) || []) found.set(item.id, item);
      }
    }
    for (const item of this.oversized) found.set(item.id, item);
    return [...found.values()].filter((item) => intersects(item, rect));
  }
}

export function intersects(first: SpatialRect, second: SpatialRect) {
  return first.x <= second.x + second.width
    && first.x + first.width >= second.x
    && first.y <= second.y + second.height
    && first.y + first.height >= second.y;
}
