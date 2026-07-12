import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BridgeClient } from '../../src/mcp/BridgeClient';
import { createMcpServer } from '../../src/mcp/server';

describe('MCP protocol surface', () => {
  const calls: Array<{ sessionId: string; method: string; params: Record<string, unknown> }> = [];
  let targets = [{
    targetId: 'target-1',
    type: 'page',
    title: 'Fixture app',
    url: 'http://localhost:5173/',
    active: true,
    primary: true,
    paused: false,
  }];
  const fakeBridge = {
    workspace: '/fixture/project',
    async listSessions(): Promise<unknown> {
      return {
        sessions: [{
          sessionId: 'vite-session-1',
          name: 'Debug Vite App',
          type: 'vite',
          workspaceRoot: '/fixture/project',
          startedAt: 1,
        }],
      };
    },
    async sessionRequest(
      sessionId: string,
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> {
      calls.push({ sessionId, method, params });
      if (method === 'status') {
        return {
          connected: true,
          viteUrl: 'http://localhost:5173/',
          chromePort: 9222,
          paused: false,
          pauseEpoch: 4,
          activeTargetId: 'target-1',
          targets,
        };
      }
      if (method === 'snapshot') {
        return { paused: false, pauseEpoch: 4, ready: false, frames: [], scopes: [] };
      }
      if (method === 'control' || method === 'replaceBreakpoints') {
        return { accepted: true, method, params };
      }
      throw new Error(`Unexpected fake bridge method: ${method}`);
    },
    close(): void {},
  } as unknown as BridgeClient;

  const server = createMcpServer(fakeBridge);
  const client = new Client({ name: 'vite-debugger-test', version: '1.0.0' });

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it('advertises the debugger and Playwright tool set', async () => {
    const response = await client.listTools();
    expect(response.tools.map((tool) => tool.name).sort()).toEqual([
      'browser_click',
      'browser_console_messages',
      'browser_fill',
      'browser_navigate',
      'browser_network_requests',
      'browser_press',
      'browser_screenshot',
      'browser_snapshot',
      'browser_tabs',
      'debug_control',
      'debug_replace_breakpoints',
      'debug_snapshot',
      'debug_status',
    ]);
  });

  it('routes MCP status and snapshot calls through the selected debug session', async () => {
    const status = await client.callTool({ name: 'debug_status', arguments: {} }) as CallToolResult;
    expect(status.isError).not.toBe(true);
    expect(JSON.parse(status.content[0].type === 'text' ? status.content[0].text : '{}')).toMatchObject({
      workspace: '/fixture/project',
      sessionId: 'vite-session-1',
      connected: true,
      chromePort: 9222,
      activeTargetId: 'target-1',
    });

    const snapshot = await client.callTool({
      name: 'debug_snapshot',
      arguments: { maxFrames: 3, maxVariables: 7 },
    }) as CallToolResult;
    expect(snapshot.isError).not.toBe(true);
    expect(calls.at(-1)).toEqual({
      sessionId: 'vite-session-1',
      method: 'snapshot',
      params: { targetId: undefined, maxFrames: 3, maxVariables: 7 },
    });
  });

  it('requires an explicit target for control when several Vite tabs are managed', async () => {
    targets = [
      { ...targets[0], targetId: 'target-1', active: true },
      { ...targets[0], targetId: 'target-2', active: false },
    ];
    const callCount = calls.length;
    const ambiguous = await client.callTool({
      name: 'debug_control',
      arguments: { action: 'pause' },
    }) as CallToolResult;
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0].type === 'text' ? ambiguous.content[0].text : '')
      .toContain('requires targetId');
    expect(calls.slice(callCount).some((call) => call.method === 'control')).toBe(false);

    const selected = await client.callTool({
      name: 'debug_control',
      arguments: { action: 'pause', targetId: 'target-2' },
    }) as CallToolResult;
    expect(selected.isError).not.toBe(true);
    expect(calls.at(-1)).toMatchObject({
      method: 'control',
      params: { action: 'pause', targetId: 'target-2' },
    });
    targets = [{ ...targets[0], targetId: 'target-1', active: true }];
  });

  it('auto-selects one target for control and keeps targetId out of breakpoint requests', async () => {
    const control = await client.callTool({
      name: 'debug_control',
      arguments: { action: 'reload' },
    }) as CallToolResult;
    expect(control.isError).not.toBe(true);
    expect(calls.at(-1)).toMatchObject({
      method: 'control',
      params: { action: 'reload', targetId: 'target-1' },
    });

    const replaced = await client.callTool({
      name: 'debug_replace_breakpoints',
      arguments: {
        source: '/fixture/project/src/math.ts',
        breakpoints: [{ line: 2 }],
        targetId: 'target-outside-schema',
      },
    }) as CallToolResult;
    expect(replaced.isError).not.toBe(true);
    expect(calls.at(-1)).toEqual({
      sessionId: 'vite-session-1',
      method: 'replaceBreakpoints',
      params: {
        sourcePath: '/fixture/project/src/math.ts',
        breakpoints: [{ line: 2 }],
      },
    });

    const tools = await client.listTools();
    const breakpointTool = tools.tools.find((tool) => tool.name === 'debug_replace_breakpoints');
    expect(breakpointTool?.inputSchema.properties).not.toHaveProperty('targetId');
  });
});
