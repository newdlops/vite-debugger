import * as fs from 'fs';
import { createHash } from 'crypto';

/**
 * Computes SHA256 checksums of on-disk files for DAP `Source.checksums`.
 *
 * VSCode marks debug stack frames as "modified since session start" and dims
 * them when the user saves changes during a live debug session (common with
 * Vite HMR). Dimmed frames are skipped by VSCode's auto-focus on StoppedEvent,
 * so the yellow arrow lands on the next non-dimmed frame (typically deep in
 * react-dom). Providing an up-to-date `Source.checksums` entry lets VSCode
 * compare the disk content against our hash; when they match it trusts the
 * source and stops dimming.
 *
 * Cache key: `path + mtimeMs`. This keeps re-renders cheap without risking
 * stale hashes across edits — any save bumps mtime, invalidating the entry.
 */
class FileChecksumCache {
  private cache = new Map<string, { mtimeMs: number; sha256: string }>();
  private readonly maxSize = 500;

  async sha256(filePath: string): Promise<string | null> {
    let mtimeMs: number;
    try {
      const st = await fs.promises.stat(filePath);
      if (!st.isFile()) return null;
      mtimeMs = st.mtimeMs;
    } catch {
      return null;
    }
    const cached = this.cache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.sha256;

    let sha256: string;
    try {
      const buf = await fs.promises.readFile(filePath);
      sha256 = createHash('sha256').update(buf).digest('hex');
    } catch {
      return null;
    }
    this.record(filePath, { mtimeMs, sha256 });
    return sha256;
  }

  clear(): void {
    this.cache.clear();
  }

  private record(filePath: string, entry: { mtimeMs: number; sha256: string }): void {
    if (this.cache.size >= this.maxSize) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(filePath, entry);
  }
}

export const fileChecksumCache = new FileChecksumCache();
