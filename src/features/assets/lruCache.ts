export class LruCache<K, V> {
  private readonly values = new Map<K, V>();

  constructor(private readonly capacity: number) {}

  get size() {
    return this.values.size;
  }

  get(key: K): V | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: K, value: V) {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > Math.max(1, this.capacity)) {
      const oldest = this.values.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }

  clear() {
    this.values.clear();
  }
}
