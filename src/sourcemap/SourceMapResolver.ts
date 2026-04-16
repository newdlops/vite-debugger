import * as http from 'http';
import * as path from 'path';
import { SourceMapConsumer, RawSourceMap, SourceMapConsumer as SMC } from 'source-map';
import { SourceMapCache } from './SourceMapCache';
import { logger } from '../util/Logger';

export interface OriginalLocation {
  source: string;   // Absolute file path
  line: number;     // 1-based
  column: number;   // 0-based
}

export interface GeneratedLocation {
  scriptId: string;
  lineNumber: number;   // 0-based (CDP convention)
  columnNumber: number; // 0-based
}

interface ScriptEntry {
  scriptId: string;
  url: string;
  sourceMapUrl: string;
  sources: string[];  // Resolved absolute file paths from the source map
  /** The `file` field from the source map — often the absolute path of the original file */
  sourceMapFile: string | undefined;
  /** Whether the source map has been fetched and parsed */
  loaded: boolean;
}

/** Lightweight metadata stored immediately on scriptParsed */
interface ScriptMeta {
  scriptId: string;
  url: string;
  sourceMapUrl: string;
}

function httpGet(url: string, timeout: number = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      const statusCode = res.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        // Consume response to free the socket
        res.resume();
        reject(new Error(`HTTP ${statusCode} for ${url}`));
        return;
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout after ${timeout}ms for ${url}`)); });
  });
}

async function httpGetWithRetry(url: string, retries: number = 2, timeout: number = 5000): Promise<string> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await httpGet(url, timeout);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < retries) {
        // Exponential backoff: 200ms, 600ms
        await new Promise(r => setTimeout(r, 200 * (attempt + 1) * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

function resolveSourceMapUrl(scriptUrl: string, sourceMapUrl: string): string {
  if (sourceMapUrl.startsWith('http://') || sourceMapUrl.startsWith('https://')) {
    return sourceMapUrl;
  }
  if (sourceMapUrl.startsWith('data:')) {
    return sourceMapUrl;
  }
  const base = scriptUrl.substring(0, scriptUrl.lastIndexOf('/') + 1);
  return base + sourceMapUrl;
}

export class SourceMapResolver {
  private cache = new SourceMapCache();
  private scripts = new Map<string, ScriptEntry>();
  private scriptMetas = new Map<string, ScriptMeta>();  // scriptId -> metadata (pre-load)
  private sourceToScripts = new Map<string, Set<string>>();  // filePath -> Set<scriptId>
  private webRoot: string;
  private viteRoot: string;
  private registeredScriptCount = 0;
  private pendingSourceMisses = new Set<string>();  // Tracks already-logged "no scripts" sources
  private loadingPromises = new Map<string, Promise<void>>();  // Prevent duplicate loads
  private failedScripts = new Set<string>();  // scriptIds whose source map failed to load
  /** Callback invoked after a source map is successfully loaded (for resolving pending breakpoints) */
  onSourceMapLoaded: ((scriptId: string) => void) | null = null;

  constructor(webRoot: string, viteRoot?: string) {
    this.webRoot = webRoot.replace(/\/$/, '');
    this.viteRoot = (viteRoot ?? webRoot).replace(/\/$/, '');
  }

  /**
   * Track a script for lazy source map loading. Called immediately on scriptParsed.
   * Only stores metadata — does NOT fetch or parse the source map.
   */
  trackScript(scriptId: string, url: string, sourceMapUrl?: string): void {
    if (!sourceMapUrl || !url) return;
    const resolvedSmUrl = resolveSourceMapUrl(url, sourceMapUrl);
    this.scriptMetas.set(scriptId, { scriptId, url, sourceMapUrl: resolvedSmUrl });

    // Clean up old entry for same URL (HMR reload)
    for (const [existingId, meta] of this.scriptMetas) {
      if (meta.url === url && existingId !== scriptId) {
        this.unregisterScript(existingId);
        this.scriptMetas.delete(existingId);
        break;
      }
    }
  }

  /**
   * Ensure the source map for a script is loaded. Fetches and parses on first call,
   * returns immediately on subsequent calls. Safe to call concurrently.
   */
  async ensureSourceMap(scriptId: string): Promise<boolean> {
    // Already loaded
    if (this.cache.has(scriptId)) return true;

    // Loading in progress — wait for it
    const existing = this.loadingPromises.get(scriptId);
    if (existing) {
      await existing;
      return this.cache.has(scriptId);
    }

    // Need to load — get metadata
    const meta = this.scriptMetas.get(scriptId);
    if (!meta) return false;

    const promise = this.loadSourceMap(scriptId, meta);
    this.loadingPromises.set(scriptId, promise);
    try {
      await promise;
    } finally {
      this.loadingPromises.delete(scriptId);
    }
    return this.cache.has(scriptId);
  }

  private async loadSourceMap(scriptId: string, meta: ScriptMeta): Promise<void> {
    try {
      const { consumer, rawMap } = await this.fetchAndParseSourceMap(scriptId, meta.sourceMapUrl);
      if (!consumer) {
        this.failedScripts.add(scriptId);
        return;
      }

      const sourceMapFile: string | undefined = rawMap.file;
      const sourceMapFileDir = sourceMapFile ? path.dirname(sourceMapFile) : undefined;

      this.registeredScriptCount++;

      // Collect unique source names from mappings
      const sourceNames = new Set<string>();
      consumer.eachMapping((mapping) => {
        if (mapping.source) sourceNames.add(mapping.source);
      });

      const sources: string[] = [];
      for (const sourceName of sourceNames) {
        const resolved = this.resolveSourcePath(sourceName, meta.url, sourceMapFileDir);
        sources.push(resolved);

        if (!this.sourceToScripts.has(resolved)) {
          this.sourceToScripts.set(resolved, new Set());
        }
        this.sourceToScripts.get(resolved)!.add(scriptId);
      }

      this.scripts.set(scriptId, {
        scriptId, url: meta.url, sourceMapUrl: meta.sourceMapUrl,
        sources, sourceMapFile, loaded: true,
      });

      // Clear from failed set if a retry succeeded
      this.failedScripts.delete(scriptId);
      // Clear pending misses for resolved sources so they can be looked up again
      for (const s of sources) {
        this.pendingSourceMisses.delete(s);
      }

      logger.debug(`Source map loaded for ${meta.url}: ${sources.length} source(s) [${sources.map(s => s.split('/').pop()).join(', ')}]`);

      // Notify listener (e.g., breakpoint manager) that new source mappings are available
      if (this.onSourceMapLoaded) {
        try { this.onSourceMapLoaded(scriptId); } catch {}
      }
    } catch (e) {
      this.failedScripts.add(scriptId);
      logger.warn(`Failed to load source map for ${meta.url} (${meta.sourceMapUrl.startsWith('data:') ? 'data URI' : meta.sourceMapUrl}): ${e}`);
    }
  }

  /** Eagerly register a script with source map (used for breakpoint resolution on scriptParsed) */
  async registerScript(scriptId: string, url: string, sourceMapUrl?: string): Promise<void> {
    this.trackScript(scriptId, url, sourceMapUrl);
    await this.ensureSourceMap(scriptId);
  }

  /**
   * Retry loading source maps that previously failed.
   * Returns scriptIds that were successfully loaded on retry.
   */
  async retryFailed(): Promise<string[]> {
    const loaded: string[] = [];
    for (const scriptId of [...this.failedScripts]) {
      const meta = this.scriptMetas.get(scriptId);
      if (!meta) {
        this.failedScripts.delete(scriptId);
        continue;
      }
      try {
        await this.loadSourceMap(scriptId, meta);
        if (this.cache.has(scriptId)) {
          loaded.push(scriptId);
        }
      } catch {
        // Still failing — will be retried next time
      }
    }
    if (loaded.length > 0) {
      logger.info(`Retried source maps: ${loaded.length} recovered`);
    }
    return loaded;
  }

  hasFailedScripts(): boolean {
    return this.failedScripts.size > 0;
  }

  unregisterScript(scriptId: string): void {
    const entry = this.scripts.get(scriptId);
    if (!entry) return;

    for (const source of entry.sources) {
      const scripts = this.sourceToScripts.get(source);
      if (scripts) {
        scripts.delete(scriptId);
        if (scripts.size === 0) {
          this.sourceToScripts.delete(source);
        }
      }
    }

    this.cache.delete(scriptId);
    this.scripts.delete(scriptId);
  }

  async originalToGenerated(filePath: string, line: number, column: number = 0): Promise<GeneratedLocation | null> {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const scriptIds = this.sourceToScripts.get(normalizedPath);
    if (!scriptIds || scriptIds.size === 0) {
      if (!this.pendingSourceMisses.has(normalizedPath)) {
        this.pendingSourceMisses.add(normalizedPath);
        logger.debug(`No scripts registered for source: ${normalizedPath}`);
      }
      return null;
    }

    for (const scriptId of scriptIds) {
      const consumer = this.cache.get(scriptId);
      if (!consumer) continue;

      const entry = this.scripts.get(scriptId);
      if (!entry) continue;

      const sourceName = this.findSourceName(consumer, normalizedPath, entry.url, entry.sourceMapFile);
      if (!sourceName) continue;

      // Use allGeneratedPositionsFor to get ALL generated positions for this
      // original location. Vite/SWC source maps often have multiple mappings
      // for the same original line — e.g., the actual statement AND the
      // @react-refresh wrapper code at the bottom of the file.
      // We pick the EARLIEST generated position (lowest line number) because
      // the actual function body comes before the refresh wrapper code.
      const allPositions = consumer.allGeneratedPositionsFor({
        source: sourceName,
        line,
        column,
      });

      if (allPositions.length > 0) {
        // Sort by line, then column — pick the earliest position
        allPositions.sort((a, b) => {
          if (a.line !== b.line) return (a.line ?? 0) - (b.line ?? 0);
          return (a.column ?? 0) - (b.column ?? 0);
        });

        const best = allPositions[0];
        if (best.line !== null) {
          if (allPositions.length > 1) {
            logger.debug(
              `originalToGenerated: ${allPositions.length} mappings for ` +
              `${sourceName}:${line} — picked generated ${best.line}:${best.column ?? 0} ` +
              `(others: ${allPositions.slice(1).map(p => `${p.line}:${p.column ?? 0}`).join(', ')})`
            );
          }
          return {
            scriptId,
            lineNumber: best.line - 1,
            columnNumber: best.column ?? 0,
          };
        }
      }

      // Fallback: try LEAST_UPPER_BOUND for lines with no exact mapping
      const generated = consumer.generatedPositionFor({
        source: sourceName,
        line,
        column,
        // @ts-ignore — bias is supported but not in all type definitions
        bias: 2,  // SourceMapConsumer.LEAST_UPPER_BOUND
      });

      if (generated.line !== null) {
        return {
          scriptId,
          lineNumber: generated.line - 1,
          columnNumber: generated.column ?? 0,
        };
      }
    }

    return null;
  }

  async generatedToOriginal(scriptId: string, lineNumber: number, columnNumber: number = 0): Promise<OriginalLocation | null> {
    // Lazy load: if source map not yet loaded, load it now
    if (!this.cache.has(scriptId) && this.scriptMetas.has(scriptId)) {
      await this.ensureSourceMap(scriptId);
    }

    const consumer = this.cache.get(scriptId);
    if (!consumer) return null;

    const entry = this.scripts.get(scriptId);
    if (!entry) return null;

    const sourceMapFileDir = entry.sourceMapFile ? path.dirname(entry.sourceMapFile) : undefined;

    // GREATEST_LOWER_BOUND (default): find the mapping at or just before
    // the given position. This is critical for Vite's 1-line minified output
    // where code like `line 1, column 3000` needs to find the nearest mapping
    // segment at `column <= 3000` on the same line.
    const original = consumer.originalPositionFor({
      line: lineNumber + 1,
      column: columnNumber,
    });

    if (original.source !== null && original.line !== null) {
      return {
        source: this.resolveSourcePath(original.source, entry.url, sourceMapFileDir),
        line: original.line,
        column: original.column ?? 0,
      };
    }

    // LEAST_UPPER_BOUND: if no mapping at-or-before, try at-or-after.
    // This helps when paused at the very start of a mapping segment.
    const upper = consumer.originalPositionFor({
      line: lineNumber + 1,
      column: columnNumber,
      // @ts-ignore — bias is supported but not in all type definitions
      bias: 2,  // SourceMapConsumer.LEAST_UPPER_BOUND
    });

    if (upper.source !== null && upper.line !== null) {
      return {
        source: this.resolveSourcePath(upper.source, entry.url, sourceMapFileDir),
        line: upper.line,
        column: upper.column ?? 0,
      };
    }

    // No mapping on this line at all — search backwards through previous lines.
    // This handles multi-line generated code where some lines have no mappings.
    for (let searchLine = lineNumber - 1; searchLine >= Math.max(0, lineNumber - 50); searchLine--) {
      const prev = consumer.originalPositionFor({
        line: searchLine + 1,
        column: Infinity,  // Find the LAST mapping on the previous line
      });
      if (prev.source !== null && prev.line !== null) {
        return {
          source: this.resolveSourcePath(prev.source, entry.url, sourceMapFileDir),
          line: prev.line,
          column: prev.column ?? 0,
        };
      }
    }

    return null;
  }

  getScriptsForSource(filePath: string): string[] {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const scripts = this.sourceToScripts.get(normalizedPath);
    return scripts ? [...scripts] : [];
  }

  /**
   * Get the source file paths mapped by a given scriptId.
   * Returns an empty array if the script's source map hasn't been loaded yet.
   */
  getSourcesForScript(scriptId: string): string[] {
    const entry = this.scripts.get(scriptId);
    return entry ? [...entry.sources] : [];
  }

  hasSourceMap(scriptId: string): boolean {
    return this.cache.has(scriptId) || this.scriptMetas.has(scriptId);
  }

  /** The script has a declared sourceMappingURL (metadata registered). */
  hasSourceMapUrl(scriptId: string): boolean {
    return this.scriptMetas.has(scriptId);
  }

  /** The source map has been successfully fetched and parsed. */
  isSourceMapLoaded(scriptId: string): boolean {
    return this.cache.has(scriptId);
  }

  /** Source map fetch was attempted and failed (will be retried on explicit retry). */
  hasSourceMapFailed(scriptId: string): boolean {
    return this.failedScripts.has(scriptId);
  }

  /** Source map load is currently in flight. */
  isSourceMapLoading(scriptId: string): boolean {
    return this.loadingPromises.has(scriptId);
  }

  /**
   * Get the primary source file path for a script from its source map.
   * Returns the first resolved source path, which is typically the original
   * .tsx/.ts file. Used as fallback when generatedToOriginal fails for
   * specific positions (e.g., Vite-injected wrapper code).
   */
  getPrimarySourceForScript(scriptId: string): string | null {
    const entry = this.scripts.get(scriptId);
    if (!entry || entry.sources.length === 0) return null;
    return entry.sources[0];
  }

  getRegisteredScriptCount(): number {
    return this.registeredScriptCount;
  }

  /**
   * Compute blackbox positions for Vite-injected preamble/epilogue in a script.
   *
   * Handles both multi-line and single-line (minified) scripts:
   * - Multi-line: blackbox lines before first mapping and after last mapping
   * - Single-line (line 0 only): blackbox columns before first mapping column
   *   and after last mapping column on that single line
   */
  getBlackboxPositions(scriptId: string, scriptEndLine: number): Array<{ lineNumber: number; columnNumber: number }> | null {
    const consumer = this.cache.get(scriptId);
    if (!consumer) return null;

    // Find the bounds of source-mapped regions
    let firstMappedLine = Infinity;
    let lastMappedLine = -1;
    let firstMappedCol = Infinity;
    let lastMappedCol = -1;

    consumer.eachMapping((mapping) => {
      if (!mapping.source) return;
      const line = mapping.generatedLine - 1;  // 0-based
      const col = mapping.generatedColumn;      // already 0-based

      if (line < firstMappedLine || (line === firstMappedLine && col < firstMappedCol)) {
        firstMappedLine = line;
        firstMappedCol = col;
      }
      if (line > lastMappedLine || (line === lastMappedLine && col > lastMappedCol)) {
        lastMappedLine = line;
        lastMappedCol = col;
      }
    });

    if (lastMappedLine < 0) return null;  // No mappings at all

    const isSingleLine = (scriptEndLine === 0) || (firstMappedLine === lastMappedLine && firstMappedLine === 0);
    const positions: Array<{ lineNumber: number; columnNumber: number }> = [];

    if (isSingleLine) {
      // Single-line script: blackbox preamble columns (before first mapping)
      if (firstMappedCol > 0) {
        positions.push({ lineNumber: 0, columnNumber: 0 });
        positions.push({ lineNumber: 0, columnNumber: firstMappedCol });
      }
      // We skip epilogue blackboxing for single-line scripts because
      // lastMappedCol is just the start of the last mapping, not its end.
      // Chrome's blackbox would cut off the tail of user code.
    } else {
      // Multi-line script: blackbox preamble lines
      if (firstMappedLine > 0) {
        positions.push({ lineNumber: 0, columnNumber: 0 });
        positions.push({ lineNumber: firstMappedLine, columnNumber: 0 });
      }
      // Blackbox epilogue lines
      if (lastMappedLine < scriptEndLine) {
        positions.push({ lineNumber: lastMappedLine + 1, columnNumber: 0 });
        positions.push({ lineNumber: scriptEndLine + 1, columnNumber: 0 });
      }
    }

    return positions.length > 0 ? positions : null;
  }

  clear(): void {
    this.cache.clear();
    this.scripts.clear();
    this.scriptMetas.clear();
    this.sourceToScripts.clear();
    this.loadingPromises.clear();
    this.failedScripts.clear();
    this.registeredScriptCount = 0;
    this.pendingSourceMisses.clear();
  }

  // --- Private ---

  private async fetchAndParseSourceMap(
    scriptId: string,
    sourceMapUrl: string
  ): Promise<{ consumer: SourceMapConsumer | null; rawMap: RawSourceMap }> {
    let rawMapStr: string;

    if (sourceMapUrl.startsWith('data:')) {
      const match = sourceMapUrl.match(/^data:[^;]+;base64,(.+)$/);
      if (!match) {
        logger.warn(`Invalid data URI source map for script ${scriptId}`);
        return { consumer: null, rawMap: {} as RawSourceMap };
      }
      rawMapStr = Buffer.from(match[1], 'base64').toString('utf-8');
    } else {
      rawMapStr = await httpGetWithRetry(sourceMapUrl, 2, 8000);
    }

    let rawMap: RawSourceMap;
    try {
      rawMap = JSON.parse(rawMapStr);
    } catch (e) {
      logger.warn(`Invalid JSON in source map for ${scriptId}: ${rawMapStr.substring(0, 100)}...`);
      return { consumer: null, rawMap: {} as RawSourceMap };
    }

    if (!rawMap.mappings && !(rawMap as any).sections) {
      logger.warn(`Source map for ${scriptId} has no mappings (keys: ${Object.keys(rawMap).join(', ')})`);
      return { consumer: null, rawMap };
    }

    const consumer = await new SourceMapConsumer(rawMap);
    this.cache.set(scriptId, consumer);
    return { consumer, rawMap };
  }

  /**
   * Resolve a source name from the source map to an absolute file path.
   *
   * Vite source maps typically have:
   *   - sources: ["index.tsx"] (just filename, relative)
   *   - file: "/Users/.../src/index.tsx" (absolute path of the original file)
   *
   * We use the `file` field's directory as the base for resolving relative sources.
   */
  private resolveSourcePath(source: string, scriptUrl: string, sourceMapFileDir?: string): string {
    // Skip empty source names (would resolve to a directory)
    if (!source || source === '.' || source === './') {
      return scriptUrl;
    }

    // Already absolute path
    if (source.startsWith('/') && !source.startsWith('//')) {
      return source;
    }

    // Webpack-style: webpack:///src/App.tsx
    const webpackMatch = source.match(/^webpack:\/\/\/(.+)$/);
    if (webpackMatch) {
      return path.join(this.webRoot, webpackMatch[1]);
    }

    // Best strategy: resolve relative to the source map's `file` directory
    // This is the most reliable for Vite because:
    //   file = "/Users/lky/project/captain/zuzu/client/src/index.tsx"
    //   sources = ["index.tsx"]
    //   → resolve("index.tsx") relative to "/Users/lky/project/captain/zuzu/client/src/"
    //   = "/Users/lky/project/captain/zuzu/client/src/index.tsx"
    if (sourceMapFileDir) {
      return path.resolve(sourceMapFileDir, source);
    }

    // Handle Vite /@fs/ URLs — these map directly to absolute filesystem paths
    try {
      const urlPath = new URL(scriptUrl).pathname;
      if (urlPath.startsWith('/@fs/')) {
        const fsDir = urlPath.slice(4, urlPath.lastIndexOf('/'));  // strip /@fs prefix
        return path.resolve(fsDir, source);
      }
    } catch {
      // fall through
    }

    // Fallback: resolve relative to script URL path mapped through viteRoot
    // Vite serves files relative to its project root, so URL path /src/App.tsx
    // maps to <viteRoot>/src/App.tsx, not <webRoot>/src/App.tsx
    try {
      const scriptDir = scriptUrl.substring(0, scriptUrl.lastIndexOf('/'));
      const scriptPath = new URL(scriptDir).pathname;
      return path.resolve(this.viteRoot + scriptPath, source);
    } catch {
      return path.resolve(this.viteRoot, source);
    }
  }

  private findSourceName(
    consumer: SourceMapConsumer,
    filePath: string,
    scriptUrl: string,
    sourceMapFile?: string,
  ): string | null {
    let match: string | null = null;
    const seen = new Set<string>();
    const sourceMapFileDir = sourceMapFile ? path.dirname(sourceMapFile) : undefined;

    consumer.eachMapping((mapping) => {
      if (match || !mapping.source || seen.has(mapping.source)) return;
      seen.add(mapping.source);
      const resolved = this.resolveSourcePath(mapping.source, scriptUrl, sourceMapFileDir);
      if (resolved === filePath) {
        match = mapping.source;
      }
    });

    return match;
  }
}
