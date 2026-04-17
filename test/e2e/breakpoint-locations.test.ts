import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DebugProtocol } from '@vscode/debugprotocol';
import { E2ESession, startAttachedSession } from '../helpers/session';

/**
 * Coverage for the DAP `breakpointLocations` request and column-accurate
 * `setBreakpoints` on JSX + lambda call sites.
 *
 * App.tsx has three deliberate shapes:
 *   line 18: single-statement handler reference (regression baseline)
 *   line 19: SINGLE-LINE arrow body with multiple inner statements
 *            `<button ... onClick={() => { const n = add(...); bump(); ... }}>`
 *   lines 20-29: MULTI-LINE JSX with an inline arrow over lines 22-26
 */
describe('Breakpoint locations + JSX/lambda column accuracy', () => {
  let session: E2ESession;
  let appPath: string;
  let appSource: string;
  let isPaused = false;

  beforeAll(async () => {
    session = await startAttachedSession();
    appPath = path.join(session.webRoot, 'src', 'App.tsx');
    appSource = await fs.promises.readFile(appPath, 'utf8');

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
        { source: { path: appPath }, breakpoints: [] },
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

  async function askLocations(
    line: number,
    endLine?: number,
  ): Promise<Array<{ line: number; column?: number }>> {
    const resp = await session.dap.request<
      DebugProtocol.BreakpointLocationsRequest,
      DebugProtocol.BreakpointLocationsResponse
    >('breakpointLocations', {
      source: { path: appPath },
      line,
      endLine,
    });
    return resp.body!.breakpoints;
  }

  async function triggerClick(selector: string): Promise<void> {
    await session.browser.triggerClick(selector);
  }

  it('advertises supportsBreakpointLocationsRequest', async () => {
    // Capability is asserted once in the adapter suite; here we only depend
    // on breakpointLocations actually responding (VSCode would drop the
    // request if the capability flag were missing).
    const resp = await askLocations(19);
    expect(Array.isArray(resp)).toBe(true);
  });

  it('single-line lambda returns multiple breakpoint positions on the same line', async () => {
    // Line 19 is `<button ... onClick={() => { const n = add(...); bump(); void n; }}>`.
    // We expect at least three breakable positions on that line — one per
    // inner statement inside the arrow body.
    const locs = await askLocations(19);
    const line19 = locs.filter((l) => l.line === 19);
    expect(line19.length).toBeGreaterThanOrEqual(3);
    // All positions must live on line 19 (no overflow to 20).
    for (const l of locs) expect(l.line).toBe(19);
    // Columns must be monotonically increasing after sort (sanity).
    const cols = line19.map((l) => l.column ?? 0);
    for (let i = 1; i < cols.length; i++) {
      expect(cols[i]).toBeGreaterThanOrEqual(cols[i - 1]);
    }
  });

  it('multi-line JSX arrow returns breakable positions on each inner statement line', async () => {
    // Lines 20..29 span the multi-line <button><br>...onClick={() => { ... }}</button>.
    const locs = await askLocations(20, 29);
    const byLine = new Set(locs.map((l) => l.line));
    // The substantive inner statements are on lines 23 (`const n = add(...)`)
    // and 24 (`bump();`). Line 25 (`void n;`) is typically folded into the
    // closing brace by SWC, so we don't require it.
    expect(byLine).toContain(23);
    expect(byLine).toContain(24);
    // And positions must never leak out of the requested range.
    for (const l of locs) {
      expect(l.line).toBeGreaterThanOrEqual(20);
      expect(l.line).toBeLessThanOrEqual(29);
    }
  });

  it('setting a breakpoint inside the multi-line arrow body pauses at the right line', async () => {
    // Set bp on line 23 (`const n = add(state.version, 100);`).
    const set = await session.dap.request<
      DebugProtocol.SetBreakpointsRequest,
      DebugProtocol.SetBreakpointsResponse
    >('setBreakpoints', {
      source: { path: appPath },
      breakpoints: [{ line: 23 }],
    });
    expect(set.body!.breakpoints[0].verified).toBe(true);

    session.dap.clearQueue('stopped');
    const stopped = session.dap.waitForEvent('stopped', 6000);
    await triggerClick('[data-testid="lambda-multi"]');
    await stopped;

    const stResp = await session.dap.request<
      DebugProtocol.StackTraceRequest,
      DebugProtocol.StackTraceResponse
    >('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
    const top = stResp.body!.stackFrames[0];
    expect(top.source?.path).toBe(appPath);
    expect(top.line).toBe(23);

    await resumeIfPaused();
  }, 30_000);

  it('single-line lambda: column-specific bp pauses inside the arrow body', async () => {
    // Put the bp at the exact column of `add(` inside the arrow body on
    // line 19 — that position is well inside the lambda and cannot be
    // confused with the outer JSX declaration at column 7.
    const line19 = appSource.split('\n')[18]; // 0-based index
    const colAdd0 = line19.indexOf('add(');
    expect(colAdd0).toBeGreaterThan(0);

    // Request all valid columns on line 19 and pick the one closest to but
    // not before `add(`. This ensures we target a column the adapter/CDP
    // actually accepts — VSCode dots are snapping points, not arbitrary.
    const locs = (await askLocations(19)).filter((l) => l.line === 19);
    const inLambda = locs.find((l) => (l.column ?? 0) >= colAdd0);
    expect(inLambda, 'expected a breakable column inside the lambda body').toBeDefined();

    const set = await session.dap.request<
      DebugProtocol.SetBreakpointsRequest,
      DebugProtocol.SetBreakpointsResponse
    >('setBreakpoints', {
      source: { path: appPath },
      breakpoints: [{ line: 19, column: inLambda!.column }],
    });
    expect(set.body!.breakpoints[0].verified).toBe(true);

    session.dap.clearQueue('stopped');
    const stopped = session.dap.waitForEvent('stopped', 6000);
    await triggerClick('[data-testid="lambda-one"]');
    await stopped;

    const stResp = await session.dap.request<
      DebugProtocol.StackTraceRequest,
      DebugProtocol.StackTraceResponse
    >('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
    const top = stResp.body!.stackFrames[0];
    expect(top.source?.path).toBe(appPath);
    expect(top.line).toBe(19);
    // The pause must be inside the lambda — column should be at or after
    // where `add(` begins on that line.
    expect(top.column ?? 0).toBeGreaterThanOrEqual(colAdd0);

    await resumeIfPaused();
  }, 30_000);

  it('breakpointLocations on a line with no code returns an empty list', async () => {
    // Line 13 is a blank line inside App().
    const locs = await askLocations(13);
    expect(locs).toEqual([]);
  });
});
