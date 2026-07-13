import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => ({
  isTrusted: true,
  workspaceFolders: [] as Array<Record<string, unknown>>,
  configurations: [] as unknown[],
  startDebugging: vi.fn(),
  stopDebugging: vi.fn(),
}));

vi.mock('vscode', () => ({
  workspace: {
    get isTrusted() {
      return vscodeMock.isTrusted;
    },
    get workspaceFolders() {
      return vscodeMock.workspaceFolders;
    },
    getConfiguration: () => ({
      get: (key: string) => key === 'configurations'
        ? vscodeMock.configurations
        : undefined,
    }),
  },
  debug: {
    startDebugging: vscodeMock.startDebugging,
    stopDebugging: vscodeMock.stopDebugging,
  },
}));

import { BridgeServer } from '../../src/mcp/BridgeServer';
import { SessionRegistry } from '../../src/mcp/SessionRegistry';

interface DispatchRequest {
  jsonrpc: '2.0';
  id: number;
  method: 'startDebugging' | 'debugStartStatus' | 'cancelDebugStart';
  params: Record<string, unknown>;
}

interface TestBridgeInternals {
  readonly token: string;
  dispatch(request: DispatchRequest): Promise<unknown>;
}

const ROOT = fs.realpathSync.native(process.cwd());
const OTHER_ROOT = path.join(ROOT, 'not-the-served-workspace');

const folder = {
  uri: {
    scheme: 'file',
    fsPath: ROOT,
  },
  name: path.basename(ROOT),
  index: 0,
};

const bridges: BridgeServer[] = [];

function createBridge(): BridgeServer {
  const registry = {
    list: vi.fn(() => []),
    get: vi.fn(() => undefined),
    takeByStartOperationId: vi.fn(() => []),
  } as unknown as SessionRegistry;
  const bridge = new BridgeServer(registry, [ROOT]);
  bridges.push(bridge);
  return bridge;
}

function start(
  bridge: BridgeServer,
  options: {
    workspaceRoot?: string;
    configurationName?: string;
    operationId?: string;
    viteUrl?: string;
    pageUrl?: string;
  } = {},
): Promise<unknown> {
  const internals = bridge as unknown as TestBridgeInternals;
  const params: Record<string, unknown> = {
    token: internals.token,
    workspaceRoot: options.workspaceRoot ?? ROOT,
  };
  if (options.configurationName !== undefined) {
    params.configurationName = options.configurationName;
  }
  if (options.operationId !== undefined) {
    params.operationId = options.operationId;
  }
  if (options.viteUrl !== undefined) {
    params.viteUrl = options.viteUrl;
  }
  if (options.pageUrl !== undefined) {
    params.pageUrl = options.pageUrl;
  }
  return internals.dispatch({
    jsonrpc: '2.0',
    id: 1,
    method: 'startDebugging',
    params,
  });
}

function startStatus(bridge: BridgeServer, operationId: string): Promise<unknown> {
  const internals = bridge as unknown as TestBridgeInternals;
  return internals.dispatch({
    jsonrpc: '2.0',
    id: 2,
    method: 'debugStartStatus',
    params: {
      token: internals.token,
      workspaceRoot: ROOT,
      operationId,
    },
  });
}

function cancelStart(bridge: BridgeServer, operationId: string): Promise<unknown> {
  const internals = bridge as unknown as TestBridgeInternals;
  return internals.dispatch({
    jsonrpc: '2.0',
    id: 3,
    method: 'cancelDebugStart',
    params: {
      token: internals.token,
      workspaceRoot: ROOT,
      operationId,
    },
  });
}

function expectRpcError(
  promise: Promise<unknown>,
  code: number,
  message: string | RegExp,
): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code, message });
}

beforeEach(() => {
  vscodeMock.isTrusted = true;
  vscodeMock.workspaceFolders = [folder];
  vscodeMock.configurations = [];
  vscodeMock.startDebugging.mockReset();
  vscodeMock.startDebugging.mockResolvedValue(true);
  vscodeMock.stopDebugging.mockReset();
  vscodeMock.stopDebugging.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
});

