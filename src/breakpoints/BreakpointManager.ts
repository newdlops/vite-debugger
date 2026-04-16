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
  private nextDapId = 1;

  constructor(
    private cdp: CdpClient,
    private sourceMapResolver: SourceMapResolver,
    private viteUrl: string,
  ) {}

  async setBreakpoints(
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
    const resolved: ManagedBreakpoint[] = [];

    for (const [sourcePath, bps] of this.breakpoints) {
      for (const bp of bps) {
        if (bp.verified) continue;  // Already resolved

        const generated = await this.sourceMapResolver.originalToGenerated(
          sourcePath, bp.line, bp.column ?? 0
        );

        if (generated && generated.scriptId === scriptId) {
          try {
            const condition = this.buildCdpCondition(bp);

            const result = await this.cdp.setBreakpointByUrl(
              generated.lineNumber,
              {
                urlRegex: this.buildUrlRegex(sourcePath),
                columnNumber: generated.columnNumber,
                condition,
              }
            );

            bp.cdpBreakpointId = result.breakpointId;
            bp.verified = true;
            resolved.push(bp);

            logger.info(
              `Pending breakpoint resolved: ${sourcePath}:${bp.line} -> ${result.breakpointId}`
            );
          } catch (e) {
            const msg = String(e);
            if (msg.includes('already exists')) {
              bp.verified = true;
              resolved.push(bp);
              logger.debug(`Pending breakpoint already exists: ${sourcePath}:${bp.line}`);
            } else {
              logger.warn(`Failed to resolve pending breakpoint: ${e}`);
            }
          }
        }
      }
    }

    return resolved;
  }

  /**
   * Handle HMR reload for a set of affected source paths.
   * Only processes breakpoints whose source files are in the affected set,
   * skipping non-browser files (e.g., .py) that can never resolve to browser scripts.
   */
  async handleHmrReload(affectedSourcePaths: Set<string>): Promise<{ resolved: ManagedBreakpoint[]; unresolved: ManagedBreakpoint[] }> {
    const resolved: ManagedBreakpoint[] = [];
    const unresolved: ManagedBreakpoint[] = [];

    for (const [sourcePath, bps] of this.breakpoints) {
      // Only process breakpoints for sources affected by this HMR cycle
      if (!affectedSourcePaths.has(sourcePath)) continue;

      for (const bp of bps) {
        // Remove the old CDP breakpoint — its generated position is stale
        if (bp.cdpBreakpointId) {
          try {
            await this.cdp.removeBreakpoint(bp.cdpBreakpointId);
          } catch (e) {
            logger.debug(`Failed to remove old breakpoint during HMR: ${e}`);
          }
          bp.cdpBreakpointId = undefined;
        }

        // Resolve the new generated position from the updated source map
        const generated = await this.sourceMapResolver.originalToGenerated(
          sourcePath, bp.line, bp.column ?? 0
        );

        if (!generated) {
          bp.verified = false;
          unresolved.push(bp);
          continue;
        }

        try {
          // Refine position using getPossibleBreakpoints
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

          // Map the actual CDP location back to original source
          // to report the correct line to VS Code
          if (result.locations.length > 0) {
            const actualLoc = result.locations[0];
            const actualOriginal = await this.sourceMapResolver.generatedToOriginal(
              actualLoc.scriptId, actualLoc.lineNumber, actualLoc.columnNumber
            );
            if (actualOriginal) {
              bp.line = actualOriginal.line;
            }
          }

          resolved.push(bp);

          logger.debug(
            `Breakpoint re-set after HMR: ${sourcePath}:${bp.line} -> ` +
            `CDP ${result.breakpointId} at generated ${targetLine}:${targetColumn}`
          );
        } catch (e) {
          const msg = String(e);
          if (msg.includes('already exists')) {
            // CDP already has this breakpoint (URL regex matched the new script automatically).
            // Keep it verified without redundant logging.
            bp.verified = true;
            resolved.push(bp);
          } else {
            bp.verified = false;
            unresolved.push(bp);
            logger.warn(`Failed to re-set breakpoint after HMR: ${e}`);
          }
        }
      }
    }

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
    // Build a URL regex that matches the Vite-served version of this file
    // e.g., /src/App.tsx -> matches http://localhost:5173/src/App.tsx
    const normalizedPath = sourcePath.replace(/\\/g, '/');

    // Try to extract the relative path from webRoot
    // The regex should match both localhost and 127.0.0.1
    const viteUrlObj = new URL(this.viteUrl);
    const port = viteUrlObj.port;

    // Extract relative part after common prefixes
    const srcIndex = normalizedPath.lastIndexOf('/src/');
    if (srcIndex !== -1) {
      const relative = normalizedPath.slice(srcIndex);
      return `https?://(?:localhost|127\\.0\\.0\\.1):${port}${escapeRegex(relative)}`;
    }

    // Fallback: use the filename
    const basename = normalizedPath.split('/').pop() ?? '';
    return `https?://(?:localhost|127\\.0\\.0\\.1):${port}/.*${escapeRegex(basename)}`;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
