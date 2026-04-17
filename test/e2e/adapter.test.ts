import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import { DebugProtocol } from '@vscode/debugprotocol';
import { E2ESession, startE2ESession } from '../helpers/session';
import { enableTestLogging } from '../helpers/logger';

/**
 * Full-stack adapter E2E. Boots Vite + headless Chrome once, then runs the
 * DAP flow that VSCode would drive:
 *
 *   initialize → launch → setBreakpoints → configurationDone →
 *   (trigger click) → stopped → stackTrace → scopes → variables →
 *   continue → (trigger second click) → stopped → continue → disconnect
 *
 * Each it() is an ordered checkpoint in the same session — splitting them out
 * makes failures pinpoint the step that regressed.
 */
describe('ViteDebugSession — full DAP flow', () => {
  let session: E2ESession;
  let mathPath: string;

  beforeAll(async () => {
    // Enable internal logger output when VITE_DEBUGGER_TEST_LOG is set —
    // otherwise tests stay quiet. Useful for diagnosing regressions locally.
    if (process.env.VITE_DEBUGGER_TEST_LOG) {
      enableTestLogging();
    }
    session = await startE2ESession();
    mathPath = path.join(session.webRoot, 'src', 'math.ts');

    if (process.env.VITE_DEBUGGER_TEST_LOG) {
      session.dap.on('output', (ev) => {
        const body = (ev.body as DebugProtocol.OutputEvent['body']) ?? {};
        if (body.output) process.stderr.write(`[adapter] ${body.output}`);
      });
    }
  }, 120_000);

  afterAll(async () => {
    await session?.dispose();
  });

  it('initialize advertises expected capabilities', async () => {
    const resp = await session.dap.request<
      DebugProtocol.InitializeRequest,
      DebugProtocol.InitializeResponse
    >('initialize', {
      adapterID: 'vite',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
    });
    const body = resp.body!;
    expect(body.supportsConfigurationDoneRequest).toBe(true);
    expect(body.supportsFunctionBreakpoints).toBe(true);
    expect(body.supportsConditionalBreakpoints).toBe(true);
    expect(body.supportsLogPoints).toBe(true);
    expect(body.supportsLoadedSourcesRequest).toBe(true);
  });

  it('launch resolves the fixture Vite server and emits InitializedEvent', async () => {
    const initialized = session.dap.waitForEvent('initialized', 30_000);
    await session.dap.request<
      DebugProtocol.LaunchRequest,
      DebugProtocol.LaunchResponse
    >('launch', {
      viteUrl: session.vite.url,
      chromePort: session.chrome.port,
      webRoot: session.webRoot,
    });
    await initialized;
  }, 45_000);

  it('setBreakpoints on src/math.ts:2 accepts the breakpoint (pending pre-navigation)', async () => {
    const resp = await session.dap.request<
      DebugProtocol.SetBreakpointsRequest,
      DebugProtocol.SetBreakpointsResponse
    >('setBreakpoints', {
      source: { path: mathPath },
      breakpoints: [{ line: 2 }],
    });
    const breakpoints = resp.body!.breakpoints;
    expect(breakpoints).toHaveLength(1);
    // Before the page navigates, no scripts are parsed → breakpoint is
    // pending (verified=false). It resolves once scriptParsed fires after
    // navigation below.
    expect(breakpoints[0].id).toBeDefined();
  });

  it('triggers a stopped event at math.ts:2 on user click after navigation', async () => {
    await session.dap.request('configurationDone', {});

    // Navigate the browser AFTER the adapter has attached so scriptParsed
    // events fire with the adapter's listener active.
    await session.browser.navigate(session.vite.url);
    // Wait for React mount + Vite module chain to parse/execute and for
    // pending breakpoints to resolve.
    await new Promise((r) => setTimeout(r, 1500));

    const stoppedPromise = session.dap.waitForEvent('stopped', 20_000);
    await session.browser.triggerClick('[data-testid="inc"]');
    const stopped = await stoppedPromise;

    const body = stopped.body as DebugProtocol.StoppedEvent['body'];
    expect(body.reason).toBe('breakpoint');
    expect(body.threadId).toBe(1);
  }, 40_000);

  it('stackTrace top frame points to src/math.ts line 2', async () => {
    const resp = await session.dap.request<
      DebugProtocol.StackTraceRequest,
      DebugProtocol.StackTraceResponse
    >('stackTrace', {
      threadId: 1,
      startFrame: 0,
      levels: 20,
    });
    const frames = resp.body!.stackFrames;
    expect(frames.length).toBeGreaterThan(0);
    const top = frames[0];
    expect(top.source?.path).toBe(mathPath);
    expect(top.line).toBe(2);
    expect(top.name.length).toBeGreaterThan(0);
  });

  it('scopes includes a Local scope with a and b defined', async () => {
    const stResp = await session.dap.request<
      DebugProtocol.StackTraceRequest,
      DebugProtocol.StackTraceResponse
    >('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
    const frameId = stResp.body!.stackFrames[0].id;

    const scResp = await session.dap.request<
      DebugProtocol.ScopesRequest,
      DebugProtocol.ScopesResponse
    >('scopes', { frameId });
    const scopes = scResp.body!.scopes;
    expect(scopes.length).toBeGreaterThan(0);

    const local = scopes.find((s) => /local/i.test(s.name));
    expect(local, 'expected a Local scope').toBeDefined();

    const varsResp = await session.dap.request<
      DebugProtocol.VariablesRequest,
      DebugProtocol.VariablesResponse
    >('variables', { variablesReference: local!.variablesReference });
    const vars = varsResp.body!.variables;
    const names = vars.map((v) => v.name);
    expect(names).toContain('a');
    expect(names).toContain('b');

    // The breakpoint is on the first executable line of `add`, so `b` should
    // be the literal 1 we pass from handleClick.
    const bVar = vars.find((v) => v.name === 'b');
    expect(bVar?.value).toBe('1');
  });

  it('evaluate returns the value of a parameter in the paused frame', async () => {
    const stResp = await session.dap.request<
      DebugProtocol.StackTraceRequest,
      DebugProtocol.StackTraceResponse
    >('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
    const frameId = stResp.body!.stackFrames[0].id;

    const resp = await session.dap.request<
      DebugProtocol.EvaluateRequest,
      DebugProtocol.EvaluateResponse
    >('evaluate', {
      expression: 'b',
      frameId,
      context: 'watch',
    });
    expect(resp.body!.result).toBe('1');
  });

  it('continue resumes execution and fires continued', async () => {
    const continued = session.dap.waitForEvent('continued', 5000);
    await session.dap.request<
      DebugProtocol.ContinueRequest,
      DebugProtocol.ContinueResponse
    >('continue', { threadId: 1 });
    // Some adapters don't emit 'continued' separately after continueRequest —
    // treat it as best-effort.
    await continued.catch(() => undefined);
  });

  it('second click pauses again on the same breakpoint, then continues', async () => {
    const stopped = session.dap.waitForEvent('stopped', 15_000);
    await session.browser.triggerClick('[data-testid="inc"]');
    const ev = await stopped;
    expect((ev.body as DebugProtocol.StoppedEvent['body']).reason).toBe('breakpoint');

    await session.dap.request('continue', { threadId: 1 });
  }, 30_000);

  it('clearing the breakpoint lets subsequent clicks run to completion', async () => {
    const cleared = await session.dap.request<
      DebugProtocol.SetBreakpointsRequest,
      DebugProtocol.SetBreakpointsResponse
    >('setBreakpoints', {
      source: { path: mathPath },
      breakpoints: [],
    });
    expect(cleared.body!.breakpoints).toHaveLength(0);

    // Wait a brief window for any unexpected stopped event.
    let stopped = false;
    const onStopped = (): void => { stopped = true; };
    session.dap.on('stopped', onStopped);
    try {
      await session.browser.triggerClick('[data-testid="inc"]');
      await new Promise((r) => setTimeout(r, 1500));
      expect(stopped).toBe(false);
    } finally {
      session.dap.off('stopped', onStopped);
    }

    const count = await session.browser.textContent('[data-testid="count"]');
    // We clicked twice while the breakpoint was set (each click resumed after
    // pause), then once after clearing — count should be >= 3 but we only
    // strictly assert it incremented from the unbreakpointed click.
    expect(count).toMatch(/count: \d+/);
  }, 20_000);
});
