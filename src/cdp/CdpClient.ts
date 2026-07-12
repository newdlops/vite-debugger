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

export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
}

/**
 * Stable, serializable metadata for a page target managed by the debugger.
 * This deliberately omits the browser websocket URL and other connection
 * details so it is safe to hand to local automation clients (for example the
 * MCP bridge).
 */
export interface CdpTargetMetadata extends TargetInfo {
  sessionId: string;
  active: boolean;
  primary: boolean;
  paused: boolean;
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
  /**
   * Per-session lifecycle queue. A page can navigate away from the Vite origin
   * and back quickly; serializing disable/enable prevents an older disable
   * from racing with (and undoing) the later re-attach setup.
   */
  private sessionLifecycles = new Map<string, Promise<void>>();
  /** The tab currently paused — pause-time ops route here. */
  private activeSessionId?: string;
  /** First matching page session — default for ops when nothing is paused. */
  private primarySessionId?: string;
  /** Sessions which Chrome currently reports as paused. */
  private pausedSessionIds = new Set<string>();

  /**
   * Fetch requestId -> sessions it paused in. Request ids are scoped to a
   * flattened target session and can therefore collide across tabs.
   */
  private fetchRequestOwners = new Map<string, Set<string>>();

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
      if (!this.isManagedEventSession(sessionId)) return;
      // Globalize the scriptId so the same file in two tabs doesn't collide on
      // the per-session raw id.
      this.emit('scriptParsed', { ...params, scriptId: this.toGlobalScriptId(params.scriptId, sessionId) }, sessionId);
    });

    client.Debugger.paused((params: PausedEvent, sessionId?: string) => {
      if (!this.isManagedEventSession(sessionId)) return;
      // The paused tab becomes the active session: its call frames, scopes and
      // object ids are only valid against this session.
      if (sessionId) {
        this.activeSessionId = sessionId;
        this.pausedSessionIds.add(sessionId);
      }
      this.emit('paused', this.globalizePausedEvent(params, sessionId), sessionId);
    });

    client.Debugger.resumed((_params: unknown, sessionId?: string) => {
      if (!this.isManagedEventSession(sessionId)) return;
      if (sessionId) {
        this.pausedSessionIds.delete(sessionId);
        if (this.activeSessionId === sessionId) {
          this.activeSessionId = this.lastPausedSessionId();
        }
      }
      this.emit('resumed', sessionId);
    });

    client.Runtime.exceptionThrown((params: { exceptionDetails: ExceptionDetails }, sessionId?: string) => {
      if (!this.isManagedEventSession(sessionId)) return;
      this.emit('exceptionThrown', params.exceptionDetails, sessionId);
    });

    client.Runtime.consoleAPICalled((params: ConsoleAPICalledEvent, sessionId?: string) => {
      if (!this.isManagedEventSession(sessionId)) return;
      this.emit('consoleAPICalled', params, sessionId);
    });

    client.Fetch.requestPaused((params: FetchRequestPausedEvent, sessionId?: string) => {
      if (!this.isManagedEventSession(sessionId)) return;
      if (sessionId) {
        const owners = this.fetchRequestOwners.get(params.requestId) ?? new Set<string>();
        owners.add(sessionId);
        this.fetchRequestOwners.set(params.requestId, owners);
      }
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

    await this.queueSessionLifecycle(sessionId, () =>
      this.manageSession(sessionId, params.waitingForDebugger)
    );
  }

  private async onTargetInfoChanged(targetInfo: TargetInfo): Promise<void> {
    // A tab can move both INTO and OUT OF the Vite app without changing its
    // targetId/sessionId. Always update its attached-session record, then
    // transition management according to the new URL.
    for (const [sessionId, info] of this.allSessions) {
      if (info.targetId === targetInfo.targetId) {
        this.allSessions.set(sessionId, targetInfo);

        if (targetInfo.type === 'page' && this.urlMatches(targetInfo.url)) {
          if (!this.sessions.has(sessionId)) {
            await this.queueSessionLifecycle(sessionId, () =>
              this.manageSession(sessionId, false)
            );
          } else {
            // Keep title and URL current for status/automation consumers. The
            // targetId and sessionId remain stable across same-tab navigations.
            this.sessions.set(sessionId, targetInfo);
          }
        } else {
          // Make target-scoped operations reject synchronously as soon as the
          // browser reports the cross-origin navigation. Domain shutdown is
          // serialized afterwards so a fast navigation back to Vite cannot
          // be undone by a late Debugger.disable/Fetch.disable.
          const hadLifecycle = this.sessionLifecycles.has(sessionId);
          const wasManaged = this.removeManagedSessionState(sessionId);
          if (wasManaged || hadLifecycle) {
            await this.queueSessionLifecycle(sessionId, async () => {
              // A preceding queued manage may have started after the eager
              // removal above. Remove once more at the transition boundary.
              this.removeManagedSessionState(sessionId);
              await this.disableSessionDomains(sessionId);
            });
          }
        }
        return;
      }
    }
  }

  /** Bring a matching page session under management: enable domains, apply
   *  desired state, and install every known breakpoint. */
  private async manageSession(
    sessionId: string,
    waitingForDebugger?: boolean,
  ): Promise<void> {
    // Lifecycle work is queued, so re-check the latest target info rather than
    // trusting the URL from the event that originally scheduled this task.
    const targetInfo = this.allSessions.get(sessionId);
    if (!targetInfo || targetInfo.type !== 'page' || !this.urlMatches(targetInfo.url)) return;
    if (this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, targetInfo);
    if (!this.primarySessionId) this.primarySessionId = sessionId;

    try {
      await this.setupSession(sessionId);
    } catch (error) {
      this.removeManagedSessionState(sessionId);
      throw error;
    }

    // targetInfoChanged eagerly removes the managed state while setup is in
    // flight. In that case the queued disable transition owns the next step.
    if (!this.sessions.has(sessionId)) return;

    // We attach with waitForDebuggerOnStart:false, but honor the flag defensively
    // in case Chrome paused the target — never leave a tab hung.
    if (waitingForDebugger) {
      await this.runIfWaitingForDebugger(sessionId);
    }

    logger.info(`Attached to Vite tab (session ${sessionId}): ${targetInfo.url}`);
    this.emit('targetAttached', sessionId, targetInfo);
  }

  private queueSessionLifecycle(sessionId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.sessionLifecycles.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(task);
    this.sessionLifecycles.set(sessionId, operation);
    void operation.finally(() => {
      if (this.sessionLifecycles.get(sessionId) === operation) {
        this.sessionLifecycles.delete(sessionId);
      }
    }).catch(() => undefined);
    return operation;
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

  private async disableSessionDomains(sessionId: string): Promise<void> {
    const client = this.client;
    if (!client) return;

    // Fetch is disabled first so any interception paused during navigation is
    // released promptly. Every call is best-effort: the page may have closed
    // between targetInfoChanged and this queued transition.
    await client.Fetch.disable({}, sessionId)
      .catch((e: unknown) => logger.debug(`Fetch.disable on ${sessionId} failed: ${e}`));
    await Promise.all([
      client.Debugger.disable({}, sessionId),
      client.Runtime.disable({}, sessionId),
      client.Page.disable({}, sessionId),
    ].map((operation) => Promise.resolve(operation).catch((e: unknown) => {
      logger.debug(`Domain disable on ${sessionId} failed: ${e}`);
    })));
    logger.info(`Stopped debugging tab outside Vite origin (session ${sessionId})`);
  }

  /** Remove every piece of state that could route an operation to a session. */
  private removeManagedSessionState(sessionId: string): boolean {
    const wasManaged = this.sessions.delete(sessionId);

    // Drop this session's per-breakpoint ids.
    for (const ids of this.urlBreakpointIds.values()) {
      ids.delete(sessionId);
    }
    for (const [bpId, sid] of [...this.rawBreakpointSessions]) {
      if (sid === sessionId) this.rawBreakpointSessions.delete(bpId);
    }
    for (const [reqId, owners] of [...this.fetchRequestOwners]) {
      owners.delete(sessionId);
      if (owners.size === 0) this.fetchRequestOwners.delete(reqId);
    }

    this.pausedSessionIds.delete(sessionId);
    if (this.activeSessionId === sessionId) this.activeSessionId = this.lastPausedSessionId();
    if (this.primarySessionId === sessionId) {
      this.primarySessionId = this.sessions.keys().next().value as string | undefined;
    }

    if (wasManaged) {
      logger.info(`Vite tab detached (session ${sessionId})`);
      this.emit('targetDetached', sessionId);
    }
    return wasManaged;
  }

  private onDetachedFromTarget(sessionId: string): void {
    this.allSessions.delete(sessionId);
    this.removeManagedSessionState(sessionId);
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
    try {
      const a = new URL(url);
      const b = new URL(filter);
      // Treat localhost and its loopback spelling as equivalent, while still
      // enforcing the rest of the URL origin. In particular, http -> https is
      // a cross-origin navigation even when hostname and explicit port match.
      return a.protocol === b.protocol
        && hostsEquivalent(a.hostname, b.hostname)
        && a.port === b.port;
    } catch {
      return false;
    }
  }

  /** Number of Vite tabs currently being debugged. */
  get attachedTabCount(): number {
    return this.sessions.size;
  }

  /**
   * Return a point-in-time view of the managed Vite page targets. The returned
   * objects are copies and can be safely serialized by callers.
   */
  listTargets(): CdpTargetMetadata[] {
    return [...this.sessions].map(([sessionId, info]) => ({
      ...info,
      sessionId,
      active: sessionId === this.activeSessionId,
      primary: sessionId === this.primarySessionId,
      paused: this.pausedSessionIds.has(sessionId),
    }));
  }

  /** Target id currently selected for pause-time operations, if any. */
  get activeTargetId(): string | undefined {
    const sessionId = this.activeSessionId ?? this.primarySessionId;
    return sessionId ? this.sessions.get(sessionId)?.targetId : undefined;
  }

  /** Resolve an internal flattened session id to its stable page target id. */
  targetIdForSession(sessionId?: string): string | undefined {
    return sessionId ? this.sessions.get(sessionId)?.targetId : undefined;
  }

  /** True when at least one managed page target is paused. */
  get hasPausedTargets(): boolean {
    return this.pausedSessionIds.size > 0;
  }

  // ---------------------------------------------------------------------------
  // Session routing helpers
  // ---------------------------------------------------------------------------

  /** Flattened-domain events from unrelated attached tabs are not debugger events. */
  private isManagedEventSession(sessionId?: string): boolean {
    // Flatten-mode events are session-tagged. Keep the undefined case for CDP
    // implementations which omit the id only when exactly one managed page is
    // available; otherwise an untagged event is ambiguous and must be ignored.
    return sessionId === undefined
      ? this.sessions.size === 1
      : this.sessions.has(sessionId);
  }

  /** Session for pause-time ops (stepping, evaluate, scopes, variables). */
  private requireActiveSession(): string {
    const sessionId = this.activeSessionId ?? this.primarySessionId;
    if (!sessionId) {
      throw new Error('No attached Chrome tab available for this operation');
    }
    return sessionId;
  }

  /** Resolve an externally-visible target id to its flattened CDP session. */
  private requireTargetSession(targetId?: string): string {
    if (!targetId) return this.requireActiveSession();
    for (const [sessionId, info] of this.sessions) {
      if (info.targetId === targetId) return sessionId;
    }
    throw new Error(`Unknown or unmanaged Chrome target: ${targetId}`);
  }

  private lastPausedSessionId(): string | undefined {
    let latest: string | undefined;
    for (const sessionId of this.pausedSessionIds) latest = sessionId;
    return latest;
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
    const routedSessionId = sessionId ?? this.requireActiveSession();
    if (!this.sessions.has(routedSessionId)) {
      throw new Error(`Unknown or unmanaged Chrome session: ${routedSessionId}`);
    }
    return { sessionId: routedSessionId, rawScriptId };
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

  async resume(targetId?: string): Promise<void> {
    await this.client.Debugger.resume({}, this.requireTargetSession(targetId));
  }

  async stepOver(targetId?: string): Promise<void> {
    await this.client.Debugger.stepOver({}, this.requireTargetSession(targetId));
  }

  async stepInto(targetId?: string): Promise<void> {
    await this.client.Debugger.stepInto({}, this.requireTargetSession(targetId));
  }

  async stepOut(targetId?: string): Promise<void> {
    await this.client.Debugger.stepOut({}, this.requireTargetSession(targetId));
  }

  async pause(targetId?: string): Promise<void> {
    await this.client.Debugger.pause({}, this.requireTargetSession(targetId));
  }

  async getScriptSource(scriptId: string): Promise<string> {
    const { sessionId, rawScriptId } = this.routeScript(scriptId);
    const result = await this.client.Debugger.getScriptSource({ scriptId: rawScriptId }, sessionId);
    return result.scriptSource;
  }

  async evaluateOnCallFrame(
    callFrameId: string,
    expression: string,
    silent: boolean = false,
    targetId?: string,
    options: { throwOnSideEffect?: boolean; timeoutMs?: number } = {},
  ): Promise<RemoteObject> {
    const result = await this.client.Debugger.evaluateOnCallFrame({
      callFrameId,
      expression,
      silent,
      returnByValue: false,
      generatePreview: true,
      ...(options.throwOnSideEffect === undefined
        ? {}
        : { throwOnSideEffect: options.throwOnSideEffect }),
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    }, this.requireTargetSession(targetId));
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'Evaluation failed',
      );
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

  async getProperties(
    objectId: string,
    ownProperties: boolean = true,
    targetId?: string,
  ): Promise<PropertyDescriptor[]> {
    const result = await this.client.Runtime.getProperties({
      objectId,
      ownProperties,
      generatePreview: true,
    }, this.requireTargetSession(targetId));
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

  async reload(ignoreCache: boolean = false, targetId?: string): Promise<void> {
    if (targetId) {
      await this.client.Page.reload(
        { ignoreCache },
        this.requireTargetSession(targetId),
      );
      return;
    }
    // Reload every Vite tab so initial breakpoints catch the next execution in
    // each of them.
    await Promise.all([...this.sessions.keys()].map((sessionId) =>
      this.client.Page.reload({ ignoreCache }, sessionId)
        .catch((e: unknown) => logger.debug(`Page.reload on ${sessionId} failed: ${e}`))
    ));
  }

  // --- Fetch Domain ---

  async continueFetchRequest(requestId: string, sessionId?: string): Promise<void> {
    const routedSessionId = this.routeFetchRequest(requestId, sessionId);
    try {
      await this.client.Fetch.continueRequest({ requestId }, routedSessionId);
    } finally {
      this.releaseFetchRequest(requestId, routedSessionId);
    }
  }

  async failFetchRequest(
    requestId: string,
    reason: string = 'Failed',
    sessionId?: string,
  ): Promise<void> {
    const routedSessionId = this.routeFetchRequest(requestId, sessionId);
    try {
      await this.client.Fetch.failRequest({ requestId, reason }, routedSessionId);
    } finally {
      this.releaseFetchRequest(requestId, routedSessionId);
    }
  }

  private routeFetchRequest(requestId: string, requestedSessionId?: string): string {
    const owners = this.fetchRequestOwners.get(requestId);
    if (requestedSessionId) {
      if (owners && owners.size > 0 && !owners.has(requestedSessionId)) {
        throw new Error(
          `Fetch request ${requestId} does not belong to target session ${requestedSessionId}`,
        );
      }
      return requestedSessionId;
    }
    if (owners?.size === 1) return owners.values().next().value as string;
    if (owners && owners.size > 1) {
      throw new Error(
        `Fetch request ${requestId} exists in multiple target sessions; an explicit sessionId is required`,
      );
    }
    // Backwards compatibility for callers which predate per-target Fetch
    // routing and do not have an event session id available.
    return this.requireActiveSession();
  }

  private releaseFetchRequest(requestId: string, sessionId: string): void {
    const owners = this.fetchRequestOwners.get(requestId);
    if (!owners) return;
    owners.delete(sessionId);
    if (owners.size === 0) this.fetchRequestOwners.delete(requestId);
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
    this.sessions.clear();
    this.allSessions.clear();
    this.pausedSessionIds.clear();
    this.fetchRequestOwners.clear();
    this.activeSessionId = undefined;
    this.primarySessionId = undefined;
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
