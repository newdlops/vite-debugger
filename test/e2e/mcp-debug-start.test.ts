import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeRpcError, type BridgeClient } from '../../src/mcp/BridgeClient';
import { createMcpServer } from '../../src/mcp/server';

interface StartArguments {
  configurationName?: string;
  operationId?: string;
  viteUrl?: string;
  pageUrl?: string;
  timeoutMs?: number;
}

interface FakeSession {
  sessionId: string;
  name: string;
  type: 'vite';
  request?: 'launch' | 'attach';
  workspaceRoot: string;
  startOperationId?: string;
  startedAt: number;
}

interface FakeBridgeState {
  startCalls: StartArguments[];
  listCalls: number;
  statusCalls: number;
  startStatusCalls: number;
  statusSessionIds: string[];
  ensureTargetCalls: string[];
  cancelCalls: string[];
}

interface Harness {
  client: Client;
  close(): Promise<void>;
}

const WORKSPACE = '/fixture/project';
const OPERATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION: FakeSession = {
  sessionId: 'vite-session-started-by-agent',
  name: 'Debug Vite App',
  type: 'vite',
  request: 'launch',
  workspaceRoot: WORKSPACE,
  startOperationId: OPERATION_ID,
  startedAt: 42,
};
const READY_STATUS = {
  connected: true,
  viteUrl: 'http://localhost:5173/',
  chromePort: 9222,
  paused: false,
  targets: [{
    targetId: 'target-started-by-agent',
    type: 'page',
    title: 'Fixture app',
    url: 'http://localhost:5173/',
    active: true,
    primary: true,
    paused: false,
  }],
};

const harnesses: Harness[] = [];

