import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import { DebugProtocol } from '@vscode/debugprotocol';
import { E2ESession, startAttachedSession } from '../helpers/session';
import { BrowserSession, openTab } from '../helpers/browser';
import { enableTestLogging } from '../helpers/logger';

/**
 * Regression coverage for the multi-tab breakpoint bug.
 *
 * Chrome models every tab as a separate CDP target with its own V8 isolate.
 * `Debugger.setBreakpointByUrl` only installs a breakpoint in the target it is
 * sent to — a `urlRegex` does NOT cross the tab boundary. The old adapter
 * connected to a single tab, so a breakpoint never fired if the code ran in any
 * other tab (or a tab opened after attach).
 *
 * These tests open a SECOND tab on the same Vite URL and assert that a
 * breakpoint still pauses when the code is triggered THERE — proving the
 * adapter attaches to every tab and installs the breakpoint in each.
 */
describe('Multi-tab breakpoints (every tab gets the breakpoint)', () => {
  let session: E2ESession;
  let mathPath: string;
  let extraTabs: BrowserSession[] = [];
  let isPaused = false;

  beforeAll(async () => {
    if (process.env.VITE_DEBUGGER_TEST_LOG) enableTestLogging();
    session = await startAttachedSession();
    mathPath = path.join(session.webRoot, 'src', 'math.ts');

    session.dap.on('stopped', () => { isPaused = true; });
    session.dap.on('continued', () => { isPaused = false; });

    if (process.env.VITE_DEBUGGER_TEST_LOG) {
      session.dap.on('output', (ev) => {
        const body = (ev.body as DebugProtocol.OutputEvent['body']) ?? {};
        if (body.output) process.stderr.write(`[adapter] ${body.output}`);
      });
    }
  }, 120_000);

  afterEach(async () => {
    await clearAllBreakpoints().catch(() => undefined);
    session?.dap.clearQueue('stopped', 'continued', 'breakpoint');
    await resumeIfPaused();
    // Close any tabs opened by the test so they don't leak across cases.
    for (const tab of extraTabs) {
      await tab.close().catch(() => undefined);
    }
    extraTabs = [];
  });

  afterAll(async () => {
    await session?.dispose();
  });

  async function setBpAt(line: number): Promise<DebugProtocol.Breakpoint[]> {
    const resp = await session.dap.request<
      DebugProtocol.SetBreakpointsRequest,
      DebugProtocol.SetBreakpointsResponse
    >('setBreakpoints', {
      source: { path: mathPath },
      breakpoints: [{ line }],
    });
    return resp.body!.breakpoints;
  }

  async function clearAllBreakpoints(): Promise<void> {
    await session.dap.request<
      DebugProtocol.SetBreakpointsRequest,
      DebugProtocol.SetBreakpointsResponse
    >('setBreakpoints', { source: { path: mathPath }, breakpoints: [] });
  }

  async function resumeIfPaused(): Promise<void> {
    if (!isPaused) return;
    await session.dap.request('continue', { threadId: 1 }).catch(() => undefined);
    isPaused = false;
  }

  async function openViteTab(): Promise<BrowserSession> {
    const tab = await openTab(session.chrome.port, session.vite.url);
    extraTabs.push(tab);
    // Wait for React to hydrate the button so the click has a target. By this
    // point the adapter has already auto-attached to the new target.
    await tab.waitForSelector('[data-testid="inc"]');
    // Small settle so the breakpoint is installed in this tab's session before
    // we trigger the code path.
    await new Promise((r) => setTimeout(r, 500));
    return tab;
  }

  async function getStackTopFrame(): Promise<DebugProtocol.StackFrame | undefined> {
    const resp = await session.dap.request<
      DebugProtocol.StackTraceRequest,
      DebugProtocol.StackTraceResponse
    >('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
    return resp.body!.stackFrames[0];
  }

  it('breakpoint set BEFORE a tab opens is replayed into the new tab and fires there', async () => {
    const [bp] = await setBpAt(2);
    expect(bp.verified).toBe(true);

    const tab2 = await openViteTab();

    session.dap.clearQueue('stopped');
    const stopped = session.dap.waitForEvent('stopped', 8000);
    await tab2.triggerClick('[data-testid="inc"]');

    // The core assertion: a click in the SECOND tab pauses. On the old
    // single-tab adapter this never fired.
    const ev = await stopped;
    expect(ev).toBeTruthy();

    const top = await getStackTopFrame();
    expect(top?.source?.path).toBe(mathPath);
    expect(top?.line).toBe(2);

    await resumeIfPaused();
  }, 30_000);

  it('breakpoint set AFTER a second tab is open fans out to that tab and fires there', async () => {
    const tab2 = await openViteTab();

    // Set the breakpoint while two tabs are already attached — it must be
    // installed in both.
    const [bp] = await setBpAt(2);
    expect(bp.verified).toBe(true);

    session.dap.clearQueue('stopped');
    const stopped = session.dap.waitForEvent('stopped', 8000);
    await tab2.triggerClick('[data-testid="inc"]');

    const ev = await stopped;
    expect(ev).toBeTruthy();

    const top = await getStackTopFrame();
    expect(top?.source?.path).toBe(mathPath);
    expect(top?.line).toBe(2);

    await resumeIfPaused();
  }, 30_000);

  it('the original tab still pauses too (no single-tab regression)', async () => {
    await setBpAt(2);
    // Open a second tab to make sure its presence does not steal breakpoints
    // from the first.
    await openViteTab();

    session.dap.clearQueue('stopped');
    const stopped = session.dap.waitForEvent('stopped', 8000);
    await session.browser.triggerClick('[data-testid="inc"]');

    const ev = await stopped;
    expect(ev).toBeTruthy();
    const top = await getStackTopFrame();
    expect(top?.source?.path).toBe(mathPath);
    expect(top?.line).toBe(2);

    await resumeIfPaused();
  }, 30_000);
});