describe('BridgeServer startDebugging policy', () => {
  it('accepts only the served canonical root and requires workspace trust', async () => {
    const canonicalEquivalent = path.join(ROOT, '.');
    const accepted = await start(createBridge(), { workspaceRoot: canonicalEquivalent });

    expect(accepted).toMatchObject({ accepted: true, source: 'generated' });
    expect(vscodeMock.startDebugging).toHaveBeenCalledTimes(1);

    vscodeMock.startDebugging.mockClear();
    await expectRpcError(
      start(createBridge(), { workspaceRoot: OTHER_ROOT }),
      -32602,
      'workspaceRoot is not served by this VS Code window',
    );
    expect(vscodeMock.startDebugging).not.toHaveBeenCalled();

    vscodeMock.isTrusted = false;
    await expectRpcError(
      start(createBridge()),
      -32020,
      /Trust this VS Code workspace/,
    );
    expect(vscodeMock.startDebugging).not.toHaveBeenCalled();
  });

  it('starts a validated cloned type=vite configuration with its task and safe VS Code options', async () => {
    const configured = {
      type: 'vite',
      request: 'attach',
      name: '  Captain frontend  ',
      preLaunchTask: 'captain:dev',
      viteUrl: 'https://alphac:3004/',
      chromePort: 9222,
    };
    vscodeMock.configurations = [
      { type: 'node', request: 'launch', name: 'Captain frontend' },
      configured,
      { type: 'vite', request: 'invalid', name: 'Ignored malformed Vite config' },
    ];

    const result = await start(createBridge(), { configurationName: 'Captain frontend' });

    expect(result).toMatchObject({
      accepted: true,
      reused: false,
      state: 'starting',
      configurationName: 'Captain frontend',
      source: 'workspace',
      request: 'attach',
      preLaunchTask: true,
    });
    expect(vscodeMock.startDebugging).toHaveBeenCalledTimes(1);
    const [actualFolder, actualConfiguration, actualOptions] =
      vscodeMock.startDebugging.mock.calls[0] as unknown as [
        typeof folder,
        Record<string, unknown>,
        Record<string, unknown>,
      ];
    expect(actualFolder).toBe(folder);
    expect(actualConfiguration).not.toBe(configured);
    expect(actualConfiguration).toMatchObject({
      type: 'vite',
      request: 'attach',
      name: 'Captain frontend',
      preLaunchTask: 'captain:dev',
      viteUrl: 'https://alphac:3004/',
      chromePort: 9222,
      _viteDebuggerMcpStartId: expect.any(String),
      _viteDebuggerMcpRequireWorkspaceMatch: true,
      _viteDebuggerMcpChromePortExplicit: true,
    });
    expect(actualOptions).toEqual({
      noDebug: false,
      suppressSaveBeforeStart: true,
    });
    expect(configured).toEqual({
      type: 'vite',
      request: 'attach',
      name: '  Captain frontend  ',
      preLaunchTask: 'captain:dev',
      viteUrl: 'https://alphac:3004/',
      chromePort: 9222,
    });
  });

  it('uses a task-free generated Vite launch when no valid Vite configuration exists', async () => {
    vscodeMock.configurations = [
      { type: 'node', request: 'launch', name: 'Run backend', preLaunchTask: 'unsafe-task' },
      { type: 'vite', request: 'launch', name: '' },
    ];

    const result = await start(createBridge());

    expect(result).toMatchObject({
      accepted: true,
      configurationName: 'Debug Vite App',
      source: 'generated',
      request: 'launch',
      preLaunchTask: false,
    });
    expect(vscodeMock.startDebugging).toHaveBeenCalledTimes(1);
    const configuration = vscodeMock.startDebugging.mock.calls[0][1] as Record<string, unknown>;
    expect(configuration).toMatchObject({
      type: 'vite',
      request: 'launch',
      name: 'Debug Vite App',
      webRoot: ROOT,
      _viteDebuggerMcpStartId: expect.any(String),
      _viteDebuggerMcpRequireWorkspaceMatch: true,
      _viteDebuggerMcpChromePortExplicit: false,
    });
    expect(configuration).not.toHaveProperty('preLaunchTask');
  });

  it('injects a validated local Vite origin into the generated launch', async () => {
    const result = await start(createBridge(), {
      viteUrl: 'http://127.0.0.1:5173/',
      pageUrl: 'http://127.0.0.1:8000/accounts/login/',
    });

    expect(result).toMatchObject({
      accepted: true,
      source: 'generated',
      viteUrl: 'http://127.0.0.1:5173',
      pageUrl: 'http://127.0.0.1:8000/accounts/login/',
    });
    const configuration = vscodeMock.startDebugging.mock.calls[0][1] as Record<string, unknown>;
    expect(configuration).toMatchObject({
      type: 'vite',
      request: 'launch',
      webRoot: ROOT,
      viteUrl: 'http://127.0.0.1:5173',
      pageUrl: 'http://127.0.0.1:8000/accounts/login/',
      _viteDebuggerMcpRequireWorkspaceMatch: true,
    });
  });

  it('overwrites user-authored MCP policy markers on a configured launch', async () => {
    vscodeMock.configurations = [{
      type: 'vite',
      request: 'launch',
      name: 'Marker override',
      _viteDebuggerMcpRequireWorkspaceMatch: false,
      _viteDebuggerMcpChromePortExplicit: true,
    }];

    await start(createBridge(), { configurationName: 'Marker override' });

    const configuration = vscodeMock.startDebugging.mock.calls[0][1] as Record<string, unknown>;
    expect(configuration).toMatchObject({
      _viteDebuggerMcpRequireWorkspaceMatch: true,
      _viteDebuggerMcpChromePortExplicit: false,
    });
  });

  it('accepts a configured literal IPv6 loopback page and rejects an unsafe inherited page', async () => {
    vscodeMock.configurations = [{
      type: 'vite',
      request: 'launch',
      name: 'IPv6 page',
      pageUrl: 'http://[::1]:8000/app',
    }];

    await start(createBridge(), { configurationName: 'IPv6 page' });
    const configuration = vscodeMock.startDebugging.mock.calls[0][1] as Record<string, unknown>;
    expect(configuration.pageUrl).toBe('http://[::1]:8000/app');

    vscodeMock.startDebugging.mockClear();
    vscodeMock.configurations = [{
      type: 'vite',
      request: 'launch',
      name: 'Unsafe page',
      pageUrl: 'https://example.com/app',
    }];
    await expectRpcError(
      start(createBridge(), { configurationName: 'Unsafe page' }),
      -32026,
      /unsafe pageUrl.*resolve exclusively to this machine/,
    );
    expect(vscodeMock.startDebugging).not.toHaveBeenCalled();
  });

  it.each([
    ['http://192.0.2.10:3004', 'resolve exclusively to this machine'],
    ['http://127.0.0.1:5173/src/main.ts', 'origin URL'],
    ['http://user:secret@127.0.0.1:5173', 'origin URL'],
    ['file:///tmp/app', 'http or https'],
  ])('rejects an unsafe MCP viteUrl: %s', async (viteUrl, message) => {
    await expectRpcError(start(createBridge(), { viteUrl }), -32602, new RegExp(message));
    expect(vscodeMock.startDebugging).not.toHaveBeenCalled();
  });

  it.each([
    ['http://192.0.2.10:8000/app', 'resolve exclusively to this machine'],
    ['http://user:secret@127.0.0.1:8000/app', 'must not contain credentials'],
    ['http://127.0.0.1:8000/app?token=secret', 'query'],
    ['file:///tmp/index.html', 'http or https'],
  ])('rejects an unsafe MCP pageUrl: %s', async (pageUrl, message) => {
    await expectRpcError(start(createBridge(), { pageUrl }), -32602, new RegExp(message));
    expect(vscodeMock.startDebugging).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'an explicitly named non-Vite configuration',
      configurations: [{ type: 'node', request: 'launch', name: 'Run frontend' }],
      requestedName: 'Run frontend',
      message: 'Vite debug configuration not found: Run frontend',
    },
    {
      label: 'a missing configuration name',
      configurations: [{ type: 'vite', request: 'launch', name: 'Available Vite' }],
      requestedName: 'Missing Vite',
      message: 'Vite debug configuration not found: Missing Vite',
    },
    {
      label: 'an ambiguous Vite configuration name',
      configurations: [
        { type: 'vite', request: 'launch', name: 'Duplicate Vite' },
        { type: 'vite', request: 'attach', name: 'Duplicate Vite' },
      ],
      requestedName: 'Duplicate Vite',
      message: 'Vite debug configuration name is ambiguous: Duplicate Vite',
    },
  ])('rejects $label instead of executing it', async ({ configurations, requestedName, message }) => {
    vscodeMock.configurations = configurations;

    await expectRpcError(
      start(createBridge(), { configurationName: requestedName }),
      -32022,
      message,
    );
    expect(vscodeMock.startDebugging).not.toHaveBeenCalled();
  });

  it('coalesces concurrent starts for one configuration and rejects a conflicting one', async () => {
    vscodeMock.configurations = [
      { type: 'vite', request: 'launch', name: 'Captain A' },
      { type: 'vite', request: 'attach', name: 'Captain B' },
    ];
    let finishStart!: (started: boolean) => void;
    vscodeMock.startDebugging.mockReturnValue(new Promise<boolean>((resolve) => {
      finishStart = resolve;
    }));
    const bridge = createBridge();

    const first = start(bridge, { configurationName: 'Captain A' });
    const duplicate = start(bridge, { configurationName: 'Captain A' });
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

    expect(vscodeMock.startDebugging).toHaveBeenCalledTimes(1);
    expect(duplicateResult).toBe(firstResult);
    await expectRpcError(
      start(bridge, { configurationName: 'Captain B' }),
      -32024,
      'A Vite debug start is already in progress for Captain A',
    );
    expect(vscodeMock.startDebugging).toHaveBeenCalledTimes(1);

    finishStart(true);
    await vi.waitFor(() => {
      const internals = bridge as unknown as { pendingDebugStarts: Map<string, unknown> };
      expect(internals.pendingDebugStarts.size).toBe(0);
    });
  });

  it('cancels and evicts only a registered session correlated to the timed-out start', async () => {
    let finishStart!: (started: boolean) => void;
    vscodeMock.startDebugging.mockReturnValue(new Promise<boolean>((resolve) => {
      finishStart = resolve;
    }));
    const correlatedSession = {
      id: 'timed-out-correlated-session',
      type: 'vite',
      name: 'Debug Vite App',
      configuration: {},
    };
    const registry = {
      list: vi.fn(() => []),
      get: vi.fn(() => undefined),
      takeByStartOperationId: vi.fn(() => [correlatedSession]),
    } as unknown as SessionRegistry;
    const bridge = new BridgeServer(registry, [ROOT]);
    bridges.push(bridge);
    const result = await start(bridge) as { operationId: string };

    await expect(cancelStart(bridge, result.operationId)).resolves.toMatchObject({
      operationId: result.operationId,
      cancelled: true,
      state: 'terminated',
      stoppedSessionCount: 1,
    });
    expect(registry.takeByStartOperationId).toHaveBeenCalledWith(result.operationId, ROOT);
    await vi.waitFor(() => {
      expect(vscodeMock.stopDebugging).toHaveBeenCalledWith(correlatedSession);
    });
    expect(await startStatus(bridge, result.operationId)).toMatchObject({ state: 'terminated' });

    finishStart(true);
    await Promise.resolve();
    expect(await startStatus(bridge, result.operationId)).toMatchObject({ state: 'terminated' });
  });

  it('releases a hung single-flight start when the adapter reports launch failure', async () => {
    vscodeMock.startDebugging
      .mockReturnValueOnce(new Promise<boolean>(() => undefined))
      .mockResolvedValueOnce(true);
    const bridge = createBridge();
    const first = await start(bridge) as { operationId: string };
    const failedSession = {
      id: 'adapter-launch-failed-session',
      type: 'vite',
      name: 'Debug Vite App',
      configuration: { _viteDebuggerMcpStartId: first.operationId },
    };

    bridge.recordDebugSessionFailure(failedSession as never, 'adapter launch failed');

    await expect(startStatus(bridge, first.operationId)).resolves.toMatchObject({
      state: 'failed',
      message: expect.stringContaining('adapter launch failed'),
    });
    const retried = await start(bridge) as { operationId: string };
    expect(retried.operationId).not.toBe(first.operationId);
    expect(vscodeMock.startDebugging).toHaveBeenCalledTimes(2);
  });

  it('does not cancel or duplicate a long preLaunchTask before a correlated session exists', async () => {
    let finishStart!: (started: boolean) => void;
    vscodeMock.startDebugging.mockReturnValue(new Promise<boolean>((resolve) => {
      finishStart = resolve;
    }));
    const bridge = createBridge();
    const first = await start(bridge) as { operationId: string };

    await expect(cancelStart(bridge, first.operationId)).resolves.toMatchObject({
      operationId: first.operationId,
      cancelled: false,
      state: 'starting',
      reason: 'noCorrelatedSession',
    });
    expect(vscodeMock.stopDebugging).not.toHaveBeenCalled();

    const duplicate = await start(bridge);
    expect(duplicate).toBe(first);
    expect(vscodeMock.startDebugging).toHaveBeenCalledTimes(1);

    finishStart(true);
    await vi.waitFor(async () => {
      await expect(startStatus(bridge, first.operationId)).resolves.toMatchObject({ state: 'accepted' });
    });
  });

  it('reuses a caller operation id after the original bridge response could have been lost', async () => {
    const bridge = createBridge();
    const operationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const first = await start(bridge, { operationId });
    await vi.waitFor(() => {
      const internals = bridge as unknown as { pendingDebugStarts: Map<string, unknown> };
      expect(internals.pendingDebugStarts.size).toBe(0);
    });

    const retried = await start(bridge, { operationId });

    expect(retried).toBe(first);
    expect(retried).toMatchObject({ operationId });
    expect(vscodeMock.startDebugging).toHaveBeenCalledTimes(1);
  });

  it('exposes an asynchronous VS Code decline without waiting for a session timeout', async () => {
    vscodeMock.startDebugging.mockResolvedValue(false);
    const bridge = createBridge();
    const result = await start(bridge) as { operationId: string };

    await vi.waitFor(async () => {
      await expect(startStatus(bridge, result.operationId)).resolves.toMatchObject({
        operationId: result.operationId,
        state: 'declined',
        configurationName: 'Debug Vite App',
        message: 'VS Code declined Vite debug configuration Debug Vite App',
      });
    });
  });

  it('evicts and stops a correlated session when VS Code declines launch', async () => {
    const failedSession = {
      id: 'failed-session',
      type: 'vite',
      name: 'Debug Vite App',
      configuration: {},
    };
    const registry = {
      list: vi.fn(() => []),
      get: vi.fn(() => undefined),
      takeByStartOperationId: vi.fn(() => [failedSession]),
    } as unknown as SessionRegistry;
    const bridge = new BridgeServer(registry, [ROOT]);
    bridges.push(bridge);
    vscodeMock.startDebugging.mockResolvedValue(false);

    const result = await start(bridge) as { operationId: string };
    await vi.waitFor(() => {
      expect(registry.takeByStartOperationId).toHaveBeenCalledWith(result.operationId, ROOT);
      expect(vscodeMock.stopDebugging).toHaveBeenCalledWith(failedSession);
    });
  });

  it('exposes a bounded asynchronous start failure through the scoped operation status', async () => {
    vscodeMock.startDebugging.mockRejectedValue(new Error(`task failed\u0000${'x'.repeat(3_000)}`));
    const bridge = createBridge();
    const result = await start(bridge) as { operationId: string };

    await vi.waitFor(async () => {
      const status = await startStatus(bridge, result.operationId) as Record<string, unknown>;
      expect(status).toMatchObject({
        operationId: result.operationId,
        state: 'failed',
        configurationName: 'Debug Vite App',
      });
      expect(status.message).toEqual(expect.stringContaining('task failed x'));
      expect((status.message as string).length).toBeLessThanOrEqual(2_000);
    });
  });

  it('reports a correlated adapter session that terminates before readiness', async () => {
    let finishStart!: (started: boolean) => void;
    vscodeMock.startDebugging.mockReturnValue(new Promise<boolean>((resolve) => {
      finishStart = resolve;
    }));
    const bridge = createBridge();
    const result = await start(bridge) as { operationId: string };

    bridge.recordDebugSessionTermination({
      id: 'terminated-session',
      type: 'vite',
      name: 'Debug Vite App',
      configuration: { _viteDebuggerMcpStartId: result.operationId },
    } as never);
    expect(await startStatus(bridge, result.operationId)).toMatchObject({
      state: 'terminated',
      message: 'Vite debug session Debug Vite App terminated before it became ready',
    });

    finishStart(true);
    await Promise.resolve();
    expect(await startStatus(bridge, result.operationId)).toMatchObject({ state: 'terminated' });
  });

  it('reports a correlated adapter initialization failure without waiting for VS Code decline', async () => {
    let finishStart!: (started: boolean) => void;
    vscodeMock.startDebugging.mockReturnValue(new Promise<boolean>((resolve) => {
      finishStart = resolve;
    }));
    const bridge = createBridge();
    const result = await start(bridge) as { operationId: string };
    const session = {
      id: 'adapter-failed-session',
      type: 'vite',
      name: 'Debug Vite App',
      configuration: { _viteDebuggerMcpStartId: result.operationId },
    } as never;

    bridge.recordDebugSessionFailure(session, 'No matching Vite root');
    expect(await startStatus(bridge, result.operationId)).toMatchObject({
      state: 'failed',
      message: expect.stringContaining('No matching Vite root'),
    });

    finishStart(false);
    await Promise.resolve();
    expect(await startStatus(bridge, result.operationId)).toMatchObject({ state: 'failed' });
  });
});

