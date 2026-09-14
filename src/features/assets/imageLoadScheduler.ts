export type ImageLoadPriority = 0 | 1 | 2;

interface QueueEntry<T> {
  key: string;
  priority: ImageLoadPriority;
  order: number;
  run: () => Promise<T>;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  started: boolean;
  consumers: number;
}

export class ImageLoadCancelledError extends Error {
  constructor() {
    super('Image load was cancelled before it started');
    this.name = 'ImageLoadCancelledError';
  }
}

/** Limits expensive image-cache misses while keeping visible images ahead of prewarm work. */
export class ImageLoadScheduler {
  private readonly queued: QueueEntry<unknown>[] = [];
  private readonly entries = new Map<string, QueueEntry<unknown>>();
  private active = 0;
  private order = 0;

  constructor(private readonly concurrency = 3) {}

  schedule<T>(key: string, priority: ImageLoadPriority, run: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key) as QueueEntry<T> | undefined;
    if (existing) {
      existing.consumers += 1;
      if (!existing.started && priority < existing.priority) existing.priority = priority;
      return existing.promise;
    }
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
    const entry: QueueEntry<T> = { key, priority, order: this.order++, run, promise, resolve, reject, started: false, consumers: 1 };
    this.entries.set(key, entry as QueueEntry<unknown>);
    this.queued.push(entry as QueueEntry<unknown>);
    this.pump();
    return promise;
  }

  release(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.consumers = Math.max(0, entry.consumers - 1);
    if (entry.consumers > 0 || entry.started) return;
    const index = this.queued.indexOf(entry);
    if (index >= 0) this.queued.splice(index, 1);
    this.entries.delete(key);
    entry.reject(new ImageLoadCancelledError());
  }

  get activeCount() {
    return this.active;
  }

  get queuedCount() {
    return this.queued.length;
  }

  private pump() {
    while (this.active < Math.max(1, this.concurrency) && this.queued.length > 0) {
      this.queued.sort((a, b) => (a.priority - b.priority) || (a.order - b.order));
      const entry = this.queued.shift()!;
      entry.started = true;
      this.active += 1;
      void Promise.resolve().then(entry.run).then(entry.resolve, entry.reject).finally(() => {
        this.active -= 1;
        this.entries.delete(entry.key);
        this.pump();
      });
    }
  }
}

export const imageLoadScheduler = new ImageLoadScheduler(3);
