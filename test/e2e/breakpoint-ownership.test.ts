import { describe, expect, it, vi } from 'vitest';
import { BreakpointManager } from '../../src/breakpoints/BreakpointManager';
import type { CdpClient } from '../../src/cdp/CdpClient';
import type { SourceMapResolver } from '../../src/sourcemap/SourceMapResolver';

describe('BreakpointManager ownership', () => {
  it('shares a physical breakpoint and releases it only after both VS Code and agent owners clear', async () => {
    let nextHandle = 1;
    const setBreakpointByUrl = vi.fn(async () => ({
      breakpointId: `physical-${nextHandle++}`,
      locations: [],
    }));
    const removeBreakpoint = vi.fn(async () => undefined);
    const cdp = {
      setBreakpointByUrl,
      removeBreakpoint,
      getPossibleBreakpoints: vi.fn(async () => []),
    } as unknown as CdpClient;

    const sourcePath = '/workspace/src/math.ts';
    const resolver = {
      originalToGenerated: vi.fn(async (_source: string, line: number, column: number) => ({
        scriptId: 'script-1',
        lineNumber: line - 1,
        columnNumber: column,
      })),
      getScriptsForSource: vi.fn(() => ['script-1']),
      generatedToOriginal: vi.fn(async () => null),
    } as unknown as SourceMapResolver;

    const manager = new BreakpointManager(cdp, resolver, 'http://127.0.0.1:5173/');
    const request = [{ line: 2, column: 1 }];

    await manager.setBreakpoints(sourcePath, request, 'vscode');
    await manager.setBreakpoints(sourcePath, request, 'agent');

    // Both logical owners use one CDP fan-out handle for an identical spec.
    expect(setBreakpointByUrl).toHaveBeenCalledTimes(1);
    expect(manager.getAllBreakpoints().get(sourcePath)?.map((bp) => bp.owner)).toEqual([
      'vscode',
      'agent',
    ]);

    await manager.setBreakpoints(sourcePath, [], 'agent');

    // Clearing agent-owned bps does not touch the VS Code physical handle.
    expect(removeBreakpoint).not.toHaveBeenCalled();
    expect(manager.getAllBreakpoints().get(sourcePath)?.map((bp) => bp.owner)).toEqual([
      'vscode',
    ]);

    await manager.setBreakpoints(sourcePath, [], 'vscode');

    expect(removeBreakpoint).toHaveBeenCalledOnce();
    expect(removeBreakpoint).toHaveBeenCalledWith('physical-1');
    expect(manager.getAllBreakpoints().has(sourcePath)).toBe(false);
  });
});
