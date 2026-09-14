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
  private readonly cells = new Map<string, Map<string, T>>();
  private readonly oversized = new Map<string, T>();
  private readonly records = new Map<string, { item: T; rect: SpatialRect; cellKeys: string[] | null }>();

  constructor(items: T[], private readonly cellSize = 1024) {
    this.sync(items);
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
      this.oversized.set(item.id, item);
      this.records.set(item.id, { item, rect: geometryOf(item), cellKeys: null });
      return;
    }
    const cellKeys: string[] = [];
    for (let y = range.top; y <= range.bottom; y += 1) {
      for (let x = range.left; x <= range.right; x += 1) {
        const key = `${x}:${y}`;
        cellKeys.push(key);
        const bucket = this.cells.get(key);
        if (bucket) bucket.set(item.id, item);
        else this.cells.set(key, new Map([[item.id, item]]));
      }
    }
    this.records.set(item.id, { item, rect: geometryOf(item), cellKeys });
  }

  private remove(id: string) {
    const record = this.records.get(id);
    if (!record) return;
    if (record.cellKeys === null) {
      this.oversized.delete(id);
    } else {
      for (const key of record.cellKeys) {
        const bucket = this.cells.get(key);
        bucket?.delete(id);
        if (bucket?.size === 0) this.cells.delete(key);
      }
    }
    this.records.delete(id);
  }

  /** Synchronizes changed geometry without rebuilding buckets for every unchanged node. */
  sync(items: T[]) {
    const retained = new Set<string>();
    for (const item of items) {
      retained.add(item.id);
      const record = this.records.get(item.id);
      if (!record || !sameGeometry(record.rect, item)) {
        if (record) this.remove(item.id);
        this.insert(item);
        continue;
      }
      if (record.item === item) continue;
      record.item = item;
      if (record.cellKeys === null) this.oversized.set(item.id, item);
      else for (const key of record.cellKeys) this.cells.get(key)?.set(item.id, item);
    }
    for (const id of [...this.records.keys()]) {
      if (!retained.has(id)) this.remove(id);
    }
  }

  query(rect: SpatialRect): T[] {
    const range = this.cellRange(rect);
    const found = new Map<string, T>();
    for (let y = range.top; y <= range.bottom; y += 1) {
      for (let x = range.left; x <= range.right; x += 1) {
        for (const item of this.cells.get(`${x}:${y}`)?.values() || []) found.set(item.id, item);
      }
    }
    for (const item of this.oversized.values()) found.set(item.id, item);
    return [...found.values()].filter((item) => intersects(item, rect));
  }
}

function geometryOf(item: SpatialRect): SpatialRect {
  return { x: item.x, y: item.y, width: item.width, height: item.height };
}

function sameGeometry(first: SpatialRect, second: SpatialRect) {
  return first.x === second.x && first.y === second.y
    && first.width === second.width && first.height === second.height;
}

export function intersects(first: SpatialRect, second: SpatialRect) {
  return first.x <= second.x + second.width
    && first.x + first.width >= second.x
    && first.y <= second.y + second.height
    && first.y + first.height >= second.y;
}