describe('SessionRegistry start correlation metadata', () => {
  it('preserves request and operation id when VS Code registers the same session again', () => {
    const registry = new SessionRegistry();
    const operationId = '12345678-1234-4234-8234-123456789abc';
    const base = {
      id: 'session-with-correlation',
      type: 'vite',
      name: 'Debug Vite App',
      workspaceFolder: folder,
      customRequest: vi.fn(),
    };

    registry.register({
      ...base,
      configuration: {
        request: 'launch',
        _viteDebuggerMcpStartId: operationId,
      },
    } as never);
    registry.register({ ...base, configuration: {} } as never);

    expect(registry.list(ROOT)).toEqual([
      expect.objectContaining({
        sessionId: base.id,
        request: 'launch',
        startOperationId: operationId,
      }),
    ]);
    registry.dispose();
  });

  it('takes only the failed operation sessions from the requested workspace', () => {
    const registry = new SessionRegistry();
    const operationId = '12345678-1234-4234-8234-123456789abc';
    const matching = {
      id: 'matching-session',
      type: 'vite',
      name: 'Debug Vite App',
      workspaceFolder: folder,
      configuration: { request: 'launch', _viteDebuggerMcpStartId: operationId },
      customRequest: vi.fn(),
    };
    const unrelated = {
      ...matching,
      id: 'unrelated-session',
      configuration: {
        request: 'launch',
        _viteDebuggerMcpStartId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      },
    };
    registry.register(matching as never);
    registry.register(unrelated as never);

    expect(registry.takeByStartOperationId(operationId, ROOT)).toEqual([matching]);
    expect(registry.list(ROOT)).toEqual([
      expect.objectContaining({ sessionId: 'unrelated-session' }),
    ]);
    registry.dispose();
  });
});
