import { DebugProtocol } from '@vscode/debugprotocol';
import { CdpClient } from '../cdp/CdpClient';
import { SourceMapResolver } from '../sourcemap/SourceMapResolver';
import { logger } from '../util/Logger';

interface ManagedBreakpoint {
  dapId: number;
  cdpBreakpointId?: string;
  sourcePath: string;
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  verified: boolean;
}

export class BreakpointManager {
  private breakpoints = new Map<string, ManagedBreakpoint[]>();  // sourcePath -> breakpoints
  private urlRegexCache = new Map<string, string>();  // sourcePath -> precomputed CDP urlRegex
  private nextDapId = 1;
  /**
   * Serializes all CDP-touching operations (setBreakpoints,
   * resolveBreakpointsForScript, handleHmrReload).
   *
   * Why: VSCode can fire `setBreakpoints` while an HMR batch is mid-flight,
   * and multiple `setBreakpoints` for the same source can arrive on
   * successive saves. If their async `await`s interleave, two
   * `setBreakpointByUrl` calls can hit the same location and Chrome returns
   * "Breakpoint at specified location already exists" for the loser.
   * Previously the loser's `cdpBreakpointId` stayed undefined, so a later
   * `setBreakpoints(path, [])` skipped the remove pass and the CDP
   * breakpoint leaked — the user saw pauses at breakpoints they had
   * cleared.
   */
  private opQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private cdp: CdpClient,
    private sourceMapResolver: SourceMapResolver,
    private viteUrl: string,
  ) {}

  /**
   * Append `fn` to the CDP operation queue. Each queued op starts only
   * after the previous one settles (success or failure); errors do not
   * poison the chain, they just don't short-circuit subsequent work.
   */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = (): Promise<T> => fn();
    const next = this.opQueue.then(run, run);
    this.opQueue = next.catch(() => undefined);
    return next;
  }

  async setBreakpoints(
    sourcePath: string,
    sourceBreakpoints: DebugProtocol.SourceBreakpoint[]
  ): Promise<DebugProtocol.Breakpoint[]> {
    return this.serialize(() =>
      this.setBreakpointsInternal(sourcePath, sourceBreakpoints),
    );
  }

  private async setBreakpointsInternal(
    sourcePath: string,
    sourceBreakpoints: DebugProtocol.SourceBreakpoint[]
  ): Promise<DebugProtocol.Breakpoint[]> {
    // Remove existing breakpoints for this source
    await this.removeBreakpointsForSource(sourcePath);

    const managed: ManagedBreakpoint[] = [];
    const results: DebugProtocol.Breakpoint[] = [];

    for (const sbp of sourceBreakpoints) {
      const dapId = this.nextDapId++;
      const bp: ManagedBreakpoint = {
        dapId,
        sourcePath,
        line: sbp.line,
        column: sbp.column,
        condition: sbp.condition,
        hitCondition: sbp.hitCondition,
        logMessage: sbp.logMessage,
        verified: false,
      };

      // Try to resolve through source map
      const generated = await this.sourceMapResolver.originalToGenerated(
        sourcePath, sbp.line, sbp.column ?? 0
      );

      let resolvedLine = sbp.line;
      let resolvedColumn = sbp.column;

      if (generated) {
        try {
          // Refine position: find nearest valid breakpoint location
          const refined = await this.refineBreakpointPosition(generated, sourcePath);
          const targetLine = refined?.lineNumber ?? generated.lineNumber;
          const targetColumn = refined?.columnNumber ?? generated.columnNumber;

          const condition = this.buildCdpCondition(bp);

          const result = await this.cdp.setBreakpointByUrl(
            targetLine,
            {
              urlRegex: this.buildUrlRegex(sourcePath),
              columnNumber: targetColumn,
              condition,
            }
          );

          bp.cdpBreakpointId = result.breakpointId;
          bp.verified = true;

          // Map CDP's actual resolved position back to original source
          // to report the real breakpoint location to VSCode
          if (result.locations.length > 0) {
            const actualLoc = result.locations[0];
            const actualOriginal = await this.sourceMapResolver.generatedToOriginal(
              actualLoc.scriptId, actualLoc.lineNumber, actualLoc.columnNumber
            );
            if (actualOriginal) {
              resolvedLine = actualOriginal.line;
              resolvedColumn = actualOriginal.column + 1;  // DAP is 1-based
              bp.line = resolvedLine;
            }
          }

          logger.debug(
            `Breakpoint set: ${sourcePath}:${sbp.line} -> ${resolvedLine} | ` +
            `CDP ${result.breakpointId} at generated ${targetLine}:${targetColumn}`
          );
        } catch (e) {
          logger.warn(`Failed to set CDP breakpoint: ${e}`);
        }
      } else {
        logger.debug(`Breakpoint pending (no source map yet): ${sourcePath}:${sbp.line}`);
      }

      managed.push(bp);
      results.push({
        id: dapId,
        verified: bp.verified,
        line: resolvedLine,
        column: resolvedColumn,
        source: { path: sourcePath },
      });
    }

    this.breakpoints.set(sourcePath, managed);
    return results;
  }

  async removeBreakpointsForSource(sourcePath: string): Promise<void> {
    const existing = this.breakpoints.get(sourcePath);
    if (!existing) return;

    for (const bp of existing) {
      if (bp.cdpBreakpointId) {
        try {
          await this.cdp.removeBreakpoint(bp.cdpBreakpointId);
        } catch (e) {
          logger.warn(`Failed to remove CDP breakpoint ${bp.cdpBreakpointId}: ${e}`);
        }
      }
    }

    this.breakpoints.delete(sourcePath);
  }

  async resolveBreakpointsForScript(scriptId: string, url: string): Promise<ManagedBreakpoint[]> {
    return this.serialize(() => this.resolveBreakpointsForScriptInternal(scriptId, url));
  }

  private async resolveBreakpointsForScriptInternal(scriptId: string, _url: string): Promise<ManagedBreakpoint[]> {
    // Narrow the work to sources that actually belong to THIS script, avoiding
    // the previous O(sources × bps) scan that re-ran `originalToGenerated`
    // against every unrelated bp on every scriptParsed event.
    const relevantSources = new Set(this.sourceMapResolver.getSourcesForScript(scriptId));
    if (relevantSources.size === 0) return [];

    const candidates: { sourcePath: string; bp: ManagedBreakpoint }[] = [];
    for (const [sourcePath, bps] of this.breakpoints) {
      if (!relevantSources.has(sourcePath)) continue;
      for (const bp of bps) {
        if (!bp.verified) candidates.push({ sourcePath, bp });
      }
    }
    if (candidates.length === 0) return [];

    // Resolve + set breakpoints in parallel — each bp is independent at the
    // CDP layer, so we can pipeline them instead of serializing awaits.
    const results = await Promise.all(candidates.map(async ({ sourcePath, bp }) => {
      const generated = await this.sourceMapResolver.originalToGenerated(
        sourcePath, bp.line, bp.column ?? 0
      );
      if (!generated || generated.scriptId !== scriptId) return null;

      try {
        const result = await this.cdp.setBreakpointByUrl(
          generated.lineNumber,
          {
            urlRegex: this.buildUrlRegex(sourcePath),
            columnNumber: generated.columnNumber,
            condition: this.buildCdpCondition(bp),
          }
        );
        bp.cdpBreakpointId = result.breakpointId;
        bp.verified = true;
        logger.info(
          `Pending breakpoint resolved: ${sourcePath}:${bp.line} -> ${result.breakpointId}`
        );
        return bp;
      } catch (e) {
        const msg = String(e);
        if (msg.includes('already exists')) {
          bp.verified = true;
          logger.debug(`Pending breakpoint already exists: ${sourcePath}:${bp.line}`);
          return bp;
        }
        logger.warn(`Failed to resolve pending breakpoint: ${e}`);
        return null;
      }
    }));

    return results.filter((bp): bp is ManagedBreakpoint => bp !== null);
  }

  /**
   * Handle HMR reload for a set of affected source paths.
   * Only processes breakpoints whose source files are in the affected set,
   * skipping non-browser files (e.g., .py) that can never resolve to browser scripts.
   */
  async handleHmrReload(affectedSourcePaths: Set<string>): Promise<{ resolved: ManagedBreakpoint[]; unresolved: ManagedBreakpoint[] }> {
    return this.serialize(() => this.handleHmrReloadInternal(affectedSourcePaths));
  }

  private async handleHmrReloadInternal(affectedSourcePaths: Set<string>): Promise<{ resolved: ManagedBreakpoint[]; unresolved: ManagedBreakpoint[] }> {
    // Collect all bps affected by this HMR cycle so we can pipeline the
    // remove/resolve/set per-bp — each step was previously a hard await that
    // serialized ~3N CDP round-trips for N breakpoints.
    const targets: { sourcePath: string; bp: ManagedBreakpoint }[] = [];
    for (const [sourcePath, bps] of this.breakpoints) {
      if (!affectedSourcePaths.has(sourcePath)) continue;
      for (const bp of bps) targets.push({ sourcePath, bp });
    }
    if (targets.length === 0) return { resolved: [], unresolved: [] };

    const resolved: ManagedBreakpoint[] = [];
    const unresolved: ManagedBreakpoint[] = [];

    const perBp = targets.map(async ({ sourcePath, bp }) => {
      // Old CDP breakpoint is stale after the script replaced — remove it.
      if (bp.cdpBreakpointId) {
        try { await this.cdp.removeBreakpoint(bp.cdpBreakpointId); }
        catch (e) { logger.debug(`Failed to remove old breakpoint during HMR: ${e}`); }
        bp.cdpBreakpointId = undefined;
      }

      const generated = await this.sourceMapResolver.originalToGenerated(
        sourcePath, bp.line, bp.column ?? 0
      );
      if (!generated) { bp.verified = false; unresolved.push(bp); return; }

      try {
        const refined = await this.refineBreakpointPosition(generated, sourcePath);
        const targetLine = refined?.lineNumber ?? generated.lineNumber;
        const targetColumn = refined?.columnNumber ?? generated.columnNumber;

        const result = await this.cdp.setBreakpointByUrl(
          targetLine,
          {
            urlRegex: this.buildUrlRegex(sourcePath),
            columnNumber: targetColumn,
            condition: this.buildCdpCondition(bp),
          }
        );

        bp.cdpBreakpointId = result.breakpointId;
        bp.verified = true;

        if (result.locations.length > 0) {
          const actualLoc = result.locations[0];
          const actualOriginal = await this.sourceMapResolver.generatedToOriginal(
            actualLoc.scriptId, actualLoc.lineNumber, actualLoc.columnNumber
          );
          if (actualOriginal) bp.line = actualOriginal.line;
        }

        resolved.push(bp);
        logger.debug(
          `Breakpoint re-set after HMR: ${sourcePath}:${bp.line} -> ` +
          `CDP ${result.breakpointId} at generated ${targetLine}:${targetColumn}`
        );
      } catch (e) {
        if (String(e).includes('already exists')) {
          bp.verified = true;
          resolved.push(bp);
        } else {
          bp.verified = false;
          unresolved.push(bp);
          logger.warn(`Failed to re-set breakpoint after HMR: ${e}`);
        }
      }
    });

    await Promise.all(perBp);
    return { resolved, unresolved };
  }

  getAllBreakpoints(): Map<string, ManagedBreakpoint[]> {
    return this.breakpoints;
  }

  hasPendingBreakpoints(): boolean {
    for (const bps of this.breakpoints.values()) {
      if (bps.some(bp => !bp.verified)) return true;
    }
    return false;
  }

  clear(): void {
    this.breakpoints.clear();
    this.urlRegexCache.clear();
  }

  /**
   * Use CDP getPossibleBreakpoints to find the nearest valid breakpoint
   * location to the generated position. This prevents Chrome from snapping
   * the breakpoint to an unexpected location (e.g., function header).
   *
   * The scriptId from the source map may be stale (HMR replaced it).
   * We try the given scriptId first, then fall back to finding the latest
   * scriptId for the same source file via sourceMapResolver.
   */
  private async refineBreakpointPosition(
    generated: { scriptId: string; lineNumber: number; columnNumber: number },
    sourcePath?: string,
  ): Promise<{ lineNumber: number; columnNumber: number } | null> {
    // Collect candidate scriptIds: the given one plus any others for the same source
    const scriptIds = [generated.scriptId];
    if (sourcePath) {
      const others = this.sourceMapResolver.getScriptsForSource(sourcePath);
      for (const id of others) {
        if (!scriptIds.includes(id)) scriptIds.push(id);
      }
    }

    for (const scriptId of scriptIds) {
      try {
        // Search on the same line first
        let locations = await this.cdp.getPossibleBreakpoints(
          { scriptId, lineNumber: generated.lineNumber, columnNumber: 0 },
          { scriptId, lineNumber: generated.lineNumber + 1, columnNumber: 0 }
        );

        if (locations.length === 0) continue;

        // Find the location closest to the requested column
        let best = locations[0];
        let bestDist = Math.abs((best.columnNumber ?? 0) - generated.columnNumber);

        for (const loc of locations) {
          const dist = Math.abs((loc.columnNumber ?? 0) - generated.columnNumber);
          if (dist < bestDist) {
            best = loc;
            bestDist = dist;
          }
        }

        return {
          lineNumber: best.lineNumber,
          columnNumber: best.columnNumber ?? 0,
        };
      } catch {
        // This scriptId is stale, try next
        continue;
      }
    }

    return null;
  }

  /**
   * Build a single CDP condition expression from a breakpoint's condition,
   * hitCondition, and logMessage fields.
   *
   * - hitCondition: "N" (exact), ">=N", "%N" (every Nth)
   * - condition: arbitrary JS expression
   * - logMessage: converted to console.log template (always returns false)
   */
  private buildCdpCondition(bp: ManagedBreakpoint): string | undefined {
    // logMessage takes full precedence — it never pauses
    if (bp.logMessage) {
      const expr = bp.logMessage.replace(/\{([^}]+)\}/g, '${$1}');
      return `console.log(\`${expr}\`), false`;
    }

    let hitExpr: string | undefined;
    if (bp.hitCondition) {
      const raw = bp.hitCondition.trim();
      const counter = `(globalThis.__vdbg_hit_${bp.dapId} = (globalThis.__vdbg_hit_${bp.dapId} || 0) + 1)`;
      if (raw.startsWith('>=')) {
        const n = parseInt(raw.slice(2).trim(), 10);
        hitExpr = `${counter} >= ${n}`;
      } else if (raw.startsWith('%')) {
        const n = parseInt(raw.slice(1).trim(), 10);
        hitExpr = `${counter} % ${n} === 0`;
      } else {
        const n = parseInt(raw, 10);
        hitExpr = `${counter} === ${n}`;
      }
    }

    const condExpr = bp.condition;

    if (hitExpr && condExpr) {
      return `(${hitExpr}) && (${condExpr})`;
    }
    return hitExpr || condExpr;
  }

  private buildUrlRegex(sourcePath: string): string {
    const cached = this.urlRegexCache.get(sourcePath);
    if (cached !== undefined) return cached;

    // Build a URL regex that matches the Vite-served version of this file
    // e.g., /src/App.tsx -> matches http://localhost:5173/src/App.tsx
    const normalizedPath = sourcePath.replace(/\\/g, '/');
    const port = new URL(this.viteUrl).port;

    let regex: string;
    const srcIndex = normalizedPath.lastIndexOf('/src/');
    if (srcIndex !== -1) {
      const relative = normalizedPath.slice(srcIndex);
      regex = `https?://(?:localhost|127\\.0\\.0\\.1):${port}${escapeRegex(relative)}`;
    } else {
      const basename = normalizedPath.split('/').pop() ?? '';
      regex = `https?://(?:localhost|127\\.0\\.0\\.1):${port}/.*${escapeRegex(basename)}`;
    }

    this.urlRegexCache.set(sourcePath, regex);
    return regex;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
