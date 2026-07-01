import { EventEmitter } from 'events';
import * as http from 'http';
import CDP from 'chrome-remote-interface';
import {
  CallFrame,
  RemoteObject,
  PropertyDescriptor,
  ExceptionDetails,
  CallArgument,
  ConsoleAPICalledEvent,
  BreakLocation,
  FetchRequestPausedEvent,
  RequestPattern,
} from './CdpTypes';
import { logger } from '../util/Logger';
import { hostsEquivalent } from '../util/LocalHosts';

export interface ScriptParsedEvent {
  scriptId: string;
  url: string;
  sourceMapURL?: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  hash: string;
}

export interface PausedEvent {
  callFrames: CallFrame[];
  reason: string;
  hitBreakpoints?: string[];
  data?: object;
}

export interface CdpBreakpointLocation {
  breakpointId: string;
  locations: Array<{ scriptId: string; lineNumber: number; columnNumber: number }>;
}

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
}

/**
 * Separator for globally-unique script ids. CDP numbers scripts PER SESSION, so
 * the raw scriptId "16" means different files in different tabs. We prefix the
 * sessionId to make the id unique across tabs everywhere downstream (source-map
 * resolver, script->url maps). Session ids are hex and raw script ids are
 * numeric, so neither contains '|'.
 */
const SCRIPT_ID_SEP = '|';

/** A URL-keyed breakpoint that must be installed in every attached page. */
interface UrlBreakpointSpec {
  lineNumber: number;
  url?: string;
  urlRegex?: string;
  columnNumber?: number;
  condition?: string;
}

/**
 * Browser-level CDP client that attaches to EVERY Chrome tab (target) serving
 * the Vite app, not just one.
 *
 * Why this exists: Chrome models each tab as a separate CDP target with its own
 * V8 isolate. `Debugger.setBreakpointByUrl` only installs a breakpoint in the
 * target it is sent to — even with a `urlRegex` it does not cross the tab
 * boundary. The previous design connected to a single tab (the first one whose
 * URL matched), so a breakpoint never fired if the code ran in any other tab,
 * or in a tab opened after attach. That's the "breakpoints don't hit with
 * multiple tabs" bug.
 *
 * The fix: connect to the *browser* endpoint and use flatten-mode auto-attach
 * (`Target.setAutoAttach`). Every matching page target becomes a CDP *session*
 * (identified by `sessionId`) multiplexed over the single browser WebSocket.
 * This class then routes each operation to the right session(s):
 *
 *   - Breakpoints / blackbox / pause-on-exceptions are *fanned out* to all
 *     sessions and *replayed* into any tab that attaches later, so a breakpoint
 *     is live in every tab regardless of which one runs the code.
 *   - Pause-time operations (stepping, evaluate, scopes, variables) route to the
 *     *active* session — the tab that is currently paused.
 *   - scriptId / requestId-scoped operations route to the session that owns that
 *     id.
 *
 * To consumers (BreakpointManager, VariableManager, etc.) the public method
 * signatures are unchanged — the multi-session routing is entirely internal.
 * `setBreakpointByUrl` returns a synthetic handle (used as `breakpointId`) that
 * stands in for the per-session breakpoint ids; `removeBreakpoint(handle)`
 * tears them all down.
 *
 * The connect/enable ordering note from the old single-target client still
 * applies: `connect()` wires the event bridge but enables nothing; the consumer
 * must attach its `.on('scriptParsed' | 'paused' | …)` listeners before calling
 * `enableDomains()`, because enabling a session's Debugger domain replays every
 * already-parsed script through this emitter.
 */
