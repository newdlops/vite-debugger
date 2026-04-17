import * as fs from 'fs';

/**
 * Shared bounded cache for `fs.statSync().isFile()` lookups. A typical debug
 * session checks the same set of paths hundreds of times (loaded sources,
 * script-parsed events, server-only probes). The first answer is cached so
 * subsequent checks cost a Map lookup, not a syscall.
 *
 * Size is capped to avoid unbounded growth on HMR-heavy sessions. The
 * replacement policy is FIFO via Map insertion order — simple and good
 * enough since debug sessions rarely churn through >2k paths.
 */
class FileExistsCache {
  private cache = new Map<string, boolean>();
  private readonly maxSize = 2000;

  existsSync(filePath: string): boolean {
    const cached = this.cache.get(filePath);
    if (cached !== undefined) return cached;

    let exists: boolean;
    try {
      exists = fs.statSync(filePath).isFile();
    } catch {
      exists = false;
    }
    this.record(filePath, exists);
    return exists;
  }

  async existsAsync(filePath: string): Promise<boolean> {
    const cached = this.cache.get(filePath);
    if (cached !== undefined) return cached;

    let exists: boolean;
    try {
      const stat = await fs.promises.stat(filePath);
      exists = stat.isFile();
    } catch {
      exists = false;
    }
    this.record(filePath, exists);
    return exists;
  }

  invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  clear(): void {
    this.cache.clear();
  }

  private record(filePath: string, exists: boolean): void {
    if (this.cache.size >= this.maxSize) {
      // Drop the oldest entry (FIFO via insertion order).
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(filePath, exists);
  }
}

export const fileExistsCache = new FileExistsCache();
