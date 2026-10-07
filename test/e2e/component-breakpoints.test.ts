import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { DebugProtocol } from '@vscode/debugprotocol';
import { E2ESession, startAttachedSession } from '../helpers/session';
import { enableTestLogging } from '../helpers/logger';

describe.each([
  { name: 'normal Vite output', vite: {} },
  { name: 'one-line transformed output', vite: { compact: true } },
  { name: 'SWC React output', vite: { swc: true } },
  { name: 'Vite base path', vite: { base: '/debug/' } },
])('Component breakpoints: $name', ({ vite }) => {
  let session: E2ESession;
  let appPath: string;
  let casesPath: string;
  let casesSource: string;
  let pendingPath: string;
  let paused = false;

  beforeAll(async () => {
    if (process.env.VITE_DEBUGGER_TEST_LOG) enableTestLogging();
    session = await startAttachedSession({ vite });
    appPath = path.join(session.webRoot, 'src', 'App.tsx');
    casesPath = path.join(session.webRoot, 'src', 'components', 'RenderCases.tsx');
    pendingPath = path.join(session.webRoot, 'src', 'components', 'PendingCases.tsx');
    casesSource = await fs.promises.readFile(casesPath, 'utf8');
    session.dap.on('stopped', () => { paused = true; });
    session.dap.on('continued', () => { paused = false; });
    await session.dap.request('evaluate', {
      expression: `import(${JSON.stringify(session.vite.url + '/src/components/RenderCases.tsx')}).then(m => m.mountRenderCases())`,
      context: 'repl',
    });
    await session.browser.waitForSelector('[data-testid="render-cases-next"]');
  }, 120_000);

  afterEach(async () => {
    if (!session) return;
    await session.dap.request('setBreakpoints', {
      source: { path: appPath }, breakpoints: [],
    });
    await session.dap.request('setBreakpoints', {
      source: { path: casesPath }, breakpoints: [],
    });
    await session.dap.request('setBreakpoints', {
      source: { path: pendingPath }, breakpoints: [],
    });
    if (paused) await session.dap.request('continue', { threadId: 1 });
    session.dap.clearQueue('stopped', 'continued', 'breakpoint');
  });

  afterAll(async () => { await session?.dispose(); });

  it.each([
    { line: 6, selector: '[data-testid="inc"]', frameName: 'App' },
    { line: 9, selector: '[data-testid="inc"]', frameName: 'handleClick' },
    { line: 17, column: 38, selector: '[data-testid="inc"]', frameName: 'App' },
    { line: 23, selector: '[data-testid="lambda-multi"]', frameName: 'onClick' },
  ])('pauses in the requested component code at $line:$column', async ({ line, column, selector, frameName }) => {
    const set = await session.dap.request<
      DebugProtocol.SetBreakpointsRequest, DebugProtocol.SetBreakpointsResponse
    >('setBreakpoints', { source: { path: appPath }, breakpoints: [{ line, column }] });
    const bp = set.body!.breakpoints[0];
    expect(bp.verified).toBe(true);
    expect(bp.line).toBe(line);

    session.dap.clearQueue('stopped');
    await session.browser.triggerClick(selector);
    const stopped = await session.dap.waitForEvent('stopped', 5000);
    expect((stopped.body as DebugProtocol.StoppedEvent['body']).reason).toBe('breakpoint');
    const stack = await session.dap.request<
      DebugProtocol.StackTraceRequest, DebugProtocol.StackTraceResponse
    >('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
    const top = stack.body!.stackFrames[0];
    expect(top.source?.path).toBe(appPath);
    expect(top.line).toBe(line);
    expect(top.name).toBe(frameName);
    expect(top.column).toBe(bp.column);
  });

  it.each([
    { statement: 'const functionLabel', name: 'FunctionCase' },
    { statement: 'const arrowLabel', name: 'ArrowCase' },
    { statement: 'const memoLabel', name: 'MemoRender' },
    { statement: 'const refLabel', name: 'RefRender' },
    { statement: 'const classLabel', name: 'render' },
  ])('pauses inside $name on a React render', async ({ statement, name }) => {
    const line = casesSource.split('\n').findIndex((text) => text.includes(statement)) + 1;
    expect(line).toBeGreaterThan(0);
    const set = await session.dap.request<
      DebugProtocol.SetBreakpointsRequest, DebugProtocol.SetBreakpointsResponse
    >('setBreakpoints', { source: { path: casesPath }, breakpoints: [{ line }] });
    const bp = set.body!.breakpoints[0];
    expect(bp.verified).toBe(true);
    expect(bp.line).toBe(line);
    session.dap.clearQueue('stopped');
    await session.browser.triggerClick('[data-testid="render-cases-next"]');
    await session.dap.waitForEvent('stopped', 5000);
    const stack = await session.dap.request<
      DebugProtocol.StackTraceRequest, DebugProtocol.StackTraceResponse
    >('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
    expect(stack.body!.stackFrames[0]).toMatchObject({
      name, line, column: bp.column, source: { path: casesPath },
    });
  });

  it('reports the resolved callback body when a pending module is imported', async () => {
    session.dap.clearQueue('breakpoint');
    const set = await session.dap.request<
      DebugProtocol.SetBreakpointsRequest, DebugProtocol.SetBreakpointsResponse
    >('setBreakpoints', { source: { path: pendingPath }, breakpoints: [{ line: 2 }] });
    expect(set.body!.breakpoints[0].verified).toBe(false);
    const moduleUrl = JSON.stringify(session.vite.url + '/src/components/PendingCases.tsx');
    await session.dap.request('evaluate', { expression: `import(${moduleUrl})`, context: 'repl' });
    const changed = await session.dap.waitForEvent('breakpoint', 5000);
    const bp = (changed.body as DebugProtocol.BreakpointEvent['body']).breakpoint;
    expect(bp).toMatchObject({ verified: true, line: 3 });
    expect(bp.column).toBeGreaterThan(0);
    await session.dap.request('evaluate', {
      expression: `import(${moduleUrl}).then(m => { setTimeout(m.runPendingCase, 0); })`,
      context: 'repl',
    });
    await session.dap.waitForEvent('stopped', 5000);
    const stack = await session.dap.request<
      DebugProtocol.StackTraceRequest, DebugProtocol.StackTraceResponse
    >('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
    expect(stack.body!.stackFrames[0]).toMatchObject({
      line: 3, column: bp.column, source: { path: pendingPath },
    });
  });

  it('preserves the callback body location when HMR rebinds its header breakpoint', async () => {
    const original = await fs.promises.readFile(appPath, 'utf8');
    const set = await session.dap.request<
      DebugProtocol.SetBreakpointsRequest, DebugProtocol.SetBreakpointsResponse
    >('setBreakpoints', { source: { path: appPath }, breakpoints: [{ line: 22 }] });
    expect(set.body!.breakpoints[0]).toMatchObject({ verified: true, line: 23 });
    session.dap.clearQueue('breakpoint');
    try {
      await fs.promises.writeFile(appPath, original + '\n// component breakpoint HMR regression\n');
      const changed = await session.dap.waitForEvent('breakpoint', 5000);
      const bp = (changed.body as DebugProtocol.BreakpointEvent['body']).breakpoint;
      expect(bp).toMatchObject({ verified: true, line: 23, column: set.body!.breakpoints[0].column });
      await session.browser.triggerClick('[data-testid="lambda-multi"]');
      await session.dap.waitForEvent('stopped', 5000);
      const stack = await session.dap.request<
        DebugProtocol.StackTraceRequest, DebugProtocol.StackTraceResponse
      >('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
      expect(stack.body!.stackFrames[0]).toMatchObject({ line: 23, source: { path: appPath } });
    } finally {
      await fs.promises.writeFile(appPath, original);
    }
  });
});
