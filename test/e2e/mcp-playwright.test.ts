import * as path from 'path';
import type { Browser, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DebugProtocol } from '@vscode/debugprotocol';
import { E2ESession, startAttachedSession } from '../helpers/session';

interface McpDapRequest extends DebugProtocol.Request {
  command: 'viteDebugger.mcp';
  arguments: {
    method: string;
    params?: unknown;
  };
}

interface McpDapResponse<T> extends DebugProtocol.Response {
  body?: T;
}

interface McpTarget {
  targetId: string;
  title: string;
  url: string;
  active: boolean;
  primary: boolean;
  paused: boolean;
}

interface McpStatus {
  connected: boolean;
  viteUrl: string | null;
  chromePort: number | null;
  paused: boolean;
  pauseReason: string | null;
  pauseEpoch: number;
  activeTargetId: string | null;
  targets: McpTarget[];
}

interface McpBreakpointResult {
  ownership: 'agent';
  sourcePath: string;
  breakpoints: Array<{
    id?: number;
    verified: boolean;
    line: number;
    column: number | null;
    message: string | null;
  }>;
}

interface McpSnapshot {
  paused: boolean;
  pauseEpoch: number;
  targetId: string | null;
  reason: string | null;
  ready: boolean;
  frames: Array<{
    name: string;
    source: { name: string; path: string | null } | null;
    line: number;
    column: number;
  }>;
  scopes: Array<{
    name: string;
    type: string;
    variables: Array<{ name: string; value: string }>;
  }>;
}

interface McpControlResult {
  accepted: boolean;
  action: string;
  targetId: string | null;
  pauseEpoch: number;
}

/**
 * Exercise the same two connections an MCP sidecar uses in production:
 *
 *   - structured debugger requests travel through the custom DAP request; and
 *   - Playwright attaches independently to the same Chrome over CDP.
 *
 * Keeping the connections live at the same time is important. It catches
 * regressions where either the adapter's flattened target sessions or
 * Playwright's CDP session steals control of the page from the other client.
 */
