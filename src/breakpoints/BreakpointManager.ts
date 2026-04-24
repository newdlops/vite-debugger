import { DebugProtocol } from '@vscode/debugprotocol';
import { CdpClient } from '../cdp/CdpClient';
import { SourceMapResolver } from '../sourcemap/SourceMapResolver';
import { fileChecksumCache } from '../util/FileChecksum';
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
  /** True when the source was user-edited during HMR and the stored line is
   *  pre-edit. Prevents resolveBreakpointsForScript from re-resolving at the
   *  stale line; cleared implicitly when VSCode sends a fresh setBreakpoints
   *  (that call removes the bp and creates a new one). */
  awaitingFreshLine?: boolean;
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
          // to report the real breakpoint location to VSCode. CDP may snap
          // the breakpoint to a nearby generated position that maps to a
          // DIFFERENT original source (e.g., inlined @react-refresh preamble
          // mapping to react-dom.development.js); if we took that line, the
          // bp would be reported at a weird row in the user's file. Only
          // trust the remap when the source matches the user's file.
          if (result.locations.length > 0) {
            const actualLoc = result.locations[0];
            const actualOriginal = await this.sourceMapResolver.generatedToOriginal(
              actualLoc.scriptId, actualLoc.lineNumber, actualLoc.columnNumber
            );
            if (actualOriginal && samePath(actualOriginal.source, sourcePath)) {
              resolvedLine = actualOriginal.line;
              resolvedColumn = actualOriginal.column + 1;  // DAP is 1-based
              bp.line = resolvedLine;
            } else if (actualOriginal) {
              logger.debug(
                `CDP snapped bp at ${sourcePath}:${sbp.line} into a different ` +
                `source (${actualOriginal.source}); keeping user line`
              );
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
      const bpSource: DebugProtocol.Source = { path: sourcePath };
      if (!sourcePath.includes('/node_modules/')) {
        // Record the current file hash so VSCode has a baseline to compare
        // against later. When the user saves (HMR), LoadedSourceEvent will
        // push the new hash; frames that still match stay trusted.
        const sha = await fileChecksumCache.sha256(sourcePath);
        if (sha) {
          bpSource.checksums = [{ algorithm: 'SHA256', checksum: sha }];
        }
      }
      results.push({
        id: dapId,
        verified: bp.verified,
        line: resolvedLine,
        column: resolvedColumn,
        source: bpSource,
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
        // Deferred-after-edit bps carry a stale pre-edit line; resolving them
        // here would land the CDP breakpoint on the wrong code. Skip until
        // VSCode re-sends setBreakpoints with the fresh line.
        if (bp.awaitingFreshLine) continue;
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
        // Same refinement as the initial set / HMR re-resolve paths: pick
        // a getPossibleBreakpoints candidate that round-trips back to
        // sourcePath, so we don't place the bp inside an inlined
        // react-refresh / JSX runtime helper that happens to share the
        // same generated line.
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
        logger.info(
          `Pending breakpoint resolved: ${sourcePath}:${bp.line} -> ${result.breakpointId} ` +
          `at generated ${targetLine}:${targetColumn}`
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
   *
   * `editedSourcePaths` is the subset whose sourcesContent actually changed
   * in this HMR cycle (i.e., the user saved an edit to those files). For
   * those, stored `bp.line` refers to pre-edit line numbers and cannot be
   * safely re-mapped — we drop the stale CDP breakpoint and mark the bp
   * unverified, then let VSCode's follow-up `setBreakpoints` call (with
   * fresh line numbers) re-establish it. The remaining affected sources
   * were only re-bundled (deps changed); their line numbers are still
   * valid, so we re-resolve as before.
   */
  async handleHmrReload(
    affectedSourcePaths: Set<string>,
    editedSourcePaths: Set<string> = new Set(),
  ): Promise<{ resolved: ManagedBreakpoint[]; unresolved: ManagedBreakpoint[]; deferred: ManagedBreakpoint[] }> {
    return this.serialize(() => this.handleHmrReloadInternal(affectedSourcePaths, editedSourcePaths));
  }

  private async handleHmrReloadInternal(
    affectedSourcePaths: Set<string>,
    editedSourcePaths: Set<string>,
  ): Promise<{ resolved: ManagedBreakpoint[]; unresolved: ManagedBreakpoint[]; deferred: ManagedBreakpoint[] }> {
    // Collect all bps affected by this HMR cycle so we can pipeline the
    // remove/resolve/set per-bp — each step was previously a hard await that
    // serialized ~3N CDP round-trips for N breakpoints.
    const targets: { sourcePath: string; bp: ManagedBreakpoint }[] = [];
    for (const [sourcePath, bps] of this.breakpoints) {
      if (!affectedSourcePaths.has(sourcePath)) continue;
      for (const bp of bps) targets.push({ sourcePath, bp });
    }
    if (targets.length === 0) return { resolved: [], unresolved: [], deferred: [] };

    const resolved: ManagedBreakpoint[] = [];
    const unresolved: ManagedBreakpoint[] = [];
    const deferred: ManagedBreakpoint[] = [];

    const perBp = targets.map(async ({ sourcePath, bp }) => {
      // Old CDP breakpoint is stale after the script replaced — remove it.
      if (bp.cdpBreakpointId) {
        try { await this.cdp.removeBreakpoint(bp.cdpBreakpointId); }
        catch (e) { logger.debug(`Failed to remove old breakpoint during HMR: ${e}`); }
        bp.cdpBreakpointId = undefined;
      }

      // User-edited source: bp.line is pre-edit. If the specific line the
      // bp lives on has different text now, the stored line refers to
      // different code and re-resolving from it would land on the wrong
      // spot — defer and wait for VSCode to send the refreshed
      // setBreakpoints. If the line's text is unchanged (e.g., the edit
      // only added content below the bp or was purely cosmetic), the
      // stored line is still valid and we can re-resolve normally.
      if (
        editedSourcePaths.has(sourcePath)
        && !this.sourceMapResolver.isLineContentStable(sourcePath, bp.line)
      ) {
        bp.verified = false;
        bp.awaitingFreshLine = true;
        deferred.push(bp);
        return;
      }
      // If we're re-resolving (line content stable or source unchanged),
      // clear any stale awaiting flag from a previous cycle.
      bp.awaitingFreshLine = false;

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
          // Same guard as setBreakpointsInternal — never overwrite bp.line
          // with a row number from a different original source (e.g., an
          // inlined react-dom/react-refresh position).
          if (actualOriginal && samePath(actualOriginal.source, sourcePath)) {
            bp.line = actualOriginal.line;
          }
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
    return { resolved, unresolved, deferred };
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
        const locations = await this.cdp.getPossibleBreakpoints(
          { scriptId, lineNumber: generated.lineNumber, columnNumber: 0 },
          { scriptId, lineNumber: generated.lineNumber + 1, columnNumber: 0 }
        );

        if (locations.length === 0) continue;

        // A Vite-generated script can interleave user code with injected
        // helpers (react-refresh preamble, JSX runtime calls, HMR hooks).
        // getPossibleBreakpoints returns positions for ALL of those, and
        // picking the nearest column blindly can land inside an injection
        // that maps to a DIFFERENT original source (react-refresh, or
        // nothing at all). When that bp fires at runtime, Chrome pauses
        // deep in React internals like updateFunctionComponent.
        //
        // Filter candidates to only those whose round-trip back to the
        // original source lands in `sourcePath`. If none qualify, fall
        // back to the raw generated position (skip refinement) rather
        // than snap to an injected region.
        let candidates = locations;
        if (sourcePath) {
          const roundTripped = await Promise.all(
            locations.map(async (loc) => {
              const original = await this.sourceMapResolver.generatedToOriginal(
                scriptId, loc.lineNumber, loc.columnNumber ?? 0,
              );
              return original && samePath(original.source, sourcePath) ? loc : null;
            }),
          );
          const filtered = roundTripped.filter(
            (loc): loc is typeof locations[number] => loc !== null,
          );
          if (filtered.length === 0) {
            logger.debug(
              `refineBreakpointPosition: no positions on generated line ` +
              `${generated.lineNumber} round-trip to ${sourcePath} — ` +
              `skipping refinement to avoid snapping into injected code`,
            );
            return null;
          }
          candidates = filtered;
        }

        // Find the location closest to the requested column
        let best = candidates[0];
        let bestDist = Math.abs((best.columnNumber ?? 0) - generated.columnNumber);

        for (const loc of candidates) {
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

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/') === b.replace(/\\/g, '/');
}
