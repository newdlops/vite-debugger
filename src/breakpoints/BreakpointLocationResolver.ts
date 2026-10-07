import type { CdpClient } from '../cdp/CdpClient';
import { SourceMapResolver } from '../sourcemap/SourceMapResolver';

export interface MappedBreakpointLocation {
  scriptId: string;
  lineNumber: number;
  columnNumber: number;
  source: string;
  originalLine: number;
  originalColumn: number;
}

interface CachedLine {
  scriptId: string;
  locations: MappedBreakpointLocation[];
  bySource: Map<string, Map<number, MappedBreakpointLocation[]>>;
}

/** Shared by breakpoint placement and gutter location requests. A script's
 * executable locations are immutable until its source-map revision changes.
 * Both entry and location budgets bound retained memory for minified bundles. */
export class BreakpointLocationResolver {
  private cache = new Map<string, CachedLine>();
  private pending = new Map<string, { scriptId: string; promise: Promise<CachedLine | null> }>();
  private retainedLocations = 0;
  private epoch = 0;
  private unsubscribe: () => void;

  constructor(
    private cdp: CdpClient,
    private sourceMaps: SourceMapResolver,
    private limits: { maxEntries: number; maxLocations: number } = { maxEntries: 128, maxLocations: 25_000 },
  ) {
    this.unsubscribe = sourceMaps.onScriptRemoved((scriptId) => this.forgetScript(scriptId));
  }

  async forOriginalLine(sourcePath: string, line: number, scriptId: string): Promise<MappedBreakpointLocation[]> {
    if (!await this.sourceMaps.ensureSourceMap(scriptId)) return [];
    const normalized = sourcePath.replace(/\\/g, '/');
    const lines = this.sourceMaps.getGeneratedLinesForOriginalLine(normalized, line, scriptId);
    const results = await Promise.all(lines.map((generatedLine) => this.loadLine(scriptId, generatedLine)));
    return results.flatMap((entry) => entry?.bySource.get(normalized)?.get(line) ?? []);
  }

  async forGeneratedLine(scriptId: string, lineNumber: number): Promise<readonly MappedBreakpointLocation[]> {
    return (await this.loadLine(scriptId, lineNumber))?.locations ?? [];
  }

  clear(): void {
    this.epoch++;
    this.cache.clear();
    this.pending.clear();
    this.retainedLocations = 0;
  }

  dispose(): void {
    this.clear();
    this.unsubscribe();
  }

  private forgetScript(scriptId: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.scriptId !== scriptId) continue;
      this.retainedLocations -= entry.locations.length;
      this.cache.delete(key);
    }
    for (const [key, entry] of this.pending) {
      if (entry.scriptId === scriptId) this.pending.delete(key);
    }
  }

  private async loadLine(scriptId: string, lineNumber: number): Promise<CachedLine | null> {
    const revision = this.sourceMaps.getScriptRevision(scriptId);
    if (revision === undefined) return null;
    const key = JSON.stringify([scriptId, revision, lineNumber]);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const existing = this.pending.get(key);
    if (existing) return existing.promise;
    const promise = this.queryLine(scriptId, lineNumber, revision, key, this.epoch);
    this.pending.set(key, { scriptId, promise });
    try {
      return await promise;
    } finally {
      if (this.pending.get(key)?.promise === promise) this.pending.delete(key);
    }
  }

  private async queryLine(scriptId: string, lineNumber: number, revision: number, key: string, epoch: number): Promise<CachedLine | null> {
    try {
      if (!await this.sourceMaps.ensureSourceMap(scriptId)) return null;
      const raw = await this.cdp.getPossibleBreakpoints(
        { scriptId, lineNumber, columnNumber: 0 },
        { scriptId, lineNumber: lineNumber + 1, columnNumber: 0 },
      );
      const entry: CachedLine = { scriptId, locations: [], bySource: new Map() };
      for (const location of raw) {
        const original = await this.sourceMaps.generatedToOriginal(
          scriptId, location.lineNumber, location.columnNumber ?? 0, false,
        );
        if (!original) continue;
        const mapped: MappedBreakpointLocation = {
          scriptId, lineNumber: location.lineNumber, columnNumber: location.columnNumber ?? 0,
          source: original.source, originalLine: original.line, originalColumn: original.column,
        };
        entry.locations.push(mapped);
        let source = entry.bySource.get(original.source);
        if (!source) entry.bySource.set(original.source, source = new Map());
        let line = source.get(original.line);
        if (!line) source.set(original.line, line = []);
        line.push(mapped);
      }
      if (this.epoch !== epoch || this.sourceMaps.getScriptRevision(scriptId) !== revision
        || !this.sourceMaps.isSourceMapLoaded(scriptId)) return null;
      if (entry.locations.length <= this.limits.maxLocations && this.limits.maxEntries > 0) {
        while (this.cache.size >= this.limits.maxEntries
          || this.retainedLocations + entry.locations.length > this.limits.maxLocations) {
          const oldest = this.cache.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.retainedLocations -= this.cache.get(oldest)!.locations.length;
          this.cache.delete(oldest);
        }
        this.cache.set(key, entry);
        this.retainedLocations += entry.locations.length;
      }
      return entry;
    } catch {
      // Stale scripts and failed requests must be retried, never cached as
      // proof that a currently live script has no executable locations.
      return null;
    }
  }
}
