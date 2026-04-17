import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DebugProtocol } from '@vscode/debugprotocol';
import { E2ESession, startAttachedSession } from '../helpers/session';
import { enableTestLogging } from '../helpers/logger';

/**
 * Scenarios specifically designed to expose the set-but-not-released bug
 * hinted at in log.txt: rapid setBreakpoints bursts interleaved with HMR
 * cycles, where the adapter's bookkeeping of cdpBreakpointId could drift
 * out of sync with Chrome's actual registered breakpoints, leaving the
 * subsequent `setBreakpoints(path, [])` unable to find an id to remove.
 *
 * The pause target is a line inside a `useCallback` body in a hook file
 * (not a trivial leaf function) so Vite's react-refresh wrapper and
 * handler-identity shuffling mirror the real-world case.
 */
describe('Breakpoint HMR leak (log.txt reproduction)', () => {
  let session: E2ESession;
  let hookPath: string;
  let originalHook: string;
  let isPaused = false;
  let hmrCounter = 0;

  // Line 98 of hooks/useCanonicalData.tsx:
  //   `    const next = versionRef.current + 1;`
  // sits inside the `bump` useCallback body and executes on every click
  // (App.handleClick → bump()).
  const HOOK_BP_LINE = 98;

  beforeAll(async () => {
    if (process.env.VITE_DEBUGGER_TEST_LOG) enableTestLogging();
    session = await startAttachedSession();
    hookPath = path.join(
      session.webRoot,
      'src',
      'hooks',
      'useCanonicalData.tsx',
    );
    originalHook = await fs.promises.readFile(hookPath, 'utf8');

    session.dap.on('stopped', () => { isPaused = true; });
    session.dap.on('continued', () => { isPaused = false; });
  }, 120_000);

  afterAll(async () => {
    if (originalHook && hookPath) {
      await fs.promises.writeFile(hookPath, originalHook).catch(() => undefined);
    }
    await session?.dispose();
  });

  afterEach(async () => {
    await clearBp().catch(() => undefined);
    session?.dap.clearQueue('stopped', 'continued', 'breakpoint');
    await resumeIfPaused();
    await fs.promises.writeFile(hookPath, originalHook).catch(() => undefined);
    await waitForHmrSettle();
  });

  async function setBp(line = HOOK_BP_LINE): Promise<DebugProtocol.Breakpoint[]> {
    const resp = await session.dap.request<
      DebugProtocol.SetBreakpointsRequest,
      DebugProtocol.SetBreakpointsResponse
    >('setBreakpoints', {
      source: { path: hookPath },
      breakpoints: [{ line }],
    });
    return resp.body!.breakpoints;
  }

  async function clearBp(): Promise<void> {
    await session.dap.request<
      DebugProtocol.SetBreakpointsRequest,
      DebugProtocol.SetBreakpointsResponse
    >('setBreakpoints', {
      source: { path: hookPath },
      breakpoints: [],
    });
  }

  async function resumeIfPaused(): Promise<void> {
    if (!isPaused) return;
    await session.dap.request('continue', { threadId: 1 }).catch(() => undefined);
    isPaused = false;
  }

  async function triggerHmr(): Promise<void> {
    hmrCounter++;
    const modified = `${originalHook}\n// hmr-${hmrCounter}-${Date.now()}\n`;
    await fs.promises.writeFile(hookPath, modified);
    await waitForHmrSettle();
  }

  async function waitForHmrSettle(): Promise<void> {
    // Vite debounces watch (~50ms) + adapter HMR batch (100ms) + actual
    // re-resolve work. 900ms is generous but keeps the suite well-paced.
    await new Promise((r) => setTimeout(r, 900));
  }

  async function clickAndCheckPause(windowMs = 3000): Promise<
    { paused: true; event: DebugProtocol.Event } | { paused: false }
  > {
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

  it('sanity: breakpoint inside the hook callback fires on click', async () => {
    const [bp] = await setBp();
    expect(bp.verified).toBe(true);
    const hit = await clickAndCheckPause();
    expect(hit.paused).toBe(true);
  }, 30_000);

  it('set → HMR → set (interleaved) → clear → no pause', async () => {
    await setBp();
    await triggerHmr();
    await setBp(); // VSCode's on-save re-set, now against the HMR-replaced script
    await clearBp();
    const after = await clickAndCheckPause();
    expect(after.paused).toBe(false);
  }, 30_000);

  it('set → HMR → set → HMR → set → clear → no pause (the log.txt burst)', async () => {
    await setBp();
    await triggerHmr();
    await setBp();
    await triggerHmr();
    await setBp();
    // Give any in-flight HMR batch handlers a moment to settle before clear.
    await new Promise((r) => setTimeout(r, 200));
    await clearBp();
    const after = await clickAndCheckPause();
    expect(after.paused).toBe(false);
  }, 45_000);

  it('set → multiple HMR in quick succession → clear → no pause', async () => {
    await setBp();
    // Rapid HMR bursts that pile up inside the adapter's batch window.
    await fs.promises.writeFile(hookPath, `${originalHook}\n// burst-1\n`);
    await new Promise((r) => setTimeout(r, 80));
    await fs.promises.writeFile(hookPath, `${originalHook}\n// burst-2\n`);
    await new Promise((r) => setTimeout(r, 80));
    await fs.promises.writeFile(hookPath, `${originalHook}\n// burst-3\n`);
    // Let the last HMR + adapter batch finish.
    await waitForHmrSettle();

    await clearBp();
    const after = await clickAndCheckPause();
    expect(after.paused).toBe(false);
  }, 45_000);

  it('rapid setBreakpoints DURING an HMR batch window → clear → no pause', async () => {
    await setBp();
    // Kick off HMR but don't wait for the batch to flush (100ms timer).
    hmrCounter++;
    await fs.promises.writeFile(
      hookPath,
      `${originalHook}\n// hmr-race-${hmrCounter}-${Date.now()}\n`,
    );
    // Call setBreakpoints again BEFORE the batch timer fires (<100ms).
    await new Promise((r) => setTimeout(r, 30));
    await setBp();
    await new Promise((r) => setTimeout(r, 30));
    await setBp();
    // Now let everything settle.
    await waitForHmrSettle();

    await clearBp();
    const after = await clickAndCheckPause();
    expect(after.paused).toBe(false);
  }, 45_000);

  it('HMR → clear → set-again → HMR → clear → no pause (re-enable/disable cycle)', async () => {
    await setBp();
    await triggerHmr();
    await clearBp();

    // First clear should already prevent pause. If it doesn't, the rest of
    // the cycle becomes irrelevant — fail fast.
    const afterFirstClear = await clickAndCheckPause();
    expect(afterFirstClear.paused).toBe(false);

    await setBp();
    await triggerHmr();
    await clearBp();

    const afterSecondClear = await clickAndCheckPause();
    expect(afterSecondClear.paused).toBe(false);
  }, 45_000);

  it('stress: 10 cycles of (set → HMR → set → HMR → clear) with variable delays never leaves a stale bp', async () => {
    // Probabilistic test: if there's a timing window where setBreakpoints
    // runs concurrently with handleHmrReload and leaks a CDP breakpoint,
    // hitting that window N times dramatically increases the chance of a
    // click pausing on a "ghost" breakpoint.
    for (let i = 0; i < 10; i++) {
      await setBp();
      // Start HMR. Delay varies across cycles to cover different points
      // relative to the adapter's 100ms HMR batch timer.
      const delayMs = 20 + ((i * 23) % 120); // 20..140ms
      hmrCounter++;
      await fs.promises.writeFile(
        hookPath,
        `${originalHook}\n// stress-${i}-${hmrCounter}-${Date.now()}\n`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
      await setBp();
      // Second HMR in the same cycle.
      hmrCounter++;
      await fs.promises.writeFile(
        hookPath,
        `${originalHook}\n// stress-${i}b-${hmrCounter}-${Date.now()}\n`,
      );
      await new Promise((r) => setTimeout(r, 40 + ((i * 17) % 80)));

      await clearBp();
      // Let any in-flight HMR batch finish so we test the final state.
      await waitForHmrSettle();

      const after = await clickAndCheckPause(1500);
      if (after.paused) {
        throw new Error(
          `stale breakpoint leak detected on iteration ${i} (click paused ` +
            `after clear). This reproduces the log.txt regression.`,
        );
      }
    }
  }, 180_000);

  it('concurrent setBreakpoints bursts bracketing an HMR cycle', async () => {
    // Fire an HMR trigger and then fire THREE setBreakpoints calls without
    // awaiting between them, so all three requests are outstanding when
    // the adapter's HMR batch timer fires.
    await setBp();
    hmrCounter++;
    await fs.promises.writeFile(
      hookPath,
      `${originalHook}\n// concurrent-${hmrCounter}-${Date.now()}\n`,
    );

    // Kick off three setBreakpoints calls concurrently. Each DAP request
    // enters the adapter via handleMessage and runs its async handler;
    // multiple handlers end up interleaved inside the manager.
    const burst = Promise.all([setBp(), setBp(), setBp()]);
    // And AFTER a brief pause, fire a clear — so the clear's
    // removeBreakpointsForSource overlaps with whichever set is last to
    // arrive + the HMR batch's own remove/set pair.
    await new Promise((r) => setTimeout(r, 50));
    const clearPromise = clearBp();

    await Promise.allSettled([burst, clearPromise]);
    await waitForHmrSettle();

    // Final state should be "cleared": no pause on click.
    const after = await clickAndCheckPause(2000);
    expect(after.paused).toBe(false);
  }, 45_000);
});
