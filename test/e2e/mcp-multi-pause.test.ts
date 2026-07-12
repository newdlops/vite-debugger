import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DebugProtocol } from '@vscode/debugprotocol';
import { BrowserSession, openTab } from '../helpers/browser';
import { E2ESession, startAttachedSession } from '../helpers/session';

interface McpDapRequest extends DebugProtocol.Request {
  command: 'viteDebugger.mcp';
  arguments: { method: string; params?: unknown };
}

interface McpDapResponse<T> extends DebugProtocol.Response {
  body?: T;
}

interface McpStatus {
  paused: boolean;
  pauseEpoch: number;
  activeTargetId: string | null;
  pauseTargetId: string | null;
  pausedTargetIds: string[];
  targets: Array<{ targetId: string; paused: boolean }>;
}

interface McpSnapshot {
  paused: boolean;
  pauseEpoch: number;
  targetId: string | null;
  reason: string | null;
  ready: boolean;
  frames: Array<{
    source: { path: string | null } | null;
    line: number;
  }>;
  scopes: Array<{
    variables: Array<{ name: string; value: string }>;
  }>;
}

/**
 * Regression coverage for target-scoped MCP pause state. Two page targets may
 * be paused concurrently even though DAP presents one synthetic thread. A
 * resume in one tab must not erase the other tab's reason/frames/scopes.
 */
describe('MCP snapshots with multiple paused tabs', () => {
  let session: E2ESession;
  let secondTab: BrowserSession;
  let mathPath: string;

  async function mcp<T>(method: string, params?: unknown): Promise<T> {
    const response = await session.dap.request<McpDapRequest, McpDapResponse<T>>(
      'viteDebugger.mcp',
      { method, params },
      20_000,
    );
    if (response.body === undefined) throw new Error(`No body for MCP method ${method}`);
    return response.body;
  }

  async function waitForStatus(
    predicate: (status: McpStatus) => boolean,
    timeoutMs = 10_000,
  ): Promise<McpStatus> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const status = await mcp<McpStatus>('status');
      if (predicate(status)) return status;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for MCP debugger status');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeAll(async () => {
    session = await startAttachedSession();
    mathPath = path.join(session.webRoot, 'src', 'math.ts');
    await session.browser.waitForSelector('[data-testid="inc"]');
    secondTab = await openTab(session.chrome.port, session.vite.url);
    await secondTab.waitForSelector('[data-testid="inc"]');
    await waitForStatus((status) => status.targets.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }, 120_000);

  afterAll(async () => {
    const status = await mcp<McpStatus>('status').catch(() => undefined);
    for (const targetId of status?.pausedTargetIds ?? []) {
      await mcp('control', { action: 'continue', targetId }).catch(() => undefined);
    }
    await secondTab?.close().catch(() => undefined);
    await session?.dispose();
  });

  it('keeps snapshots independent while each target pauses and resumes', async () => {
    const response = await session.dap.request<
      DebugProtocol.SetBreakpointsRequest,
      DebugProtocol.SetBreakpointsResponse
    >('setBreakpoints', {
      source: { path: mathPath },
      breakpoints: [{ line: 2 }],
    });
    expect(response.body?.breakpoints[0]?.verified).toBe(true);

    session.dap.clearQueue('stopped');
    // Both Runtime.evaluate calls only schedule the click, so neither waits on
    // JavaScript execution after its own target enters the debugger pause.
    await Promise.all([
      session.browser.triggerClick('[data-testid="inc"]'),
      secondTab.triggerClick('[data-testid="inc"]'),
    ]);
    await session.dap.waitForEvent('stopped', 15_000);
    await session.dap.waitForEvent('stopped', 15_000);

    const bothPaused = await waitForStatus(
      (status) => status.targets.filter((target) => target.paused).length === 2,
    );
    expect(bothPaused.paused).toBe(true);
    expect(bothPaused.pausedTargetIds).toHaveLength(2);
    expect(bothPaused.pauseTargetId).not.toBeNull();

    const snapshots = await Promise.all(
      bothPaused.pausedTargetIds.map((targetId) =>
        mcp<McpSnapshot>('snapshot', { targetId, frameLimit: 5, variableLimit: 10 }),
      ),
    );
    for (const snapshot of snapshots) {
      expect(snapshot).toMatchObject({
        paused: true,
        ready: true,
      });
      expect(snapshot.reason).not.toBeNull();
      expect(snapshot.targetId).not.toBeNull();
      expect(snapshot.frames[0]).toMatchObject({
        source: { path: mathPath },
        line: 2,
      });
      expect(snapshot.scopes.flatMap((scope) => scope.variables).map((value) => value.name))
        .toEqual(expect.arrayContaining(['a', 'b']));
    }
    expect(new Set(snapshots.map((snapshot) => snapshot.pauseEpoch)).size).toBe(2);

    const firstTargetId = bothPaused.pausedTargetIds[0];
    const secondTargetId = bothPaused.pausedTargetIds[1];
    await mcp('control', { action: 'continue', targetId: firstTargetId });

    const onePaused = await waitForStatus(
      (status) => status.pausedTargetIds.length === 1,
    );
    expect(onePaused.pausedTargetIds).toEqual([secondTargetId]);

    // An explicit snapshot is scoped to that target. The resumed tab reports
    // running even while its sibling remains paused.
    await expect(mcp<McpSnapshot>('snapshot', { targetId: firstTargetId }))
      .resolves.toMatchObject({
        paused: false,
        targetId: firstTargetId,
        ready: false,
        frames: [],
      });

    const remainingSnapshot = await mcp<McpSnapshot>('snapshot', {
      targetId: secondTargetId,
    });
    expect(remainingSnapshot).toMatchObject({
      paused: true,
      targetId: secondTargetId,
      ready: true,
    });
    expect(remainingSnapshot.frames[0]).toMatchObject({
      source: { path: mathPath },
      line: 2,
    });

    await mcp('control', { action: 'continue', targetId: secondTargetId });
    const running = await waitForStatus((status) => !status.paused);
    expect(running.pausedTargetIds).toEqual([]);
  }, 45_000);
});
