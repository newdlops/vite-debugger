import CDP from 'chrome-remote-interface';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DebugProtocol } from '@vscode/debugprotocol';
import type { CdpClient } from '../../src/cdp/CdpClient';
import type { SourceMapResolver } from '../../src/sourcemap/SourceMapResolver';
import type { BreakpointLocationResolver } from '../../src/breakpoints/BreakpointLocationResolver';
import { E2ESession, startAttachedSession } from '../helpers/session';
import { openTab } from '../helpers/browser';

interface Resources {
  cdp: CdpClient;
  sourceMapResolver: SourceMapResolver;
  breakpointLocations: BreakpointLocationResolver;
  scriptIdToUrl: Map<string, string>;
  sourceRefToScriptId: Map<number, string>;
}

describe('Real Chrome resource reuse and target retirement', () => {
  let session: E2ESession;
  let resources: Resources;
  let appPath: string;
  let mathPath: string;
  let paused = false;

  beforeAll(async () => {
    session = await startAttachedSession({ vite: { compact: true } });
    resources = session.dap.session as unknown as Resources;
    appPath = path.join(session.webRoot, 'src', 'App.tsx');
    mathPath = path.join(session.webRoot, 'src', 'math.ts');
    session.dap.on('stopped', () => { paused = true; });
    session.dap.on('continued', () => { paused = false; });
  });
  afterEach(async () => {
    for (const file of [appPath, mathPath]) {
      await session.dap.request('setBreakpoints', { source: { path: file }, breakpoints: [] });
    }
    if (paused) await session.dap.request('continue', { threadId: 1 });
    session.dap.clearQueue('stopped', 'continued', 'breakpoint');
    vi.restoreAllMocks();
  });
  afterAll(async () => { await session?.dispose(); });

  async function set(file: string, lines: number[]) {
    const response = await session.dap.request<DebugProtocol.SetBreakpointsRequest, DebugProtocol.SetBreakpointsResponse>(
      'setBreakpoints', { source: { path: file }, breakpoints: lines.map((line) => ({ line })) },
    );
    expect(response.body!.breakpoints.every((bp) => bp.verified)).toBe(true);
    return response.body!.breakpoints;
  }

  async function stoppedAt(file: string, line: number, selector = '[data-testid="inc"]') {
    session.dap.clearQueue('stopped');
    await session.browser.triggerClick(selector);
    await session.dap.waitForEvent('stopped', 10_000);
    const stack = await session.dap.request<DebugProtocol.StackTraceRequest, DebugProtocol.StackTraceResponse>(
      'stackTrace', { threadId: 1, startFrame: 0, levels: 1 },
    );
    expect(stack.body!.stackFrames[0]).toMatchObject({ line, source: { path: file } });
  }

  it('shares one real CDP query between a whole-file gutter request and seven component breakpoints', async () => {
    resources.breakpointLocations.clear();
    const query = vi.spyOn(resources.cdp, 'getPossibleBreakpoints');
    const locations = await session.dap.request<DebugProtocol.BreakpointLocationsRequest, DebugProtocol.BreakpointLocationsResponse>(
      'breakpointLocations', { source: { path: appPath }, line: 5, endLine: 76 },
    );
    expect(locations.body!.breakpoints.length).toBeGreaterThan(10);
    expect(query).toHaveBeenCalledTimes(1);
    const lines = [6, 9, 23, 32, 41, 54, 67];
    expect((await set(appPath, lines)).map((bp) => bp.line)).toEqual(lines);
    expect(query).toHaveBeenCalledTimes(1);
    await stoppedAt(appPath, 23, '[data-testid="lambda-multi"]');
  });

  it('releases a closed tab\'s scripts while the other tab keeps its render breakpoint', async () => {
    const initial = resources.cdp.listTargets()[0].targetId;
    const extra = await openTab(session.chrome.port, session.vite.url);
    try {
      await extra.waitForSelector('[data-testid="inc"]');
      await vi.waitFor(() => expect(resources.sourceMapResolver.getScriptsForSource(appPath)).toHaveLength(2));
      const oldScripts = resources.sourceMapResolver.getScriptsForSource(appPath);
      const extraTarget = resources.cdp.listTargets().find((target) => target.targetId !== initial)!;
      const retired = oldScripts.find((scriptId) => scriptId.startsWith(extraTarget.sessionId + '|'))!;
      await set(appPath, [6]);
      await CDP.Close({ host: '127.0.0.1', port: session.chrome.port, id: extraTarget.targetId });
      await vi.waitFor(() => expect(resources.sourceMapResolver.getScriptsForSource(appPath)).toHaveLength(1));
      expect(resources.sourceMapResolver.hasSourceMap(retired)).toBe(false);
      expect(resources.scriptIdToUrl.has(retired)).toBe(false);
      expect(resources.sourceMapResolver.getSourceContent(appPath)).not.toBeNull();
      await stoppedAt(appPath, 6);
    } finally { await extra.close().catch(() => undefined); }
  });

  it('keeps source and reference counts stable across four cross-origin round trips', async () => {
    for (let cycle = 0; cycle < 4; cycle++) {
      const scripts = resources.sourceMapResolver.getScriptsForSource(appPath);
      await session.browser.navigate('data:text/html,<title>outside</title>outside');
      await vi.waitFor(() => expect(resources.cdp.listTargets()).toEqual([]));
      expect(resources.sourceMapResolver.getScriptsForSource(appPath)).toEqual([]);
      expect(resources.sourceMapResolver.getSourceContent(appPath)).toBeNull();
      expect(resources.scriptIdToUrl.size).toBe(0);
      expect(resources.sourceRefToScriptId.size).toBe(0);
      for (const script of scripts) expect(resources.sourceMapResolver.hasSourceMap(script)).toBe(false);
      await session.browser.navigate(session.vite.url);
      await session.browser.waitForSelector('[data-testid="inc"]');
      await vi.waitFor(() => expect(resources.sourceMapResolver.getScriptsForSource(appPath)).toHaveLength(1));
      await set(mathPath, [2]);
      await stoppedAt(mathPath, 2);
      await set(mathPath, []);
      await session.dap.request('continue', { threadId: 1 });
    }
  }, 60_000);
});
