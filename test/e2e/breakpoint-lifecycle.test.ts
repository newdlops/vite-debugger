import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DebugProtocol } from '@vscode/debugprotocol';
import { E2ESession, startAttachedSession } from '../helpers/session';
import { enableTestLogging } from '../helpers/logger';

/**
 * Regression coverage for breakpoint set/clear/HMR interactions. The
 * observed bug: after a few HMR cycles, breakpoints that VSCode thinks it
 * has removed continue to pause execution — i.e. setBreakpoints(path, [])
 * is ignored because a stale CDP breakpoint outlives our removal pass.
 *
 * Each test drives the DAP the way VSCode would, then uses user-level
 * probes (a click that would hit the breakpoint) to assert *behavior*:
 *   - "paused" vs "not paused" within a short window
 *   - pause location when one did occur
 *   - that exactly one stop fires per click (no duplicates from stale
 *     CDP breakpoints silently attached to the new script).
 */
describe('Breakpoint lifecycle regression (HMR + clear)', () => {
  let session: E2ESession;
  let mathPath: string;
  let originalMath: string;
  let hmrCounter = 0;

  let isPaused = false;

  beforeAll(async () => {
    if (process.env.VITE_DEBUGGER_TEST_LOG) enableTestLogging();
    session = await startAttachedSession();
    mathPath = path.join(session.webRoot, 'src', 'math.ts');
    originalMath = await fs.promises.readFile(mathPath, 'utf8');

    // Track pause state so resumeIfPaused only issues `continue` when
    // actually paused — otherwise the adapter's cdp.resume() throws and
    // leaks as an unhandled rejection (DebugSession.dispatchRequest does
    // not await async handler errors).
    session.dap.on('stopped', () => { isPaused = true; });
    session.dap.on('continued', () => { isPaused = false; });

    if (process.env.VITE_DEBUGGER_TEST_LOG) {
      session.dap.on('output', (ev) => {
        const body = (ev.body as DebugProtocol.OutputEvent['body']) ?? {};
        if (body.output) process.stderr.write(`[adapter] ${body.output}`);
      });
    }
  }, 120_000);

  afterAll(async () => {
    // Always restore the fixture file so the tree isn't left dirty even
    // if a test failed mid-edit.
    if (originalMath && mathPath) {
      await fs.promises.writeFile(mathPath, originalMath).catch(() => undefined);
    }
    await session?.dispose();
  });

  afterEach(async () => {
    // Clear the breakpoint so subsequent tests start from a clean state.
    await clearAllBreakpoints().catch(() => undefined);
    // Drain any leftover 'stopped' / 'continued' events from the queue.
    session?.dap.clearQueue('stopped', 'continued', 'breakpoint');
    // If a test left the debugger paused (e.g. assertion failure), make
    // sure we resume so the next test's click isn't blocked.
    await resumeIfPaused();
    // Restore math.ts to its pristine state so tests never interact via
    // a file that was edited by a previous test.
    await fs.promises.writeFile(mathPath, originalMath).catch(() => undefined);
    // Let the adapter process the restore-as-HMR so subsequent bp resolve
    // against the restored script.
    await waitForHmrSettle();
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
    >('setBreakpoints', {
      source: { path: mathPath },
      breakpoints: [],
    });
  }

  async function resumeIfPaused(): Promise<void> {
    if (!isPaused) return;
    await session.dap.request('continue', { threadId: 1 }).catch(() => undefined);
    isPaused = false;
  }

  /**
   * Trigger a Vite HMR cycle by appending a trailing comment to math.ts
   * (preserving line numbers 1..4 so breakpoints on those lines stay
   * meaningful). Vite's file watcher detects the change and re-emits the
   * module; the adapter's scriptParsed handler treats it as HMR reload
   * and runs handleHmrReload() after a 100ms batch timer.
   */
  async function triggerHmr(): Promise<void> {
    hmrCounter++;
    const modified = `${originalMath}\n// hmr-${hmrCounter}-${Date.now()}\n`;
    await fs.promises.writeFile(mathPath, modified);
    await waitForHmrSettle();
  }

  async function waitForHmrSettle(): Promise<void> {
    // Vite debounces watch events briefly; adapter batches scriptParsed for
    // 100ms then re-resolves breakpoints. 800ms is conservative but keeps
    // the suite snappy.
    await new Promise((r) => setTimeout(r, 800));
  }

  /**
   * Fire a click that WOULD hit the current breakpoint (if any), and check
   * whether a stopped event arrives within `windowMs`. Returns whether a
   * pause happened. Always leaves the debugger running afterward.
   */
  async function clickAndCheckPause(windowMs = 2500): Promise<
    { paused: true; event: DebugProtocol.Event } | { paused: false }
  > {
    // Drop any stale stopped events from prior clicks so waitForEvent only
    // sees events produced by THIS click.
    session.dap.clearQueue('stopped');
    const stoppedPromise = session.dap.waitForEvent('stopped', windowMs);
    await session.browser.triggerClick('[data-testid="inc"]');
    try {
      const ev = await stoppedPromise;
      await resumeIfPaused();
      return { paused: true, event: ev };
    } catch {
      return { paused: false };
    }
  }

  async function getStackTopFrame(): Promise<DebugProtocol.StackFrame | undefined> {
    const resp = await session.dap.request<
      DebugProtocol.StackTraceRequest,
      DebugProtocol.StackTraceResponse
    >('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
    return resp.body!.stackFrames[0];
  }

  it('baseline: set → hit → clear → no pause', async () => {
    const [bp] = await setBpAt(2);
    expect(bp.verified).toBe(true);

    const first = await clickAndCheckPause();
    expect(first.paused).toBe(true);

    await clearAllBreakpoints();

    const second = await clickAndCheckPause();
    expect(second.paused).toBe(false);
  }, 30_000);

  it('rapid re-sets at the same location (simulates VSCode save pattern) do not leak CDP bps', async () => {
    // VSCode re-issues setBreakpoints on every buffer save. Each call goes
    // through remove-then-set. If the remove side leaks, we accumulate CDP
    // breakpoints that all fire on a single click → the adapter sees more
    // than one 'stopped' event.
    await setBpAt(2);
    await setBpAt(2);
    await setBpAt(2);

    let stopCount = 0;
    const onStopped = (): void => {
      stopCount++;
    };
    session.dap.on('stopped', onStopped);
    try {
      await session.browser.triggerClick('[data-testid="inc"]');
      // Give the debugger enough time for any duplicate stops to arrive.
      await new Promise((r) => setTimeout(r, 1500));
      await resumeIfPaused();
      // Another slice of time to catch late duplicates after resume.
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      session.dap.off('stopped', onStopped);
    }
    expect(stopCount).toBe(1);

    await clearAllBreakpoints();
    const afterClear = await clickAndCheckPause();
    expect(afterClear.paused).toBe(false);
  }, 30_000);

  it('breakpoint survives an HMR edit and still pauses at the same line', async () => {
    await setBpAt(2);

    await triggerHmr();

    const hit = await clickAndCheckPause(4000);
    expect(hit.paused).toBe(true);
  }, 30_000);

  it('clearing after HMR actually clears (regression): click does not pause', async () => {
    // Arrange: set bp, confirm it fires once, then HMR.
    await setBpAt(2);
    const first = await clickAndCheckPause();
    expect(first.paused).toBe(true);

    await triggerHmr();

    // Act: user clears the breakpoint.
    await clearAllBreakpoints();

    // Assert: the next click must run to completion without pausing.
    // This is the regression — previously a stale CDP breakpoint (bound to
    // the pre-HMR script, or newly created by resolveBreakpointsForScript
    // mid-HMR) would continue to fire.
    const after = await clickAndCheckPause(3000);
    expect(after.paused).toBe(false);
  }, 30_000);

  it('moving bp to a different line after HMR pauses only at the new line', async () => {
    await setBpAt(2);
    await triggerHmr();

    // Move to line 3.
    await session.dap.request<
      DebugProtocol.SetBreakpointsRequest,
      DebugProtocol.SetBreakpointsResponse
    >('setBreakpoints', {
      source: { path: mathPath },
      breakpoints: [{ line: 3 }],
    });

    // Click and capture the pause without auto-resuming.
    const stopped = session.dap.waitForEvent('stopped', 5000);
    await session.browser.triggerClick('[data-testid="inc"]');
    await stopped;

    const top = await getStackTopFrame();
    expect(top?.source?.path).toBe(mathPath);
    expect(top?.line).toBe(3);

    await resumeIfPaused();
  }, 30_000);

  it('HMR cycle: resolved breakpoint emits a verified=true BreakpointEvent', async () => {
    // Initial set should verify immediately (script already parsed).
    const [initial] = await setBpAt(2);
    expect(initial.verified).toBe(true);

    // Watch for the BreakpointEvent('changed') that handleHmrReload fires
    // after the new scriptParsed + resolve cycle.
    const changePromise = session.dap.waitForEvent('breakpoint', 5000);

    await triggerHmr();

    const changeEv = await changePromise;
    const body = changeEv.body as DebugProtocol.BreakpointEvent['body'];
    expect(body.reason).toBe('changed');
    expect(body.breakpoint.verified).toBe(true);
    expect(body.breakpoint.id).toBe(initial.id);
  }, 30_000);
});
