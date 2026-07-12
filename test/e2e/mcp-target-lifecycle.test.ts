import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as path from 'path';
import { E2ESession, startAttachedSession } from '../helpers/session';
import { enableTestLogging } from '../helpers/logger';

interface McpDapRequest extends DebugProtocol.Request {
  command: 'viteDebugger.mcp';
  arguments: { method: string; params?: unknown };
}

interface McpDapResponse<T> extends DebugProtocol.Response {
  body?: T;
}

interface McpStatus {
  paused: boolean;
  targets: Array<{ targetId: string; url: string; paused: boolean }>;
}

describe('MCP target lifecycle across cross-origin navigation', () => {
  let session: E2ESession;

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
      if (Date.now() >= deadline) throw new Error('Timed out waiting for MCP target lifecycle');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeAll(async () => {
    if (process.env.VITE_DEBUGGER_TEST_LOG) enableTestLogging();
    session = await startAttachedSession();
    if (process.env.VITE_DEBUGGER_TEST_LOG) {
      session.dap.on('output', (event) => {
        const body = event.body as DebugProtocol.OutputEvent['body'];
        if (body.output) process.stderr.write(`[adapter] ${body.output}`);
      });
    }
  }, 120_000);

  afterAll(async () => {
    const status = await mcp<McpStatus>('status').catch(() => undefined);
    for (const target of status?.targets ?? []) {
      if (target.paused) {
        await mcp('control', { action: 'continue', targetId: target.targetId })
          .catch(() => undefined);
      }
    }
    await session?.dispose();
  });

  it('removes an external page from management and safely re-manages it on return', async () => {
    const initial = await waitForStatus((status) => status.targets.length === 1);
    const targetId = initial.targets[0].targetId;

    await session.browser.navigate('data:text/html,<title>outside</title><h1>outside</h1>');
    const outside = await waitForStatus(
      (status) => !status.targets.some((target) => target.targetId === targetId),
    );
    expect(outside.targets).toEqual([]);
    await expect(mcp('control', { action: 'pause', targetId }))
      .rejects.toThrow(`Unknown or unmanaged Chrome target: ${targetId}`);

    await session.browser.navigate(session.vite.url);
    await session.browser.waitForSelector('[data-testid="inc"]');
    const returned = await waitForStatus(
      (status) => status.targets.some((target) => target.targetId === targetId),
    );
    expect(returned.targets).toHaveLength(1);

    // Status becomes visible just before async domain setup completes; give
    // the serialized re-entry lifecycle a short turn before issuing control.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const breakpoint = await mcp<{ breakpoints: Array<{ verified: boolean }> }>(
      'replaceBreakpoints',
      {
        sourcePath: path.join(session.webRoot, 'src', 'math.ts'),
        breakpoints: [{ line: 2 }],
      },
    );
    expect(breakpoint.breakpoints[0]?.verified).toBe(true);

    session.dap.clearQueue('stopped');
    const stopped = session.dap.waitForEvent('stopped', 10_000);
    await session.browser.triggerClick('[data-testid="inc"]');
    await stopped;
    const paused = await waitForStatus((status) => status.paused);
    expect(paused.targets.find((target) => target.targetId === targetId)?.paused).toBe(true);

    await mcp('control', { action: 'continue', targetId });
    await waitForStatus((status) => !status.paused);
    await mcp('replaceBreakpoints', {
      sourcePath: path.join(session.webRoot, 'src', 'math.ts'),
      breakpoints: [],
    });
  }, 40_000);
});
