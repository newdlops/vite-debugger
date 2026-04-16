import { SourceMapConsumer } from 'source-map';

interface CacheEntry {
  consumer: SourceMapConsumer;
  lastAccess: number;
}

export class SourceMapCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;

  constructor(maxSize: number = 200) {
    this.maxSize = maxSize;
  }

  get(key: string): SourceMapConsumer | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      entry.lastAccess = Date.now();
      return entry.consumer;
    }
    return undefined;
  }

  set(key: string, consumer: SourceMapConsumer): void {
    // Evict least recently used if at capacity
    if (this.cache.size >= this.maxSize) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.cache) {
        if (v.lastAccess < oldestTime) {
          oldestTime = v.lastAccess;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        const evicted = this.cache.get(oldestKey);
        evicted?.consumer.destroy();
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, { consumer, lastAccess: Date.now() });
  }

  delete(key: string): void {
    const entry = this.cache.get(key);
    if (entry) {
      entry.consumer.destroy();
      this.cache.delete(key);
    }
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    for (const entry of this.cache.values()) {
      entry.consumer.destroy();
    }
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