export class CdpClient extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;

  /** Vite URL used to decide which tabs (targets) we manage. */
  private targetUrlFilter?: string;

  /** Managed page sessions: sessionId -> target info. */
  private sessions = new Map<string, TargetInfo>();
  /** Every attached session (incl. not-yet-matching), to catch navigations. */
  private allSessions = new Map<string, TargetInfo>();
  /** The tab currently paused — pause-time ops route here. */
  private activeSessionId?: string;
  /** First matching page session — default for ops when nothing is paused. */
  private primarySessionId?: string;

  /** Fetch requestId -> session it paused in. */
  private fetchRequestOwners = new Map<string, string>();

  /** Fan-out URL breakpoints. handle -> spec, handle -> (sessionId -> cdp id). */
  private urlBreakpoints = new Map<string, UrlBreakpointSpec>();
  private urlBreakpointIds = new Map<string, Map<string, string>>();
  private nextBpHandle = 1;
  /** Location-based (scriptId) breakpoints -> the session they live in. */
  private rawBreakpointSessions = new Map<string, string>();

  /** Desired global state, (re)applied to every session as it attaches. */
  private desiredBlackboxPatterns: string[] = [];
  private desiredPauseOnExceptions: 'none' | 'uncaught' | 'all' = 'none';
  private desiredBreakpointsActive = true;
  private fetchPatterns: RequestPattern[] = [{ requestStage: 'Request' } as RequestPattern];

  private autoAttachStarted = false;

  private constructor() {
    super();
  }

  /**
   * Connect to the browser-level CDP endpoint (NOT a single page) and wire the
   * bridge from raw CDP events to this EventEmitter. No domain is enabled and no
   * target is attached yet — that happens in `enableDomains()`.
   *
   * The consumer MUST attach its `.on(…)` listeners before calling
   * `enableDomains()`: enabling a session's Debugger domain replays every
   * already-parsed script via `Debugger.scriptParsed`, and those replays fan out
   * through this emitter. A listener registered after enable would miss them,
   * which manifests as "re-attach against an already-loaded page shows no
   * scripts and breakpoints never bind without a manual reload."
   */
  static async connect(port: number, targetUrl?: string): Promise<CdpClient> {
    const cdpClient = new CdpClient();
    cdpClient.targetUrlFilter = targetUrl;

    // Connect to the browser target so we can see and attach to ALL tabs.
    const browserWsUrl = await getBrowserWebSocketUrl(port);
    const client = await CDP({ target: browserWsUrl });
    cdpClient.client = client;

    cdpClient.wireEventBridge();

    logger.info(`CDP connected to browser on port ${port}`);
    return cdpClient;
  }

  /**
   * Bridge raw CDP events (which, in flatten mode, all arrive on the single
   * browser connection tagged with a `sessionId`) to this EventEmitter. We
   * stamp internal routing state (active session, script/request owners) here,
   * BEFORE re-emitting, so consumer handlers can issue follow-up CDP calls that
   * implicitly route to the correct session.
   */
  private wireEventBridge(): void {
    const client = this.client;

    // --- Target lifecycle (tabs opening / navigating / closing) ---
    client.Target.attachedToTarget((params: { sessionId: string; targetInfo: TargetInfo; waitingForDebugger?: boolean }) => {
      this.onAttachedToTarget(params).catch((e) => {
        logger.warn(`Failed to set up attached target: ${e}`);
      });
    });
    client.Target.detachedFromTarget((params: { sessionId: string }) => {
      this.onDetachedFromTarget(params.sessionId);
    });
    client.Target.targetInfoChanged((params: { targetInfo: TargetInfo }) => {
      this.onTargetInfoChanged(params.targetInfo).catch((e) => {
        logger.debug(`targetInfoChanged handling failed: ${e}`);
      });
    });

    // --- Debugger / Runtime / Fetch (per-session, tagged with sessionId) ---
    client.Debugger.scriptParsed((params: ScriptParsedEvent, sessionId?: string) => {
      // Globalize the scriptId so the same file in two tabs doesn't collide on
      // the per-session raw id.
      this.emit('scriptParsed', { ...params, scriptId: this.toGlobalScriptId(params.scriptId, sessionId) }, sessionId);
    });

    client.Debugger.paused((params: PausedEvent, sessionId?: string) => {
      // The paused tab becomes the active session: its call frames, scopes and
      // object ids are only valid against this session.
      if (sessionId) this.activeSessionId = sessionId;
      this.emit('paused', this.globalizePausedEvent(params, sessionId), sessionId);
    });

    client.Debugger.resumed((_params: unknown, sessionId?: string) => {
      this.emit('resumed', sessionId);
    });

    client.Runtime.exceptionThrown((params: { exceptionDetails: ExceptionDetails }, sessionId?: string) => {
      this.emit('exceptionThrown', params.exceptionDetails, sessionId);
    });

    client.Runtime.consoleAPICalled((params: ConsoleAPICalledEvent, sessionId?: string) => {
      this.emit('consoleAPICalled', params, sessionId);
    });

    client.Fetch.requestPaused((params: FetchRequestPausedEvent, sessionId?: string) => {
      if (sessionId) this.fetchRequestOwners.set(params.requestId, sessionId);
      this.emit('requestPaused', params, sessionId);
    });

    client.on('disconnect', () => {
      this.emit('disconnected');
    });
  }

  /**
   * Start auto-attaching to all tabs. Named `enableDomains` for compatibility
   * with the old single-target client: the consumer calls it after wiring
   * listeners. Domains are enabled per-session inside `setupSession` as each tab
   * attaches (and is replayed into tabs that attach later).
   */
  async enableDomains(): Promise<void> {
    if (this.autoAttachStarted) return;
    this.autoAttachStarted = true;

    // Discover existing targets (so targetInfoChanged fires for tabs that later
    // navigate INTO the app) and auto-attach to current + future page targets.
    // flatten:true multiplexes every session over this one browser connection.
    await this.client.Target.setDiscoverTargets({ discover: true });
    await this.client.Target.setAutoAttach({
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Target / session lifecycle
  // ---------------------------------------------------------------------------

  private async onAttachedToTarget(params: {
    sessionId: string;
    targetInfo: TargetInfo;
    waitingForDebugger?: boolean;
  }): Promise<void> {
    const { sessionId, targetInfo } = params;
    this.allSessions.set(sessionId, targetInfo);

    // Only debug page tabs that serve the Vite app. Non-page targets (workers,
    // service workers, etc.) and unrelated tabs are left alone — but if they
    // were paused waiting for the debugger, let them run so we don't hang them.
    if (targetInfo.type !== 'page' || !this.urlMatches(targetInfo.url)) {
      if (params.waitingForDebugger) {
        await this.runIfWaitingForDebugger(sessionId);
      }
      return;
    }

    await this.manageSession(sessionId, targetInfo, params.waitingForDebugger);
  }

  private async onTargetInfoChanged(targetInfo: TargetInfo): Promise<void> {
    // A tab we'd skipped (e.g. about:blank, or a different site) may have
    // navigated into the Vite app. Find its session and start managing it.
    if (targetInfo.type !== 'page' || !this.urlMatches(targetInfo.url)) return;
    for (const [sessionId, info] of this.allSessions) {
      if (info.targetId === targetInfo.targetId) {
        this.allSessions.set(sessionId, targetInfo);
        if (!this.sessions.has(sessionId)) {
          await this.manageSession(sessionId, targetInfo, false);
        }
        return;
      }
    }
  }

  /** Bring a matching page session under management: enable domains, apply
   *  desired state, and install every known breakpoint. */
  private async manageSession(
    sessionId: string,
    targetInfo: TargetInfo,
    waitingForDebugger?: boolean,
  ): Promise<void> {
    if (this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, targetInfo);
    if (!this.primarySessionId) this.primarySessionId = sessionId;

    await this.setupSession(sessionId);

    // We attach with waitForDebuggerOnStart:false, but honor the flag defensively
    // in case Chrome paused the target — never leave a tab hung.
    if (waitingForDebugger) {
      await this.runIfWaitingForDebugger(sessionId);
    }

    logger.info(`Attached to Vite tab (session ${sessionId}): ${targetInfo.url}`);
    this.emit('targetAttached', sessionId, targetInfo);
  }

  private async setupSession(sessionId: string): Promise<void> {
    const client = this.client;

    // Enabling Debugger replays this session's already-parsed scripts through
    // the bridge (with this sessionId) — that's how a newly attached tab's
    // sources and source maps get registered.
    await Promise.all([
      client.Debugger.enable({}, sessionId),
      client.Runtime.enable({}, sessionId),
      client.Page.enable({}, sessionId),
      client.Fetch.enable({ patterns: this.fetchPatterns }, sessionId),
    ]);

    // Apply the desired global debugger state to this fresh session.
    if (this.desiredBlackboxPatterns.length > 0) {
      await client.Debugger.setBlackboxPatterns({ patterns: this.desiredBlackboxPatterns }, sessionId)
        .catch((e: unknown) => logger.debug(`setBlackboxPatterns on ${sessionId} failed: ${e}`));
    }
    await client.Debugger.setPauseOnExceptions({ state: this.desiredPauseOnExceptions }, sessionId)
      .catch((e: unknown) => logger.debug(`setPauseOnExceptions on ${sessionId} failed: ${e}`));
    if (!this.desiredBreakpointsActive) {
      await client.Debugger.setBreakpointsActive({ active: false }, sessionId)
        .catch((e: unknown) => logger.debug(`setBreakpointsActive on ${sessionId} failed: ${e}`));
    }

    // Install every URL breakpoint into this tab so it fires here too.
    await Promise.all([...this.urlBreakpoints].map(async ([handle, spec]) => {
      try {
        const result = await client.Debugger.setBreakpointByUrl({
          lineNumber: spec.lineNumber,
          url: spec.url,
          urlRegex: spec.urlRegex,
          columnNumber: spec.columnNumber,
          condition: spec.condition,
        }, sessionId);
        this.recordBreakpointId(handle, sessionId, result.breakpointId);
      } catch (e) {
        logger.debug(`Replaying breakpoint ${handle} into session ${sessionId} failed: ${e}`);
      }
    }));
  }

  private onDetachedFromTarget(sessionId: string): void {
    this.allSessions.delete(sessionId);
    const wasManaged = this.sessions.delete(sessionId);

    // Drop this session's per-breakpoint ids.
    for (const ids of this.urlBreakpointIds.values()) {
      ids.delete(sessionId);
    }
    for (const [bpId, sid] of [...this.rawBreakpointSessions]) {
      if (sid === sessionId) this.rawBreakpointSessions.delete(bpId);
    }
    for (const [reqId, sid] of [...this.fetchRequestOwners]) {
      if (sid === sessionId) this.fetchRequestOwners.delete(reqId);
    }

    if (this.activeSessionId === sessionId) this.activeSessionId = undefined;
    if (this.primarySessionId === sessionId) {
      this.primarySessionId = this.sessions.keys().next().value as string | undefined;
    }

    if (wasManaged) {
      logger.info(`Vite tab detached (session ${sessionId})`);
      this.emit('targetDetached', sessionId);
    }
  }

  private async runIfWaitingForDebugger(sessionId: string): Promise<void> {
    try {
      await this.client.Runtime.runIfWaitingForDebugger({}, sessionId);
    } catch {
      // Target wasn't waiting (the common case with waitForDebuggerOnStart:false).
    }
  }

  private urlMatches(url: string): boolean {
    const filter = this.targetUrlFilter;
    if (!filter) return true;
    if (!url) return false;
    if (url.startsWith(filter)) return true;
    try {
      const a = new URL(url);
      const b = new URL(filter);
      return hostsEquivalent(a.hostname, b.hostname) && a.port === b.port;
    } catch {
      return false;
    }
  }

  /** Number of Vite tabs currently being debugged. */
  get attachedTabCount(): number {
    return this.sessions.size;
  }

  // ---------------------------------------------------------------------------
  // Session routing helpers
  // ---------------------------------------------------------------------------

  /** Session for pause-time ops (stepping, evaluate, scopes, variables). */
  private requireActiveSession(): string {
    const sessionId = this.activeSessionId ?? this.primarySessionId;
    if (!sessionId) {
      throw new Error('No attached Chrome tab available for this operation');
    }
    return sessionId;
  }

  /** Tag a raw (per-session) scriptId with its session to make it globally unique. */
  private toGlobalScriptId(rawScriptId: string, sessionId?: string): string {
    return sessionId ? `${sessionId}${SCRIPT_ID_SEP}${rawScriptId}` : rawScriptId;
  }

  /** Split a global scriptId back into its session and raw scriptId. */
  private fromGlobalScriptId(scriptId: string): { sessionId?: string; rawScriptId: string } {
    const i = scriptId.indexOf(SCRIPT_ID_SEP);
    if (i < 0) return { rawScriptId: scriptId };
    return { sessionId: scriptId.slice(0, i), rawScriptId: scriptId.slice(i + 1) };
  }

  /** Route a scriptId-scoped command to the session that owns the script. */
  private routeScript(scriptId: string): { sessionId: string; rawScriptId: string } {
    const { sessionId, rawScriptId } = this.fromGlobalScriptId(scriptId);
    return { sessionId: sessionId ?? this.requireActiveSession(), rawScriptId };
  }

  /** Rewrite script ids and URL-breakpoint ids to adapter-level ids. */
  private globalizePausedEvent(params: PausedEvent, sessionId?: string): PausedEvent {
    if (!sessionId) return params;
    return {
      ...params,
      hitBreakpoints: params.hitBreakpoints?.map((breakpointId) =>
        this.toUrlBreakpointHandle(breakpointId, sessionId) ?? breakpointId
      ),
      callFrames: params.callFrames.map((frame) => ({
        ...frame,
        location: {
          ...frame.location,
          scriptId: this.toGlobalScriptId(frame.location.scriptId, sessionId),
        },
      })),
    };
  }

  private toUrlBreakpointHandle(cdpBreakpointId: string, sessionId: string): string | undefined {
    for (const [handle, ids] of this.urlBreakpointIds) {
      if (ids.get(sessionId) === cdpBreakpointId) return handle;
    }
    return undefined;
  }

  private recordBreakpointId(handle: string, sessionId: string, cdpBreakpointId: string): void {
    let ids = this.urlBreakpointIds.get(handle);
    if (!ids) {
      ids = new Map();
      this.urlBreakpointIds.set(handle, ids);
    }
    ids.set(sessionId, cdpBreakpointId);
  }

  // --- Debugger Domain ---

  /**
   * Install a URL-keyed breakpoint in EVERY attached tab, and remember it so it
   * is replayed into tabs that attach later. Returns a synthetic handle used as
   * the `breakpointId`; pass it to `removeBreakpoint` to tear down all per-tab
   * breakpoints at once. The reported `locations` come from the first tab that
   * bound it (all tabs serve identical code from the same Vite URL, so the
   * bound position is the same).
   */
  async setBreakpointByUrl(
    lineNumber: number,
    options: { url?: string; urlRegex?: string; columnNumber?: number; condition?: string } = {}
  ): Promise<CdpBreakpointLocation> {
    const handle = `vbp-${this.nextBpHandle++}`;
    const spec: UrlBreakpointSpec = {
      lineNumber,
      url: options.url,
      urlRegex: options.urlRegex,
      columnNumber: options.columnNumber,
      condition: options.condition,
    };
    this.urlBreakpoints.set(handle, spec);
    this.urlBreakpointIds.set(handle, new Map());

    let locations: Array<{ scriptId: string; lineNumber: number; columnNumber?: number }> = [];
    let locationsSession: string | undefined;
    await Promise.all([...this.sessions.keys()].map(async (sessionId) => {
      try {
        const result = await this.client.Debugger.setBreakpointByUrl({
          lineNumber,
          url: options.url,
          urlRegex: options.urlRegex,
          columnNumber: options.columnNumber,
          condition: options.condition,
        }, sessionId);
        this.recordBreakpointId(handle, sessionId, result.breakpointId);
        if (locations.length === 0 && result.locations.length > 0) {
          locations = result.locations;
          locationsSession = sessionId;
        }
      } catch (e) {
        logger.debug(`setBreakpointByUrl in session ${sessionId} failed: ${e}`);
      }
    }));

    // Surface whether Chrome actually bound the bp to a real script. If
    // `locations` is empty the regex didn't match anything currently loaded
    // (in any tab), so the bp won't fire until a future scriptParsed (e.g., HMR
    // or navigation) brings in a matching script. This is the diagnostic for
    // "bp set but never hits without refresh" reports.
    if (locations.length === 0) {
      logger.warn(
        `setBreakpointByUrl returned 0 bound locations: line=${lineNumber} ` +
        `col=${options.columnNumber} urlRegex=${options.urlRegex} (${this.sessions.size} tab(s)) — ` +
        `bp will wait for a matching script to be parsed`
      );
    } else {
      logger.debug(
        `setBreakpointByUrl bound to ${locations.length} location(s) across ${this.sessions.size} tab(s): ` +
        locations.map((l) => `${l.scriptId}:${l.lineNumber}:${l.columnNumber ?? 0}`).join(', ')
      );
    }

    return {
      breakpointId: handle,
      locations: locations.map((loc) => ({
        scriptId: this.toGlobalScriptId(loc.scriptId, locationsSession),
        lineNumber: loc.lineNumber,
        columnNumber: loc.columnNumber ?? 0,
      })),
    };
  }

  /**
   * Remove a breakpoint by the id returned from `setBreakpointByUrl` (a
   * fan-out handle) or `setBreakpoint` (a single-session location bp).
   */
  async removeBreakpoint(breakpointId: string): Promise<void> {
    const fannedOut = this.urlBreakpointIds.get(breakpointId);
    if (fannedOut) {
      this.urlBreakpoints.delete(breakpointId);
      this.urlBreakpointIds.delete(breakpointId);
      await Promise.all([...fannedOut].map(async ([sessionId, cdpId]) => {
        try {
          await this.client.Debugger.removeBreakpoint({ breakpointId: cdpId }, sessionId);
        } catch (e) {
          logger.debug(`removeBreakpoint ${cdpId} in session ${sessionId} failed: ${e}`);
        }
      }));
      return;
    }

    // Location-based (scriptId) breakpoint living in a single session.
    const sessionId = this.rawBreakpointSessions.get(breakpointId) ?? this.activeSessionId ?? this.primarySessionId;
    this.rawBreakpointSessions.delete(breakpointId);
    if (sessionId) {
      await this.client.Debugger.removeBreakpoint({ breakpointId }, sessionId);
    }
  }

  async resume(): Promise<void> {
    await this.client.Debugger.resume({}, this.requireActiveSession());
  }

  async stepOver(): Promise<void> {
    await this.client.Debugger.stepOver({}, this.requireActiveSession());
  }

  async stepInto(): Promise<void> {
    await this.client.Debugger.stepInto({}, this.requireActiveSession());
  }

  async stepOut(): Promise<void> {
    await this.client.Debugger.stepOut({}, this.requireActiveSession());
  }

  async pause(): Promise<void> {
    await this.client.Debugger.pause({}, this.requireActiveSession());
  }

  async getScriptSource(scriptId: string): Promise<string> {
    const { sessionId, rawScriptId } = this.routeScript(scriptId);
    const result = await this.client.Debugger.getScriptSource({ scriptId: rawScriptId }, sessionId);
    return result.scriptSource;
  }

  async evaluateOnCallFrame(callFrameId: string, expression: string, silent: boolean = false): Promise<RemoteObject> {
    const result = await this.client.Debugger.evaluateOnCallFrame({
      callFrameId,
      expression,
      silent,
      returnByValue: false,
      generatePreview: true,
    }, this.requireActiveSession());
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Evaluation failed');
    }
    return result.result;
  }

  /**
   * Evaluate an expression in the paused frame's scope and return its value
   * by value. Unlike `Runtime.evaluate` with `awaitPromise: true`, this
   * cannot hang while the debugger is paused — `Debugger.evaluateOnCallFrame`
   * doesn't wait on promises.
   */
  async evaluateOnCallFrameForValue<T = unknown>(callFrameId: string, expression: string): Promise<T | undefined> {
    const result = await this.client.Debugger.evaluateOnCallFrame({
      callFrameId,
      expression,
      silent: true,
      returnByValue: true,
      generatePreview: false,
    }, this.requireActiveSession());
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Evaluation failed');
    }
    return result.result?.value as T | undefined;
  }

  async setBlackboxPatterns(patterns: string[]): Promise<void> {
    this.desiredBlackboxPatterns = patterns;
    await Promise.all([...this.sessions.keys()].map((sessionId) =>
      this.client.Debugger.setBlackboxPatterns({ patterns }, sessionId)
        .catch((e: unknown) => logger.debug(`setBlackboxPatterns on ${sessionId} failed: ${e}`))
    ));
  }

  async setBlackboxedRanges(
    scriptId: string,
    positions: Array<{ lineNumber: number; columnNumber: number }>
  ): Promise<void> {
    const { sessionId, rawScriptId } = this.routeScript(scriptId);
    await this.client.Debugger.setBlackboxedRanges({ scriptId: rawScriptId, positions }, sessionId);
  }

  async getPossibleBreakpoints(
    start: { scriptId: string; lineNumber: number; columnNumber?: number },
    end: { scriptId: string; lineNumber: number; columnNumber?: number }
  ): Promise<BreakLocation[]> {
    const { sessionId, rawScriptId } = this.routeScript(start.scriptId);
    const result = await this.client.Debugger.getPossibleBreakpoints({
      start: { ...start, scriptId: rawScriptId },
      end: { ...end, scriptId: this.fromGlobalScriptId(end.scriptId).rawScriptId },
      restrictToFunction: false,
    }, sessionId);
    // Return scriptIds in their global form so callers can round-trip them.
    return result.locations.map((loc: BreakLocation) => ({
      ...loc,
      scriptId: this.toGlobalScriptId(loc.scriptId, sessionId),
    }));
  }

  async setBreakpoint(
    location: { scriptId: string; lineNumber: number; columnNumber?: number }
  ): Promise<{ breakpointId: string; actualLocation: { scriptId: string; lineNumber: number; columnNumber: number } }> {
    // Location (scriptId) breakpoints are inherently single-session — used for
    // step-in targets in the currently paused tab.
    const { sessionId, rawScriptId } = this.routeScript(location.scriptId);
    const result = await this.client.Debugger.setBreakpoint({
      location: { ...location, scriptId: rawScriptId },
    }, sessionId);
    this.rawBreakpointSessions.set(result.breakpointId, sessionId);
    return {
      breakpointId: result.breakpointId,
      actualLocation: {
        ...result.actualLocation,
        scriptId: this.toGlobalScriptId(result.actualLocation.scriptId, sessionId),
      },
    };
  }

  async setBreakpointsActive(active: boolean): Promise<void> {
    this.desiredBreakpointsActive = active;
    await Promise.all([...this.sessions.keys()].map((sessionId) =>
      this.client.Debugger.setBreakpointsActive({ active }, sessionId)
        .catch((e: unknown) => logger.debug(`setBreakpointsActive on ${sessionId} failed: ${e}`))
    ));
  }

  async setPauseOnExceptions(state: 'none' | 'uncaught' | 'all'): Promise<void> {
    this.desiredPauseOnExceptions = state;
    await Promise.all([...this.sessions.keys()].map((sessionId) =>
      this.client.Debugger.setPauseOnExceptions({ state }, sessionId)
        .catch((e: unknown) => logger.debug(`setPauseOnExceptions on ${sessionId} failed: ${e}`))
    ));
  }

  // --- Runtime Domain ---

  async getProperties(objectId: string, ownProperties: boolean = true): Promise<PropertyDescriptor[]> {
    const result = await this.client.Runtime.getProperties({
      objectId,
      ownProperties,
      generatePreview: true,
    }, this.requireActiveSession());
    return result.result;
  }

  async evaluate(expression: string, silent: boolean = false): Promise<RemoteObject> {
    const result = await this.client.Runtime.evaluate({
      expression,
      silent,
      returnByValue: false,
      generatePreview: true,
    }, this.requireActiveSession());
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Evaluation failed');
    }
    return result.result;
  }

  /**
   * Evaluate an expression and return its value deserialized directly (via V8's
   * returnByValue path). The expression must evaluate to a JSON-serializable
   * value — no functions, symbols, or cycles. Used for structured data fetching
   * where the shape is known ahead of time (e.g. React component tree walks).
   */
  async evaluateForValue<T = unknown>(expression: string): Promise<T | undefined> {
    const result = await this.client.Runtime.evaluate({
      expression,
      silent: true,
      returnByValue: true,
      awaitPromise: true,
    }, this.requireActiveSession());
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.text
        || result.exceptionDetails.exception?.description
        || 'Evaluation failed';
      throw new Error(text);
    }
    return result.result?.value as T | undefined;
  }

  /**
   * Persistently compile an expression in the page and return its scriptId.
   * Subsequent `runCompiledScript` calls reuse the compiled form, avoiding
   * repeated parse+compile of the same expression (e.g. the React walker).
   * V8 invalidates the scriptId if the page navigates OR if the active tab
   * changes (the compiled script lives in one session); call sites must catch
   * errors and re-compile as a fallback.
   */
  async compileScript(expression: string): Promise<string> {
    const result = await this.client.Runtime.compileScript({
      expression,
      sourceURL: '',
      persistScript: true,
    }, this.requireActiveSession());
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'compileScript failed');
    }
    return result.scriptId;
  }

  async runCompiledScript<T = unknown>(scriptId: string): Promise<T | undefined> {
    const result = await this.client.Runtime.runScript({
      scriptId,
      returnByValue: true,
      awaitPromise: true,
      silent: true,
    }, this.requireActiveSession());
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'runScript failed');
    }
    return result.result?.value as T | undefined;
  }

  async callFunctionOn(objectId: string, functionDeclaration: string, args?: CallArgument[]): Promise<RemoteObject> {
    const result = await this.client.Runtime.callFunctionOn({
      objectId,
      functionDeclaration,
      arguments: args,
      returnByValue: false,
      generatePreview: true,
    }, this.requireActiveSession());
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Call failed');
    }
    return result.result;
  }

  // --- Page Domain ---

  async reload(ignoreCache: boolean = false): Promise<void> {
    // Reload every Vite tab so initial breakpoints catch the next execution in
    // each of them.
    await Promise.all([...this.sessions.keys()].map((sessionId) =>
      this.client.Page.reload({ ignoreCache }, sessionId)
        .catch((e: unknown) => logger.debug(`Page.reload on ${sessionId} failed: ${e}`))
    ));
  }

  // --- Fetch Domain ---

  async continueFetchRequest(requestId: string): Promise<void> {
    const sessionId = this.fetchRequestOwners.get(requestId) ?? this.requireActiveSession();
    this.fetchRequestOwners.delete(requestId);
    await this.client.Fetch.continueRequest({ requestId }, sessionId);
  }

  async failFetchRequest(requestId: string, reason: string = 'Failed'): Promise<void> {
    const sessionId = this.fetchRequestOwners.get(requestId) ?? this.requireActiveSession();
    this.fetchRequestOwners.delete(requestId);
    await this.client.Fetch.failRequest({ requestId, reason }, sessionId);
  }

  // --- Connection Management ---

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore close errors
      }
      this.client = null;
    }
  }

  get isConnected(): boolean {
    return this.client !== null;
  }
}

/**
 * Fetch the browser-level WebSocket debugger URL from `/json/version`. Connecting
 * to this (rather than a page target) is what lets us see and attach to every
 * tab via the Target domain.
 */
function getBrowserWebSocketUrl(port: number, timeout: number = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, { timeout }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const info = JSON.parse(body) as { webSocketDebuggerUrl?: string };
          if (info.webSocketDebuggerUrl) {
            resolve(info.webSocketDebuggerUrl);
          } else {
            reject(new Error('No browser webSocketDebuggerUrl in /json/version'));
          }
        } catch (e) {
          reject(new Error(`Failed to parse /json/version: ${e}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout fetching /json/version')); });
  });
}
