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
}

function httpGet(url: string, timeout: number = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
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
  private sourceToScripts = new Map<string, Set<string>>();  // filePath -> Set<scriptId>
  private webRoot: string;
  private viteRoot: string;
  private registeredScriptCount = 0;
  private pendingSourceMisses = new Set<string>();  // Tracks already-logged "no scripts" sources

  constructor(webRoot: string, viteRoot?: string) {
    this.webRoot = webRoot.replace(/\/$/, '');
    this.viteRoot = (viteRoot ?? webRoot).replace(/\/$/, '');
  }

  async registerScript(scriptId: string, url: string, sourceMapUrl?: string): Promise<void> {
    if (!sourceMapUrl || !url) return;
    if (url.includes('/@vite/') && !sourceMapUrl) return;

    const resolvedSmUrl = resolveSourceMapUrl(url, sourceMapUrl);

    try {
      const { consumer, rawMap } = await this.fetchAndParseSourceMap(scriptId, resolvedSmUrl);
      if (!consumer) return;

      // Vite source maps have a `file` field with the absolute path of the original file
      // e.g., file: "/Users/lky/project/captain/zuzu/client/src/index.tsx"
      // This is the key to resolving relative `sources` entries
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
        const resolved = this.resolveSourcePath(sourceName, url, sourceMapFileDir);
        sources.push(resolved);

        if (!this.sourceToScripts.has(resolved)) {
          this.sourceToScripts.set(resolved, new Set());
        }
        this.sourceToScripts.get(resolved)!.add(scriptId);
      }

      // Individual resolved sources logged only at trace level — see getRegisteredScriptCount() for summary

      // Clean up old entry for same URL (HMR reload)
      for (const [existingId, entry] of this.scripts) {
        if (entry.url === url && existingId !== scriptId) {
          this.unregisterScript(existingId);
          break;
        }
      }

      this.scripts.set(scriptId, { scriptId, url, sourceMapUrl: resolvedSmUrl, sources, sourceMapFile });
    } catch (e) {
      logger.warn(`Failed to register source map for ${url}: ${e}`);
    }
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
    const consumer = this.cache.get(scriptId);
    if (!consumer) return null;

    const entry = this.scripts.get(scriptId);
    if (!entry) return null;

    const original = consumer.originalPositionFor({
      line: lineNumber + 1,
      column: columnNumber,
    });

    if (original.source === null || original.line === null) return null;

    const sourceMapFileDir = entry.sourceMapFile ? path.dirname(entry.sourceMapFile) : undefined;
    const resolvedPath = this.resolveSourcePath(original.source, entry.url, sourceMapFileDir);

    return {
      source: resolvedPath,
      line: original.line,
      column: original.column ?? 0,
    };
  }

  /**
   * Find the nearest mapped original location for a generated position.
   * When the exact position has no mapping (sparse source map), searches
   * nearby generated lines (up to ±maxDistance) to find the closest one
   * that DOES have a mapping. Returns null only if no mapping is found
   * within the search range.
   */
  async nearestOriginalLocation(scriptId: string, lineNumber: number, columnNumber: number = 0, maxDistance: number = 5): Promise<OriginalLocation | null> {
    // Try exact match first
    const exact = await this.generatedToOriginal(scriptId, lineNumber, columnNumber);
    if (exact) return exact;

    // Search nearby lines, preferring closer ones
    for (let delta = 1; delta <= maxDistance; delta++) {
      // Try line before
      if (lineNumber - delta >= 0) {
        const before = await this.generatedToOriginal(scriptId, lineNumber - delta, 0);
        if (before) return before;
      }
      // Try line after
      const after = await this.generatedToOriginal(scriptId, lineNumber + delta, 0);
      if (after) return after;
    }

    return null;
  }

  getScriptsForSource(filePath: string): string[] {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const scripts = this.sourceToScripts.get(normalizedPath);
    return scripts ? [...scripts] : [];
  }

  hasSourceMap(scriptId: string): boolean {
    return this.cache.has(scriptId);
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
   * Only blackboxes lines BEFORE the first source-mapped line (preamble: HMR setup,
   * _s() declarations) and AFTER the last source-mapped line (epilogue: $RefreshReg$,
   * import.meta.hot.accept). Lines in between are left alone — even unmapped gaps
   * in the middle of user code are NOT blackboxed, since sparse source maps could
   * cause legitimate user code to be skipped.
   */
  getBlackboxPositions(scriptId: string, scriptEndLine: number): Array<{ lineNumber: number; columnNumber: number }> | null {
    const consumer = this.cache.get(scriptId);
    if (!consumer) return null;

    // Find the first and last generated lines that have a source mapping
    let firstMapped = Infinity;
    let lastMapped = -1;
    consumer.eachMapping((mapping) => {
      if (mapping.source) {
        const line = mapping.generatedLine - 1;  // Convert to 0-based
        if (line < firstMapped) firstMapped = line;
        if (line > lastMapped) lastMapped = line;
      }
    });

    if (lastMapped < 0) return null;  // No mappings at all

    const positions: Array<{ lineNumber: number; columnNumber: number }> = [];

    // Blackbox preamble: lines 0..<firstMapped> (Vite HMR setup, _s() declarations)
    if (firstMapped > 0) {
      positions.push({ lineNumber: 0, columnNumber: 0 });
      positions.push({ lineNumber: firstMapped, columnNumber: 0 });
    }

    // Blackbox epilogue: lines after lastMapped ($RefreshReg$, hot.accept)
    if (lastMapped < scriptEndLine) {
      positions.push({ lineNumber: lastMapped + 1, columnNumber: 0 });
      positions.push({ lineNumber: scriptEndLine + 1, columnNumber: 0 });
    }

    return positions.length > 0 ? positions : null;
  }

  clear(): void {
    this.cache.clear();
    this.scripts.clear();
    this.sourceToScripts.clear();
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
      rawMapStr = await httpGet(sourceMapUrl);
    }

    const rawMap: RawSourceMap = JSON.parse(rawMapStr);
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
