import { DebugProtocol } from '@vscode/debugprotocol';
import * as fs from 'fs';
import { CdpBreakpointLocation, CdpClient } from '../cdp/CdpClient';
import { SourceMapResolver } from '../sourcemap/SourceMapResolver';
import { fileChecksumCache } from '../util/FileChecksum';
import { logger } from '../util/Logger';
import { escapeRegexLiteral, urlHostPatternForHost } from '../util/LocalHosts';

export type BreakpointOwner = 'vscode' | 'agent';

export interface ManagedBreakpoint {
  owner: BreakpointOwner;
  dapId: number;
  cdpBreakpointId?: string;
  /** Stable identity of the underlying fan-out CDP breakpoint. Multiple
   * logical breakpoints (for example one from VS Code and one from an agent)
   * may share it without either owner being able to remove the other's bp. */
  physicalKey?: string;
  sourcePath: string;
  line: number;
  column?: number;
  resolvedLine?: number;
  resolvedColumn?: number;
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

interface ResolvedBreakpointTarget {
  scriptId: string;
  lineNumber: number;
  columnNumber: number;
  originalLine?: number;
  originalColumn?: number;
}

export class BreakpointManager {
  private breakpoints = new Map<string, ManagedBreakpoint[]>();  // sourcePath -> breakpoints
  /** physical breakpoint spec -> CdpClient fan-out handle */
  private physicalBreakpointIds = new Map<string, string>();
  /** Deduplicates concurrent HMR re-resolution of a shared physical bp. */
  private pendingPhysicalBreakpoints = new Map<string, Promise<CdpBreakpointLocation>>();
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

  private physicalBreakpointKey(
    sourcePath: string,
    target: ResolvedBreakpointTarget,
    condition: string | undefined,
  ): string {
    return JSON.stringify([
      sourcePath,
      this.buildUrlRegex(sourcePath),
      target.lineNumber,
      target.columnNumber,
      condition ?? '',
    ]);
  }

  /**
   * Acquire a single fan-out CDP breakpoint for a logical breakpoint.
   *
   * VS Code and an agent can independently request the same location. Chrome
   * does not provide ownership for that duplicate, so we share one physical
   * handle and release it only after the last logical owner disappears.
   */
  private async acquirePhysicalBreakpoint(
    sourcePath: string,
    bp: ManagedBreakpoint,
    target: ResolvedBreakpointTarget,
    condition: string | undefined,
  ): Promise<CdpBreakpointLocation> {
    const key = this.physicalBreakpointKey(sourcePath, target, condition);
    bp.physicalKey = key;

    const existingId = this.physicalBreakpointIds.get(key);
    if (existingId) {
      bp.cdpBreakpointId = existingId;
      return { breakpointId: existingId, locations: [] };
    }

    let pending = this.pendingPhysicalBreakpoints.get(key);
    if (!pending) {
      pending = this.cdp.setBreakpointByUrl(
        target.lineNumber,
        {
          urlRegex: this.buildUrlRegex(sourcePath),
          columnNumber: target.columnNumber,
          condition,
        },
      );
      this.pendingPhysicalBreakpoints.set(key, pending);
    }

    try {
      const result = await pending;
      this.physicalBreakpointIds.set(key, result.breakpointId);
      bp.cdpBreakpointId = result.breakpointId;
      return result;
    } finally {
      if (this.pendingPhysicalBreakpoints.get(key) === pending) {
        this.pendingPhysicalBreakpoints.delete(key);
      }
    }
  }

  private hasPhysicalReference(key: string): boolean {
    for (const bps of this.breakpoints.values()) {
      if (bps.some((bp) => bp.physicalKey === key)) return true;
    }
    return false;
  }

  async setBreakpoints(
    sourcePath: string,
    sourceBreakpoints: DebugProtocol.SourceBreakpoint[],
    owner: BreakpointOwner = 'vscode',
  ): Promise<DebugProtocol.Breakpoint[]> {
    return this.serialize(() =>
      this.setBreakpointsInternal(sourcePath, sourceBreakpoints, owner),
    );
  }

