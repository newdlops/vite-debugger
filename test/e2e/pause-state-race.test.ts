import { DebugProtocol } from '@vscode/debugprotocol';
import { describe, expect, it, vi } from 'vitest';
import { ViteDebugSession } from '../../src/adapter/ViteDebugSession';
import type { CdpClient, PausedEvent } from '../../src/cdp/CdpClient';
import type { CallFrame } from '../../src/cdp/CdpTypes';
import type { CallStackManager, ResolvedCallFrame } from '../../src/inspection/CallStackManager';
import type { SourceMapResolver } from '../../src/sourcemap/SourceMapResolver';
import type { ViteUrlMapper } from '../../src/vite/ViteUrlMapper';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

interface PausedTargetFixture {
  targetId: string;
  sessionId?: string;
  pauseEpoch: number;
  reason: string;
  pausedEvent: PausedEvent;
  resolvedFrames: ResolvedCallFrame[];
  callStackManager: CallStackManager | null;
}

interface SessionInternals {
  cdp: CdpClient | null;
  sourceMapResolver: SourceMapResolver | null;
  urlMapper: ViteUrlMapper | null;
  pauseEpoch: number;
  paused: boolean;
  resolvedFrames: ResolvedCallFrame[];
  callStackManager: CallStackManager | null;
  mcpPausedTargets: Map<string, PausedTargetFixture>;
  requestedPauseTargets: Set<string>;
  onPaused(params: PausedEvent, sessionId?: string): Promise<void>;
  onResumed(sessionId?: string): void;
  ensureTopFrameSourceMap(params: PausedEvent): Promise<void>;
  shouldSmartStep(params: PausedEvent, explicitBreakpoint: boolean): Promise<boolean>;
  detectReactComponent(frame: CallFrame): Promise<void>;
  sendEvent(event: DebugProtocol.Event): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function callFrame(functionName: string, scriptId: string): CallFrame {
  return {
    callFrameId: `frame-${scriptId}`,
    functionName,
    location: { scriptId, lineNumber: 0, columnNumber: 0 },
    url: `http://127.0.0.1:5173/${scriptId}.ts`,
    scopeChain: [],
    this: { type: 'object' },
  };
}

function pausedEvent(functionName: string, scriptId: string): PausedEvent {
  return {
    callFrames: [callFrame(functionName, scriptId)],
    reason: 'breakpoint',
    hitBreakpoints: ['breakpoint-1'],
  };
}

function resolvedFrame(functionName: string, scriptId: string): ResolvedCallFrame {
  const cdpCallFrame = callFrame(functionName, scriptId);
  return {
    cdpCallFrame,
    scriptId,
    dapFrame: {
      id: 1,
      name: functionName,
      source: { name: `${scriptId}.ts` },
      line: 1,
      column: 1,
    },
  };
}

function makeSession(
  targetForSession: (sessionId?: string) => string | undefined,
  generatedToOriginal: SourceMapResolver['generatedToOriginal'],
): { internal: SessionInternals; events: DebugProtocol.Event[] } {
  const internal = new ViteDebugSession() as unknown as SessionInternals;
  const events: DebugProtocol.Event[] = [];

  internal.cdp = {
    activeTargetId: 'target-a',
    targetIdForSession: targetForSession,
  } as unknown as CdpClient;
  internal.sourceMapResolver = { generatedToOriginal } as unknown as SourceMapResolver;
  internal.urlMapper = {
    viteUrlToFilePath: vi.fn(() => null),
  } as unknown as ViteUrlMapper;
  internal.ensureTopFrameSourceMap = vi.fn(async () => undefined);
  internal.shouldSmartStep = vi.fn(async () => false);
  internal.sendEvent = (event): void => {
    events.push(event);
  };

  return { internal, events };
}

describe('ViteDebugSession pause publication race', () => {
  it('does not overwrite another visible pause when a target resumes during frame resolution', async () => {
    const frameResolutionStarted = deferred<void>();
    const releaseFrameResolution = deferred<void>();
    let resolvingFrames = false;
    const generatedToOriginal = vi.fn(async () => {
      if (resolvingFrames) {
        frameResolutionStarted.resolve();
        await releaseFrameResolution.promise;
      }
      return null;
    });
    const { internal, events } = makeSession(
      (sessionId) => sessionId === 'session-a' ? 'target-a' : 'target-b',
      generatedToOriginal,
    );
    // onPaused performs its diagnostic mapping before this handshake and its
    // CallStackManager mapping after it, so the gate cannot depend on an
    // implementation-specific call count.
    internal.ensureTopFrameSourceMap = vi.fn(async () => {
      resolvingFrames = true;
    });

    const remainingEvent = pausedEvent('remainingPause', 'remaining-script');
    const remainingFrames = [resolvedFrame('remainingPause', 'remaining-script')];
    const remainingManager = {} as CallStackManager;
    internal.mcpPausedTargets.set('target-b', {
      targetId: 'target-b',
      sessionId: 'session-b',
      pauseEpoch: 0,
      reason: 'breakpoint',
      pausedEvent: remainingEvent,
      resolvedFrames: remainingFrames,
      callStackManager: remainingManager,
    });

    const stalePause = internal.onPaused(pausedEvent('stalePause', 'stale-script'), 'session-a');
    await frameResolutionStarted.promise;

    // Resume reconciles the synthetic DAP thread back to target-b while the
    // old target-a handler is still awaiting source/frame work.
    internal.onResumed('session-a');
    releaseFrameResolution.resolve();
    await stalePause;

    expect(internal.resolvedFrames).toBe(remainingFrames);
    expect(internal.callStackManager).toBe(remainingManager);
    expect([...internal.mcpPausedTargets.keys()]).toEqual(['target-b']);
    expect(events.filter((event) => event.event === 'stopped')).toHaveLength(0);
  });

  it('emits only the newer stop when the same target pauses again during enrichment', async () => {
    const firstEnrichmentStarted = deferred<void>();
    const releaseFirstEnrichment = deferred<void>();
    const { internal, events } = makeSession(
      () => 'target-a',
      vi.fn(async () => null),
    );
    let enrichmentCalls = 0;
    internal.detectReactComponent = vi.fn(async () => {
      enrichmentCalls++;
      if (enrichmentCalls === 1) {
        firstEnrichmentStarted.resolve();
        await releaseFirstEnrichment.promise;
      }
    });

    const oldPause = internal.onPaused(pausedEvent('oldPause', 'old-script'), 'session-a');
    await firstEnrichmentStarted.promise;

    // This replaces the map entry for the same target with a new identity and
    // epoch while the first handler is still awaiting React enrichment.
    await internal.onPaused(pausedEvent('newPause', 'new-script'), 'session-a');
    releaseFirstEnrichment.resolve();
    await oldPause;

    const stoppedEvents = events.filter((event) => event.event === 'stopped');
    expect(stoppedEvents).toHaveLength(1);
    expect(internal.pauseEpoch).toBe(2);
    expect(internal.mcpPausedTargets.get('target-a')?.pauseEpoch).toBe(2);
    expect(internal.resolvedFrames[0]?.dapFrame.name).toBe('newPause');
  });

  it('classifies a requested pause as pause even when Chrome reports reason other', async () => {
    const { internal, events } = makeSession(
      () => 'target-a',
      vi.fn(async () => null),
    );
    internal.requestedPauseTargets.add('target-a');

    await internal.onPaused(pausedEvent('manualPause', 'manual-script'), 'session-a');

    const stopped = events.find((event) => event.event === 'stopped');
    expect((stopped?.body as DebugProtocol.StoppedEvent['body'] | undefined)?.reason).toBe('pause');
    expect(internal.requestedPauseTargets.has('target-a')).toBe(false);
  });
});