describe('MCP debugger API with Playwright over the shared Chrome CDP port', () => {
  let session: E2ESession;
  let playwrightBrowser: Browser;
  let page: Page;
  let mathPath: string;

  async function mcp<T>(method: string, params?: unknown): Promise<T> {
    const response = await session.dap.request<McpDapRequest, McpDapResponse<T>>(
      'viteDebugger.mcp',
      { method, params },
      20_000,
    );
    if (response.body === undefined) {
      throw new Error(`MCP custom request '${method}' returned no response body`);
    }
    return response.body;
  }

  async function waitForRunning(timeoutMs = 5000): Promise<McpStatus> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const status = await mcp<McpStatus>('status');
      if (!status.paused) return status;
      if (Date.now() >= deadline) {
        throw new Error('Debugger did not report a running state after continue');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeAll(async () => {
    session = await startAttachedSession();
    mathPath = path.join(session.webRoot, 'src', 'math.ts');

    // The MCP process does not launch its own browser. It connects to the
    // exact debug Chrome selected by the adapter and operates its default
    // context, preserving cookies and page state.
    playwrightBrowser = await chromium.connectOverCDP(
      `http://127.0.0.1:${session.chrome.port}`,
      { timeout: 10_000 },
    );

    const expectedOrigin = new URL(session.vite.url).origin;
    const discoveredPages = playwrightBrowser
      .contexts()
      .flatMap((context) => context.pages());
    const discoveredPage = discoveredPages.find((candidate) => {
      try {
        return new URL(candidate.url()).origin === expectedOrigin;
      } catch {
        return false;
      }
    });
    if (!discoveredPage) {
      throw new Error(
        `Playwright did not discover the Vite page at ${expectedOrigin}; ` +
        `available pages: ${discoveredPages.map((candidate) => candidate.url()).join(', ') || '(none)'}`,
      );
    }
    page = discoveredPage;
    await page.getByRole('heading', { name: 'Fixture app' }).waitFor();
  }, 120_000);

  afterAll(async () => {
    // This test owns Chrome, so closing the Playwright attachment is safe;
    // session teardown remains responsible for final process cleanup.
    await playwrightBrowser?.close().catch(() => undefined);
    await session?.dispose();
  });

  it('reports the adapter-selected port and exposes an AI-readable browser snapshot', async () => {
    const status = await mcp<McpStatus>('status');
    expect(status.connected).toBe(true);
    expect(status.chromePort).toBe(session.chrome.port);
    expect(status.viteUrl).not.toBeNull();
    expect(new URL(status.viteUrl!).origin).toBe(new URL(session.vite.url).origin);
    expect(status.paused).toBe(false);
    expect(status.targets.some((target) => target.url.startsWith(session.vite.url))).toBe(true);

    const browserSnapshot = await page.locator('body').ariaSnapshot({
      mode: 'ai',
      depth: 5,
      boxes: false,
    });
    expect(browserSnapshot).toContain('Fixture app');
    expect(browserSnapshot).toContain('increment');
    expect(browserSnapshot).toMatch(/\[ref=e\d+\]/);
  });

  it('sets a breakpoint via the MCP request and snapshots the Playwright-triggered pause', async () => {
    const replaced = await mcp<McpBreakpointResult>('replaceBreakpoints', {
      sourcePath: mathPath,
      breakpoints: [{ line: 2 }],
    });
    expect(replaced.sourcePath).toBe(mathPath);
    expect(replaced.breakpoints).toHaveLength(1);
    expect(replaced.breakpoints[0]).toMatchObject({ verified: true, line: 2 });

    session.dap.clearQueue('stopped');
    const stopped = session.dap.waitForEvent('stopped', 15_000);

    // Do not await the click until after the debugger is resumed. Browser
    // actions that execute paused JavaScript may remain pending while Chrome
    // is stopped; the MCP layer must still be able to inspect and resume it.
    const click = page.getByTestId('inc').click({ noWaitAfter: true, timeout: 15_000 });
    const stoppedEvent = await stopped;
    expect((stoppedEvent.body as DebugProtocol.StoppedEvent['body']).reason).toBe('breakpoint');

    const snapshot = await mcp<McpSnapshot>('snapshot', {
      frameLimit: 5,
      variableLimit: 10,
    });
    expect(snapshot.paused).toBe(true);
    expect(snapshot.ready).toBe(true);
    expect(snapshot.targetId).not.toBeNull();
    expect(snapshot.frames[0]).toMatchObject({
      source: { path: mathPath },
      line: 2,
    });

    const localVariables = snapshot.scopes
      .filter((scope) => /local/i.test(scope.name))
      .flatMap((scope) => scope.variables);
    expect(localVariables.map((variable) => variable.name)).toEqual(
      expect.arrayContaining(['a', 'b']),
    );
    expect(localVariables.find((variable) => variable.name === 'b')?.value).toBe('1');

    const pausedStatus = await mcp<McpStatus>('status');
    expect(pausedStatus.paused).toBe(true);
    expect(pausedStatus.pauseEpoch).toBe(snapshot.pauseEpoch);
    expect(pausedStatus.activeTargetId).toBe(snapshot.targetId);
    const pausedTarget = pausedStatus.targets.find(
      (target) => target.targetId === snapshot.targetId,
    );
    expect(pausedTarget?.paused).toBe(true);

    const continued = await mcp<McpControlResult>('control', {
      action: 'continue',
      targetId: snapshot.targetId,
    });
    expect(continued).toMatchObject({
      accepted: true,
      action: 'continue',
      targetId: snapshot.targetId,
    });

    await click;
    const runningStatus = await waitForRunning();
    expect(runningStatus.pauseEpoch).toBe(snapshot.pauseEpoch);
    expect(await page.getByTestId('count').textContent()).toBe('count: 1');
  }, 40_000);

  it('clears only agent-owned breakpoints and preserves a VS Code breakpoint at the same location', async () => {
    const uiResponse = await session.dap.request<
      DebugProtocol.SetBreakpointsRequest,
      DebugProtocol.SetBreakpointsResponse
    >('setBreakpoints', {
      source: { path: mathPath },
      breakpoints: [{ line: 2 }],
    });
    expect(uiResponse.body?.breakpoints[0]).toMatchObject({ verified: true, line: 2 });

    const agentResponse = await mcp<McpBreakpointResult>('replaceBreakpoints', {
      sourcePath: mathPath,
      breakpoints: [{ line: 2 }],
    });
    expect(agentResponse).toMatchObject({ ownership: 'agent' });

    const clearedAgent = await mcp<McpBreakpointResult>('replaceBreakpoints', {
      sourcePath: mathPath,
      breakpoints: [],
    });
    expect(clearedAgent).toMatchObject({ ownership: 'agent', breakpoints: [] });

    // The two logical owners share one physical CDP location. Clearing the
    // agent owner must leave the VS Code owner live instead of removing the
    // shared Chrome breakpoint.
    session.dap.clearQueue('stopped');
    const stopped = session.dap.waitForEvent('stopped', 15_000);
    const click = page.getByTestId('inc').click({ noWaitAfter: true, timeout: 15_000 });
    const stoppedEvent = await stopped;
    expect((stoppedEvent.body as DebugProtocol.StoppedEvent['body']).reason).toBe('breakpoint');

    const snapshot = await mcp<McpSnapshot>('snapshot', { frameLimit: 1, variableLimit: 1 });
    expect(snapshot.frames[0]).toMatchObject({ source: { path: mathPath }, line: 2 });
    await mcp<McpControlResult>('control', {
      action: 'continue',
      targetId: snapshot.targetId,
    });
    await click;
    await waitForRunning();

    await session.dap.request<
      DebugProtocol.SetBreakpointsRequest,
      DebugProtocol.SetBreakpointsResponse
    >('setBreakpoints', {
      source: { path: mathPath },
      breakpoints: [],
    });
  }, 40_000);

  it('clears MCP-owned breakpoints and returns a bounded running snapshot', async () => {
    const cleared = await mcp<McpBreakpointResult>('replaceBreakpoints', {
      sourcePath: mathPath,
      breakpoints: [],
    });
    expect(cleared.breakpoints).toEqual([]);

    const snapshot = await mcp<McpSnapshot>('snapshot', {
      frameLimit: 1,
      variableLimit: 1,
    });
    expect(snapshot).toMatchObject({
      paused: false,
      ready: false,
      targetId: null,
      reason: null,
      frames: [],
      scopes: [],
    });
  });
});