  private async setBreakpointsInternal(
    sourcePath: string,
    sourceBreakpoints: DebugProtocol.SourceBreakpoint[],
    owner: BreakpointOwner,
  ): Promise<DebugProtocol.Breakpoint[]> {
    // A replace operation is scoped to its owner. Agent requests must never
    // alter breakpoints managed by VS Code's setBreakpoints request (and vice
    // versa).
    await this.removeBreakpointsForSourceInternal(sourcePath, owner);

    const managed: ManagedBreakpoint[] = [];
    const results: DebugProtocol.Breakpoint[] = [];

    for (const sbp of sourceBreakpoints) {
      const dapId = this.nextDapId++;
      const bp: ManagedBreakpoint = {
        owner,
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
      const target = await this.resolveBreakpointTarget(sourcePath, bp);

      let resolvedLine = sbp.line;
      let resolvedColumn = sbp.column;

      if (target) {
        try {
          const condition = this.buildCdpCondition(bp);

          const result = await this.acquirePhysicalBreakpoint(sourcePath, bp, target, condition);

          bp.cdpBreakpointId = result.breakpointId;
          bp.verified = true;
          if (target.originalLine !== undefined) {
            bp.resolvedLine = target.originalLine;
            bp.resolvedColumn = target.originalColumn !== undefined
              ? target.originalColumn + 1
              : undefined;
            resolvedLine = target.originalLine;
            resolvedColumn = bp.resolvedColumn;
          }

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
              bp.resolvedLine = resolvedLine;
              bp.resolvedColumn = resolvedColumn;
            } else if (actualOriginal) {
              logger.debug(
                `CDP snapped bp at ${sourcePath}:${sbp.line} into a different ` +
                `source (${actualOriginal.source}); keeping user line`
              );
            }
          }

          logger.debug(
            `Breakpoint set: ${sourcePath}:${sbp.line} -> ${resolvedLine} | ` +
            `CDP ${result.breakpointId} at generated ${target.lineNumber}:${target.columnNumber}`
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

    const retained = this.breakpoints.get(sourcePath) ?? [];
    const combined = [...retained, ...managed];
    if (combined.length > 0) this.breakpoints.set(sourcePath, combined);
    else this.breakpoints.delete(sourcePath);
    return results;
  }

  async removeBreakpointsForSource(
    sourcePath: string,
    owner?: BreakpointOwner,
  ): Promise<void> {
    return this.serialize(() => this.removeBreakpointsForSourceInternal(sourcePath, owner));
  }

  private async removeBreakpointsForSourceInternal(
    sourcePath: string,
    owner?: BreakpointOwner,
  ): Promise<void> {
    const existing = this.breakpoints.get(sourcePath);
    if (!existing) return;

    const removed = owner
      ? existing.filter((bp) => bp.owner === owner)
      : existing;
    const retained = owner
      ? existing.filter((bp) => bp.owner !== owner)
      : [];

    if (retained.length > 0) this.breakpoints.set(sourcePath, retained);
    else this.breakpoints.delete(sourcePath);

    const releasedKeys = new Set(removed.map((bp) => bp.physicalKey).filter(Boolean) as string[]);
    for (const key of releasedKeys) {
      // The physical CDP breakpoint remains live as long as any logical owner
      // references it. This is particularly important when VS Code and an MCP
      // agent chose the same source location.
      if (this.hasPhysicalReference(key)) continue;
      const cdpBreakpointId = this.physicalBreakpointIds.get(key);
      this.physicalBreakpointIds.delete(key);
      if (cdpBreakpointId) {
        try {
          await this.cdp.removeBreakpoint(cdpBreakpointId);
        } catch (e) {
          logger.warn(`Failed to remove CDP breakpoint ${cdpBreakpointId}: ${e}`);
        }
      }
    }
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
      const target = await this.resolveBreakpointTarget(sourcePath, bp, scriptId);
      if (!target) return null;

      try {
        const result = await this.acquirePhysicalBreakpoint(
          sourcePath,
          bp,
          target,
          this.buildCdpCondition(bp),
        );
        bp.verified = true;
        if (target.originalLine !== undefined) {
          bp.resolvedLine = target.originalLine;
          bp.resolvedColumn = target.originalColumn !== undefined
            ? target.originalColumn + 1
            : undefined;
        }
        logger.info(
          `Pending breakpoint resolved: ${sourcePath}:${bp.line} -> ${result.breakpointId} ` +
          `at generated ${target.lineNumber}:${target.columnNumber}`
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

    // Invalidate each shared physical handle once. Calling remove once per
    // logical owner would let one owner delete another's newly re-created
    // breakpoint while the parallel HMR work is still running.
    const staleIds = new Set<string>();
    for (const { bp } of targets) {
      if (bp.physicalKey) this.physicalBreakpointIds.delete(bp.physicalKey);
      if (bp.cdpBreakpointId) staleIds.add(bp.cdpBreakpointId);
      bp.cdpBreakpointId = undefined;
      bp.physicalKey = undefined;
    }
    await Promise.all([...staleIds].map(async (breakpointId) => {
      try { await this.cdp.removeBreakpoint(breakpointId); }
      catch (e) { logger.debug(`Failed to remove old breakpoint during HMR: ${e}`); }
    }));

    const perBp = targets.map(async ({ sourcePath, bp }) => {
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

      const target = await this.resolveBreakpointTarget(sourcePath, bp);
      if (!target) { bp.verified = false; unresolved.push(bp); return; }

      try {
        const result = await this.acquirePhysicalBreakpoint(
          sourcePath,
          bp,
          target,
          this.buildCdpCondition(bp),
        );

        bp.verified = true;
        if (target.originalLine !== undefined) {
          bp.resolvedLine = target.originalLine;
          bp.resolvedColumn = target.originalColumn !== undefined
            ? target.originalColumn + 1
            : undefined;
        }

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
            bp.resolvedLine = actualOriginal.line;
            bp.resolvedColumn = actualOriginal.column + 1;
          }
        }

        resolved.push(bp);
        logger.debug(
          `Breakpoint re-set after HMR: ${sourcePath}:${bp.line} -> ` +
          `CDP ${result.breakpointId} at generated ${target.lineNumber}:${target.columnNumber}`
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

  getBreakpointForCdpHit(
    hitBreakpoints: readonly string[] | undefined,
  ): { sourcePath: string; line: number; column?: number } | null {
    if (!hitBreakpoints || hitBreakpoints.length === 0) return null;
    const hit = new Set(hitBreakpoints);
    for (const bps of this.breakpoints.values()) {
      for (const bp of bps) {
        if (!bp.cdpBreakpointId || !hit.has(bp.cdpBreakpointId)) continue;
        return {
          sourcePath: bp.sourcePath,
          line: bp.resolvedLine ?? bp.line,
          column: bp.resolvedColumn ?? bp.column,
        };
      }
    }
    return null;
  }

  hasPendingBreakpoints(): boolean {
    for (const bps of this.breakpoints.values()) {
      if (bps.some(bp => !bp.verified)) return true;
    }
    return false;
  }

  clear(): void {
    this.breakpoints.clear();
    this.physicalBreakpointIds.clear();
    this.pendingPhysicalBreakpoints.clear();
    this.urlRegexCache.clear();
  }

  private async resolveBreakpointTarget(
    sourcePath: string,
    bp: ManagedBreakpoint,
    expectedScriptId?: string,
  ): Promise<ResolvedBreakpointTarget | null> {
    if (bp.column === undefined) {
      const preferred = await this.findAnonymousFunctionBodyBreakpoint(
        sourcePath,
        bp.line,
        expectedScriptId,
      );
      if (preferred) return preferred;
    }

    const requestedColumn = bp.column === undefined ? 0 : Math.max(0, bp.column - 1);
    const generated = await this.sourceMapResolver.originalToGenerated(
      sourcePath, bp.line, requestedColumn,
    );
    if (!generated) return null;
    if (expectedScriptId && generated.scriptId !== expectedScriptId) return null;

    // Refine position: find nearest valid breakpoint location. This keeps the
    // existing behavior for explicit-column bps and ordinary line bps.
    const refined = await this.refineBreakpointPosition(generated, sourcePath);
    return {
      scriptId: generated.scriptId,
      lineNumber: refined?.lineNumber ?? generated.lineNumber,
      columnNumber: refined?.columnNumber ?? generated.columnNumber,
    };
  }

  private async findAnonymousFunctionBodyBreakpoint(
    sourcePath: string,
    line: number,
    scriptId?: string,
  ): Promise<ResolvedBreakpointTarget | null> {
    const sourceText = await this.readSourceText(sourcePath);
    if (sourceText === null) return null;

    const bodyStart = anonymousFunctionBodyStart(sourceText, line);
    if (bodyStart === null) return null;

    const scriptIds = scriptId
      ? [scriptId]
      : this.sourceMapResolver.getScriptsForSource(sourcePath);
    if (scriptIds.length === 0) return null;

    for (const candidateScriptId of scriptIds) {
      const target = await this.findBreakableOriginalPosition(
        sourcePath,
        bodyStart.line,
        bodyStart.column,
        candidateScriptId,
      );
      if (target) {
        logger.debug(
          `Line-only bp on anonymous function: ${sourcePath}:${line} ` +
          `body ${bodyStart.line}:${bodyStart.column} -> ` +
          `generated ${target.lineNumber}:${target.columnNumber}`,
        );
        return target;
      }
    }

    return null;
  }

  private async findBreakableOriginalPosition(
    sourcePath: string,
    line: number,
    column: number,
    scriptId: string,
  ): Promise<ResolvedBreakpointTarget | null> {
    const genPositions = this.sourceMapResolver
      .getGeneratedPositionsForOriginalLine(sourcePath, line)
      .filter((pos) => pos.scriptId === scriptId);
    if (genPositions.length === 0) return null;

    const genLines = [...new Set(genPositions.map((pos) => pos.lineNumber))];
    const queried = await Promise.all(genLines.map(async (genLine) => {
      try {
        const locations = await this.cdp.getPossibleBreakpoints(
          { scriptId, lineNumber: genLine, columnNumber: 0 },
          { scriptId, lineNumber: genLine + 1, columnNumber: 0 },
        );
        return locations;
      } catch {
        return [];
      }
    }));

    const candidates: Array<{
      lineNumber: number;
      columnNumber: number;
      originalColumn: number;
    }> = [];

    for (const loc of queried.flat()) {
      const original = await this.sourceMapResolver.generatedToOriginal(
        scriptId,
        loc.lineNumber,
        loc.columnNumber ?? 0,
      );
      if (!original || !samePath(original.source, sourcePath)) continue;
      if (original.line !== line) continue;
      if (original.column < column) continue;
      candidates.push({
        lineNumber: loc.lineNumber,
        columnNumber: loc.columnNumber ?? 0,
        originalColumn: original.column,
      });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      if (a.originalColumn !== b.originalColumn) return a.originalColumn - b.originalColumn;
      if (a.lineNumber !== b.lineNumber) return a.lineNumber - b.lineNumber;
      return a.columnNumber - b.columnNumber;
    });

    const best = candidates[0];
    return {
      scriptId,
      lineNumber: best.lineNumber,
      columnNumber: best.columnNumber,
      originalLine: line,
      originalColumn: best.originalColumn,
    };
  }

  private async readSourceText(sourcePath: string): Promise<string | null> {
    try {
      return await fs.promises.readFile(sourcePath, 'utf8');
    } catch {
      return null;
    }
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
    const vite = new URL(this.viteUrl);
    const port = vite.port;
    const hostPattern = urlHostPatternForHost(vite.hostname);

    let regex: string;
    const srcIndex = normalizedPath.lastIndexOf('/src/');
    if (srcIndex !== -1) {
      const relative = normalizedPath.slice(srcIndex);
      regex = `https?://${hostPattern}:${port}${escapeRegexLiteral(relative)}`;
    } else {
      const basename = normalizedPath.split('/').pop() ?? '';
      regex = `https?://${hostPattern}:${port}/.*${escapeRegexLiteral(basename)}`;
    }

    this.urlRegexCache.set(sourcePath, regex);
    return regex;
  }
}

function anonymousFunctionBodyStart(
  content: string,
  line: number,
): { line: number; column: number } | null {
  if (line < 1) return null;
  const lines = content.split(/\n/);
  const lineText = lines[line - 1]?.replace(/\r$/, '');
  if (lineText === undefined) return null;

  const arrowIndex = lineText.indexOf('=>');
  const functionMatch = /(?:^|[^\w$])(?:async\s+)?function\s*\*?\s*\(/.exec(lineText);

  if (arrowIndex >= 0 && (functionMatch === null || arrowIndex < functionMatch.index)) {
    if (isVariableFunctionInitializer(lineText, arrowIndex)) return null;
    return arrowFunctionBodyStart(lines, line, arrowIndex + 2);
  }

  if (functionMatch) {
    const functionIndex = functionMatch.index + functionMatch[0].lastIndexOf('function');
    if (isVariableFunctionInitializer(lineText, functionIndex)) return null;
    const openBrace = lineText.indexOf('{', functionIndex);
    if (openBrace >= 0) {
      return blockBodyFirstExecutableLocation(lines, line, openBrace + 1);
    }
  }

  return null;
}

function isVariableFunctionInitializer(lineText: string, functionStartIndex: number): boolean {
  const prefix = lineText.slice(0, functionStartIndex);
  return /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+/.test(prefix)
    && prefix.includes('=');
}

function arrowFunctionBodyStart(
  lines: string[],
  line: number,
  afterArrowColumn: number,
): { line: number; column: number } | null {
  const lineText = lines[line - 1]?.replace(/\r$/, '');
  if (lineText === undefined) return null;

  const exprColumn = firstNonWhitespaceColumn(lineText, afterArrowColumn);
  if (exprColumn === null) return null;
  if (lineText[exprColumn] === '{') {
    return blockBodyFirstExecutableLocation(lines, line, exprColumn + 1);
  }

  return { line, column: exprColumn };
}

function blockBodyFirstExecutableLocation(
  lines: string[],
  startLine: number,
  startColumn: number,
): { line: number; column: number } | null {
  for (let lineIdx = startLine - 1; lineIdx < lines.length; lineIdx++) {
    const lineText = lines[lineIdx].replace(/\r$/, '');
    const column = firstNonWhitespaceColumn(
      lineText,
      lineIdx === startLine - 1 ? startColumn : 0,
    );
    if (column === null) continue;
    if (lineText[column] === '}') return null;
    return { line: lineIdx + 1, column };
  }
  return null;
}

function firstNonWhitespaceColumn(lineText: string, startColumn: number): number | null {
  for (let i = startColumn; i < lineText.length; i++) {
    const ch = lineText[i];
    if (ch === ' ' || ch === '\t') continue;
    return i;
  }
  return null;
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/') === b.replace(/\\/g, '/');
}