async function createHarness(options: {
  state: FakeBridgeState;
  start?: (params: StartArguments) => Promise<unknown>;
  list?: () => Promise<unknown>;
  status?: (sessionId: string) => Promise<unknown>;
  startStatus?: (operationId: string) => Promise<unknown>;
  cancel?: (operationId: string) => Promise<unknown>;
  ensureTarget?: (sessionId: string) => Promise<unknown>;
}): Promise<Harness> {
  const fakeBridge = {
    workspace: WORKSPACE,
    async startDebugging(params: StartArguments): Promise<unknown> {
      options.state.startCalls.push(params);
      return options.start
        ? options.start(params)
        : {
          accepted: true,
          reused: false,
          configurationName: params.configurationName ?? 'Debug Vite App',
          source: 'workspace',
          request: 'launch',
          preLaunchTask: false,
          operationId: params.operationId,
        };
    },
    async listSessions(): Promise<unknown> {
      options.state.listCalls += 1;
      return options.list
        ? options.list()
        : {
          sessions: options.state.startCalls.length === 0
            ? []
            : [{
              ...SESSION,
              startOperationId: options.state.startCalls[options.state.startCalls.length - 1].operationId,
            }],
        };
    },
    async debugStartStatus(operationId: string): Promise<unknown> {
      options.state.startStatusCalls += 1;
      return options.startStatus
        ? options.startStatus(operationId)
        : { operationId, state: 'accepted' };
    },
    async cancelDebugStart(operationId: string): Promise<unknown> {
      options.state.cancelCalls.push(operationId);
      return options.cancel
        ? options.cancel(operationId)
        : { operationId, cancelled: false, state: 'starting', reason: 'noCorrelatedSession' };
    },
    async sessionRequest(
      sessionId: string,
      method: string,
      _params: Record<string, unknown>,
    ): Promise<unknown> {
      if (method === 'status') {
        options.state.statusCalls += 1;
        options.state.statusSessionIds.push(sessionId);
        return options.status ? options.status(sessionId) : READY_STATUS;
      }
      if (method === 'ensureBrowserTarget') {
        options.state.ensureTargetCalls.push(sessionId);
        return options.ensureTarget
          ? options.ensureTarget(sessionId)
          : { targetId: 'target-recovered-by-agent', created: true };
      }
      throw new Error(`Unexpected fake bridge method: ${method}`);
    },
    close(): void {},
  } as unknown as BridgeClient;

  const server = createMcpServer(fakeBridge);
  const client = new Client({ name: 'vite-debugger-debug-start-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const harness: Harness = {
    client,
    async close(): Promise<void> {
      await client.close();
      await server.close();
    },
  };
  harnesses.push(harness);
  return harness;
}

function resultText(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === 'text' ? first.text : '';
}

function resultJson(result: CallToolResult): Record<string, unknown> {
  return JSON.parse(resultText(result)) as Record<string, unknown>;
}

function newState(): FakeBridgeState {
  return {
    startCalls: [],
    listCalls: 0,
    statusCalls: 0,
    startStatusCalls: 0,
    statusSessionIds: [],
    ensureTargetCalls: [],
    cancelCalls: [],
  };
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

describe('MCP debug_start contract', () => {
  it('is scoped to the discovered project and leaves default selection to the bridge', async () => {
    const state = newState();
    const { client } = await createHarness({ state });

    const tools = await client.listTools();
    const tool = tools.tools.find((candidate) => candidate.name === 'debug_start');
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.properties).toHaveProperty('configurationName');
    expect(tool?.inputSchema.properties).toHaveProperty('viteUrl');
    expect(tool?.inputSchema.properties).toHaveProperty('pageUrl');
    expect(tool?.inputSchema.properties).toHaveProperty('timeoutMs');
    // Workspace selection belongs to BridgeClient manifest discovery. An MCP
    // caller must not be able to redirect a start request into another window.
    expect(tool?.inputSchema.properties).not.toHaveProperty('workspaceRoot');
    expect(tool?.inputSchema.properties).not.toHaveProperty('sessionId');

    const result = await client.callTool({
      name: 'debug_start',
      arguments: {},
    }) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect(state.startCalls).toHaveLength(1);
    expect(state.startCalls[0].configurationName).toBeUndefined();
    expect(resultJson(result)).toMatchObject({
      workspace: WORKSPACE,
      sessionId: SESSION.sessionId,
      connected: true,
      targets: [{ targetId: 'target-started-by-agent' }],
    });
  });

  it('forwards an explicit configured launch name without synthesizing another name', async () => {
    const state = newState();
    const { client } = await createHarness({
      state,
      list: async () => ({
        sessions: state.startCalls.length === 0
          ? []
          : [{ ...SESSION, name: 'Captain frontend' }],
      }),
    });

    const result = await client.callTool({
      name: 'debug_start',
      arguments: {
        configurationName: 'Captain frontend',
        timeoutMs: 5_000,
      },
    }) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect(state.startCalls).toHaveLength(1);
    expect(state.startCalls[0]).toMatchObject({ configurationName: 'Captain frontend' });
  });

  it('forwards separate local Vite and browser page URLs for a generated or URL-selected start', async () => {
    const state = newState();
    const { client } = await createHarness({
      state,
      status: async () => ({
        ...READY_STATUS,
        viteUrl: 'https://alphac:3004/',
        pageUrl: 'http://alphac:8004/app',
        targets: [{ ...READY_STATUS.targets[0], url: 'http://alphac:8004/app' }],
      }),
    });

    const result = await client.callTool({
      name: 'debug_start',
      arguments: {
        viteUrl: 'https://alphac:3004',
        pageUrl: 'http://alphac:8004/app',
        timeoutMs: 5_000,
      },
    }) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect(state.startCalls).toHaveLength(1);
    expect(state.startCalls[0]).toMatchObject({
      viteUrl: 'https://alphac:3004',
      pageUrl: 'http://alphac:8004/app',
    });
  });

  it.each([999, 120_001])('rejects an out-of-range start timeout before bridge mutation: %d', async (timeoutMs) => {
    const state = newState();
    const { client } = await createHarness({ state });

    const result = await client.callTool({
      name: 'debug_start',
      arguments: { timeoutMs },
    }) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(state.startCalls).toHaveLength(0);
  });

  it('waits until the started launch session is connected and owns a Vite page', async () => {
    const state = newState();
    const sessionLists = [
      { sessions: [] },
      { sessions: [] },
      { sessions: [SESSION] },
    ];
    const statuses = [
      { ...READY_STATUS, connected: false, targets: [] },
      { ...READY_STATUS, targets: [] },
      READY_STATUS,
    ];
    const { client } = await createHarness({
      state,
      start: async () => ({
        accepted: true,
        reused: false,
        state: 'starting',
        request: 'launch',
        operationId: OPERATION_ID,
      }),
      list: async () => sessionLists.shift() ?? { sessions: [SESSION] },
      status: async () => statuses.shift() ?? READY_STATUS,
    });

    const result = await client.callTool({
      name: 'debug_start',
      arguments: { timeoutMs: 5_000 },
    }) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect(state.startCalls).toHaveLength(1);
    expect(state.listCalls).toBeGreaterThanOrEqual(3);
    expect(state.statusCalls).toBeGreaterThanOrEqual(3);
    expect(resultJson(result)).toMatchObject({
      sessionId: SESSION.sessionId,
      connected: true,
      targets: [{ targetId: 'target-started-by-agent' }],
    });
  });

  it('treats a connected attach session as ready even without a managed page', async () => {
    const state = newState();
    const { client } = await createHarness({
      state,
      start: async () => ({
        accepted: true,
        reused: false,
        configurationName: 'Attach to Vite App',
        source: 'workspace',
        request: 'attach',
        preLaunchTask: false,
      }),
      list: async () => ({
        sessions: state.startCalls.length === 0
          ? []
          : [{ ...SESSION, name: 'Attach to Vite App', request: 'attach' }],
      }),
      status: async () => ({ ...READY_STATUS, targets: [] }),
    });

    const result = await client.callTool({
      name: 'debug_start',
      arguments: { configurationName: 'Attach to Vite App' },
    }) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect(resultJson(result)).toMatchObject({
      sessionId: SESSION.sessionId,
      connected: true,
      targets: [],
    });
    expect(resultText(result)).toContain('browser_navigate');
  });

  it('does not confuse an unrelated markerless session with the correlated start', async () => {
    const state = newState();
    const unrelated: FakeSession = {
      ...SESSION,
      sessionId: 'unrelated-manual-session',
      startOperationId: undefined,
    };
    let listCall = 0;
    const { client } = await createHarness({
      state,
      start: async () => ({
        accepted: true,
        reused: false,
        state: 'starting',
        request: 'launch',
        operationId: OPERATION_ID,
      }),
      list: async () => {
        listCall += 1;
        if (listCall === 1) return { sessions: [] };
        if (listCall === 2) return { sessions: [unrelated] };
        return { sessions: [unrelated, SESSION] };
      },
      startStatus: async () => ({ operationId: OPERATION_ID, state: 'accepted' }),
    });

    const result = await client.callTool({
      name: 'debug_start',
      arguments: { timeoutMs: 5_000 },
    }) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect(state.statusSessionIds).toEqual([SESSION.sessionId]);
    expect(resultJson(result)).toMatchObject({ sessionId: SESSION.sessionId, ready: true });
  });

  it('reports an asynchronous VS Code decline immediately', async () => {
    const state = newState();
    const { client } = await createHarness({
      state,
      start: async () => ({
        accepted: true,
        reused: false,
        state: 'starting',
        request: 'launch',
        operationId: OPERATION_ID,
      }),
      list: async () => ({ sessions: [] }),
      startStatus: async () => ({
        operationId: OPERATION_ID,
        state: 'declined',
        message: 'VS Code declined Vite debug configuration Debug Vite App',
      }),
    });
    const startedAt = Date.now();

    const result = await client.callTool({
      name: 'debug_start',
      arguments: { timeoutMs: 5_000 },
    }) as CallToolResult;

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.isError).toBe(true);
    expect(resultJson(result)).toMatchObject({
      ready: false,
      state: 'declined',
      message: 'VS Code declined Vite debug configuration Debug Vite App',
    });
  });

  it('reports a correlated adapter session that terminated before readiness', async () => {
    const state = newState();
    const { client } = await createHarness({
      state,
      start: async () => ({
        accepted: true,
        reused: false,
        state: 'starting',
        request: 'launch',
        operationId: OPERATION_ID,
      }),
      list: async () => ({ sessions: [] }),
      startStatus: async () => ({
        operationId: OPERATION_ID,
        state: 'terminated',
        message: 'Vite debug session Debug Vite App terminated before it became ready',
      }),
    });

    const result = await client.callTool({
      name: 'debug_start',
      arguments: { timeoutMs: 5_000 },
    }) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(resultJson(result)).toMatchObject({ ready: false, state: 'terminated' });
  });

  it('returns a bounded starting state instead of duplicating a slow preLaunchTask', async () => {
    const state = newState();
    const { client } = await createHarness({
      state,
      list: async () => ({ sessions: [] }),
    });

    const result = await client.callTool({
      name: 'debug_start',
      arguments: { timeoutMs: 1_000 },
    }) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect(state.startCalls).toHaveLength(1);
    expect(resultJson(result)).toMatchObject({
      ready: false,
      state: 'starting',
      sessions: [],
    });
    expect(state.cancelCalls).toEqual([]);
  });

  it('cancels a correlated registered session when adapter readiness misses the deadline', async () => {
    const state = newState();
    const { client } = await createHarness({
      state,
      start: async () => ({
        accepted: true,
        reused: false,
        state: 'starting',
        request: 'launch',
        operationId: OPERATION_ID,
      }),
      list: async () => state.startCalls.length === 0
        ? { sessions: [] }
        : { sessions: [SESSION] },
      status: async () => ({ ...READY_STATUS, connected: false, targets: [] }),
      startStatus: async () => ({ operationId: OPERATION_ID, state: 'accepted' }),
      cancel: async () => ({
        operationId: OPERATION_ID,
        cancelled: true,
        state: 'terminated',
        stoppedSessionCount: 1,
        message: 'Stopped timed-out correlated Vite session',
      }),
    });

    const result = await client.callTool({
      name: 'debug_start',
      arguments: { timeoutMs: 1_000 },
    }) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(state.cancelCalls).toEqual([OPERATION_ID]);
    expect(resultJson(result)).toMatchObject({
      ready: false,
      state: 'terminated',
      cleanup: {
        attempted: true,
        cancelled: true,
        state: 'terminated',
      },
    });
  });

  it.each([
    {
      label: 'configuration',
      arguments: { configurationName: 'Captain frontend' },
      listSession: SESSION,
      status: READY_STATUS,
    },
    {
      label: 'Vite origin',
      arguments: { viteUrl: 'http://localhost:3004' },
      listSession: SESSION,
      status: READY_STATUS,
    },
    {
      label: 'browser page',
      arguments: { pageUrl: 'http://localhost:8004/expected' },
      listSession: SESSION,
      status: {
        ...READY_STATUS,
        pageUrl: 'http://localhost:8004/other',
        targets: [{ ...READY_STATUS.targets[0], url: 'http://localhost:8004/other' }],
      },
    },
  ])('revalidates requested $label when the bridge wins a TOCTOU race by reusing a session', async ({
    arguments: startArguments,
    listSession,
    status,
  }) => {
    const state = newState();
    const { client } = await createHarness({
      state,
      start: async () => ({ accepted: false, reused: true, request: 'launch' }),
      list: async () => state.startCalls.length === 0
        ? { sessions: [] }
        : { sessions: [listSession] },
      status: async () => status,
    });

    const result = await client.callTool({
      name: 'debug_start',
      arguments: { ...startArguments, timeoutMs: 5_000 },
    }) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(resultJson(result)).toMatchObject({ state: 'conflict', ready: false });
  });

  it('reuses one active workspace session without issuing duplicate starts', async () => {
    const state = newState();
    const { client } = await createHarness({
      state,
      list: async () => ({ sessions: [SESSION] }),
    });

    const result = await client.callTool({
      name: 'debug_start',
      arguments: {},
    }) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect(state.startCalls).toHaveLength(0);
    expect(resultJson(result)).toMatchObject({
      sessionId: SESSION.sessionId,
      connected: true,
    });
  });

  it('does not reuse an active session for a different requested Vite origin', async () => {
    const state = newState();
    const { client } = await createHarness({
      state,
      list: async () => ({ sessions: [SESSION] }),
    });

    const result = await client.callTool({
      name: 'debug_start',
      arguments: { viteUrl: 'http://localhost:3004' },
    }) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(state.startCalls).toHaveLength(0);
    expect(resultJson(result)).toMatchObject({ state: 'conflict' });
  });

  it('does not reuse an active session for a different requested browser page URL', async () => {
    const state = newState();
    const { client } = await createHarness({
      state,
      list: async () => ({ sessions: [SESSION] }),
      status: async () => ({
        ...READY_STATUS,
        viteUrl: 'http://localhost:3004/',
        pageUrl: 'http://localhost:8004/app',
        targets: [{
          ...READY_STATUS.targets[0],
          url: 'http://localhost:8004/app',
        }],
      }),
    });

    const result = await client.callTool({
      name: 'debug_start',
      arguments: { pageUrl: 'http://localhost:8004/other-app' },
    }) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(state.startCalls).toHaveLength(0);
    expect(resultJson(result)).toMatchObject({ state: 'conflict' });
  });

  it('does not reuse an active session created from another named configuration', async () => {
    const state = newState();
    const { client } = await createHarness({
      state,
      list: async () => ({ sessions: [SESSION] }),
    });

    const result = await client.callTool({
      name: 'debug_start',
      arguments: { configurationName: 'Captain frontend' },
    }) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(state.startCalls).toHaveLength(0);
    expect(state.statusCalls).toBe(0);
    expect(resultJson(result)).toMatchObject({ state: 'conflict' });
    expect(resultText(result)).toContain('Debug Vite App');
    expect(resultText(result)).toContain('Captain frontend');
  });

  it('surfaces the original failed start instead of treating its registry entry as reusable', async () => {
    const state = newState();
    const failed = { ...SESSION, startOperationId: OPERATION_ID };
    const { client } = await createHarness({
      state,
      list: async () => ({ sessions: [failed] }),
      status: async () => {
        throw new Error("No debugger available, can not send 'viteDebugger.mcp'");
      },
      startStatus: async () => ({
        operationId: OPERATION_ID,
        state: 'declined',
        message: 'VS Code declined Vite debug configuration Debug Vite App',
      }),
    });

    const result = await client.callTool({
      name: 'debug_start',
      arguments: { timeoutMs: 5_000 },
    }) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(state.startCalls).toHaveLength(0);
    expect(resultJson(result)).toMatchObject({ state: 'declined', ready: false });
  });

  it('recovers a closed tab for a reused launch session and remains actionable if recovery fails', async () => {
    const state = newState();
    const { client } = await createHarness({
      state,
      list: async () => ({ sessions: [SESSION] }),
      status: async () => ({ ...READY_STATUS, targets: [] }),
      ensureTarget: async () => { throw new Error('Chrome is temporarily unavailable'); },
    });

    const result = await client.callTool({
      name: 'debug_start',
      arguments: { timeoutMs: 5_000 },
    }) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect(state.startCalls).toHaveLength(0);
    expect(state.ensureTargetCalls).toEqual([SESSION.sessionId]);
    expect(resultJson(result)).toMatchObject({
      ready: true,
      reused: true,
      connected: true,
      targets: [],
    });
    expect(resultText(result)).toContain('browser_navigate');
  });

  it('keeps timeoutMs as a hard bound when a session-list RPC never resolves', async () => {
    const state = newState();
    let listCall = 0;
    const { client } = await createHarness({
      state,
      list: async () => {
        listCall += 1;
        if (listCall === 1) return { sessions: [] };
        return new Promise<unknown>(() => {});
      },
    });
    const startedAt = Date.now();

    const result = await client.callTool({
      name: 'debug_start',
      arguments: { timeoutMs: 1_000 },
    }) as CallToolResult;

    expect(Date.now() - startedAt).toBeLessThan(1_800);
    expect(result.isError).not.toBe(true);
    expect(state.startCalls).toHaveLength(1);
    expect(resultJson(result)).toMatchObject({ ready: false, state: 'starting' });
  });

  it('does not invoke the mutating start RPC after the initial read consumes the deadline', async () => {
    const state = newState();
    const { client } = await createHarness({
      state,
      list: async () => new Promise((resolve) => {
        setTimeout(() => resolve({ sessions: [] }), 1_100);
      }),
    });
    const startedAt = Date.now();

    const result = await client.callTool({
      name: 'debug_start',
      arguments: { timeoutMs: 1_000 },
    }) as CallToolResult;

    expect(Date.now() - startedAt).toBeLessThan(1_800);
    expect(result.isError).toBe(true);
    expect(state.startCalls).toHaveLength(0);
  });

  it('surfaces bounded available Vite configuration names from bridge policy errors', async () => {
    const state = newState();
    const { client } = await createHarness({
      state,
      start: async () => {
        throw new BridgeRpcError(
          'Multiple Vite debug configurations are available; pass configurationName explicitly',
          -32022,
          { availableConfigurations: ['Captain frontend', 'Admin frontend'] },
        );
      },
    });

    const result = await client.callTool({
      name: 'debug_start',
      arguments: {},
    }) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Available Vite configurations: Captain frontend, Admin frontend');
  });

  it.each([
    'Workspace trust is required before an agent can start debugging',
    'Configured Vite launch "Other project" was not found',
    'Debug configuration "Node server" is not a Vite launch configuration',
    'Multiple Vite debug configurations are available; pass configurationName',
  ])('surfaces bridge policy rejection without polling sessions: %s', async (message) => {
    const state = newState();
    const { client } = await createHarness({
      state,
      start: async () => { throw new Error(message); },
    });

    const result = await client.callTool({
      name: 'debug_start',
      arguments: {},
    }) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(message);
    expect(state.startCalls).toHaveLength(1);
    expect(state.listCalls).toBe(1);
    expect(state.statusCalls).toBe(0);
  });
});
