import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DebugProtocol } from '@vscode/debugprotocol';
import { E2ESession, startAttachedSession } from '../helpers/session';

/**
 * Smart-step behavior around React internals.
 *
 * Regression target: when the user pressed **stepInto** on a call that
 * landed the debugger in node_modules (React reconciler, jsx-dev-runtime,
 * setState, etc.), the adapter previously stopped inside the library
 * because `shouldSmartStep` treated a user-driven stepInto as "don't
 * second-guess". In practice that stranded the user in React and, worse,
 * caused user Components invoked from library frames to be stepped past.
 *
 * The fix: always treat node_modules as non-user code for smart-step, but
 * keep skipping with `stepInto` when the user's intent was stepInto so the
 * descent continues until user code is reached (or the smart-step limit
 * forces a safe resume).
 */
describe('Smart-step through React internals', () => {
  let session: E2ESession;
  let hookPath: string;
  let hookSrc: string;
  let isPaused = false;

  beforeAll(async () => {
    session = await startAttachedSession();
    hookPath = path.join(session.webRoot, 'src', 'hooks', 'useCanonicalData.tsx');
    hookSrc = await fs.promises.readFile(hookPath, 'utf8');

    session.dap.on('stopped', () => { isPaused = true; });
    session.dap.on('continued', () => { isPaused = false; });
  }, 120_000);

  afterAll(async () => {
    await session?.dispose();
  });

  afterEach(async () => {
    await session.dap
      .request<DebugProtocol.SetBreakpointsRequest, DebugProtocol.SetBreakpointsResponse>(
        'setBreakpoints',
        { source: { path: hookPath }, breakpoints: [] },
      )
      .catch(() => undefined);
    session.dap.clearQueue('stopped', 'continued', 'breakpoint');
    await resumeIfPaused();
  });

  async function resumeIfPaused(): Promise<void> {
    if (!isPaused) return;
    await session.dap.request('continue', { threadId: 1 }).catch(() => undefined);
    isPaused = false;
  }

  async function setBp(line: number): Promise<DebugProtocol.Breakpoint> {
    const resp = await session.dap.request<
      DebugProtocol.SetBreakpointsRequest,
      DebugProtocol.SetBreakpointsResponse
    >('setBreakpoints', {
      source: { path: hookPath },
      breakpoints: [{ line }],
    });
    return resp.body!.breakpoints[0];
  }

  async function getStackTop(): Promise<DebugProtocol.StackFrame> {
    const resp = await session.dap.request<
      DebugProtocol.StackTraceRequest,
      DebugProtocol.StackTraceResponse
    >('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
    return resp.body!.stackFrames[0];
  }

  /** Find the 1-based line number of the first line matching `needle`. */
  function lineOf(needle: string): number {
    const lines = hookSrc.split('\n');
    const idx = lines.findIndex((l) => l.includes(needle));
    if (idx < 0) throw new Error(`needle not found in useCanonicalData: ${needle}`);
    return idx + 1;
  }

  async function pauseInBump(): Promise<void> {
    // Breakpoint on the first interesting line inside the `bump` callback
    // body — `const next = versionRef.current + 1;`. The click reaches here
    // via: React event system → handleClick → bump() → this line.
    const bpLine = lineOf('const next = versionRef.current + 1');
    const bp = await setBp(bpLine);
    expect(bp.verified).toBe(true);

    session.dap.clearQueue('stopped');
    const stopped = session.dap.waitForEvent('stopped', 10_000);
    await session.browser.triggerClick('[data-testid="inc"]');
    await stopped;

    const top = await getStackTop();
    expect(top.source?.path).toBe(hookPath);
    expect(top.line).toBe(bpLine);
  }

  it('stepInto from a setState call eventually lands in user code (not stranded in React)', async () => {
    await pauseInBump();

    // Advance to the `setState(...)` call line inside bump(), then stepInto.
    const setStateLine = lineOf('setState((prev) => ({ ...prev, version: next })');
    // Move the bp so we are AT the setState call when we issue stepInto.
    // We replace the breakpoint (lifecycle regression paths are covered
    // elsewhere — here we only care about where stepping ends up).
    await session.dap.request<
      DebugProtocol.SetBreakpointsRequest,
      DebugProtocol.SetBreakpointsResponse
    >('setBreakpoints', {
      source: { path: hookPath },
      breakpoints: [{ line: setStateLine }],
    });

    // Resume until the new bp hits.
    session.dap.clearQueue('stopped');
    const atSetState = session.dap.waitForEvent('stopped', 10_000);
    await session.dap.request('continue', { threadId: 1 });
    // The user clicked already and execution is now at bump's first stmt;
    // resume runs forward through bump() until the setState bp hits on the
    // NEXT click. Trigger another click to drive execution.
    await session.browser.triggerClick('[data-testid="inc"]');
    await atSetState;

    const before = await getStackTop();
    expect(before.source?.path).toBe(hookPath);
    expect(before.line).toBe(setStateLine);

    // StepInto — Chrome descends into React's setState (node_modules).
    // With the fix, smart-step keeps stepping-into, not stepping-over, so
    // we either return to user code (next line in bump) or hit smart-step
    // limit which calls resume().
    session.dap.clearQueue('stopped');
    const afterStep = session.dap.waitForEvent('stopped', 8_000).catch(() => null);
    await session.dap.request('stepIn', { threadId: 1 });

    const ev = await afterStep;
    if (ev) {
      const top = await getStackTop();
      // Regression: old behavior stopped inside react-dom_client.js /
      // react.development.js. We must not land inside node_modules.
      expect(top.source?.path ?? '').not.toMatch(/\/node_modules\//);
    }
    // If no stopped event: smart-step limit forced resume(); that's also an
    // acceptable outcome — the user is not stranded in React, and any
    // subsequent bp would pick up the session.
  }, 60_000);

  it('stepOver on a user-code line stops at the next user-code statement', async () => {
    await pauseInBump();

    // Step over — next pause must be in user code on the next statement.
    session.dap.clearQueue('stopped');
    const stopped = session.dap.waitForEvent('stopped', 10_000);
    await session.dap.request('next', { threadId: 1 });
    const ev = await stopped;

    const top = await getStackTop();
    expect((ev.body as DebugProtocol.StoppedEvent['body']).reason).toBe('step');
    expect(top.source?.path ?? '').not.toMatch(/\/node_modules\//);
    // Should still be inside useCanonicalData.tsx or App.tsx (a caller).
    expect(top.source?.path ?? '').toMatch(/\/src\//);
  }, 30_000);

  it('stepOut from inside bump returns to the user-code caller (handleClick), not React', async () => {
    await pauseInBump();

    session.dap.clearQueue('stopped');
    const stopped = session.dap.waitForEvent('stopped', 15_000);
    await session.dap.request('stepOut', { threadId: 1 });
    const ev = await stopped;

    const top = await getStackTop();
    // Regression: previous smart-step always used stepOver for skip, so a
    // stepOut that landed in React frames would never escape. With the fix,
    // skip uses stepOut, so we climb out through library frames to the user
    // caller (App.tsx handleClick or similar).
    expect((ev.body as DebugProtocol.StoppedEvent['body']).reason).toBe('step');
    expect(top.source?.path ?? '').not.toMatch(/\/node_modules\//);
    expect(top.source?.path ?? '').toMatch(/\/src\//);
  }, 30_000);
});
