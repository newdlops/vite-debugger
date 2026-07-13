import {
  LoggingDebugSession,
  InitializedEvent,
  StoppedEvent,
  ContinuedEvent,
  OutputEvent,
  TerminatedEvent,
  Thread,
  BreakpointEvent,
  LoadedSourceEvent,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { CdpClient, ScriptParsedEvent, PausedEvent } from '../cdp/CdpClient';
import { ConsoleAPICalledEvent, RemoteObject, BreakLocation, FetchRequestPausedEvent } from '../cdp/CdpTypes';
import { NetworkBreakpointManager } from '../breakpoints/NetworkBreakpointManager';
import {
  findViteTab,
  isChromeDebuggable,
  findExistingChromeDebugPort,
  launchDebugChrome,
  launchManagedDebugChrome,
} from '../cdp/ChromeDiscovery';
import { detectFirstViteServer, formatViteServerInfo, ViteServerInfo } from '../vite/ViteServerDetector';
import { ViteUrlMapper } from '../vite/ViteUrlMapper';
import { SourceMapResolver, normalizeViteUrl } from '../sourcemap/SourceMapResolver';
import { fileExistsCache } from '../util/FileExists';
import { fileChecksumCache } from '../util/FileChecksum';
import { BreakpointManager } from '../breakpoints/BreakpointManager';
import { CallStackManager, ResolvedCallFrame, SourceRefRegistrar } from '../inspection/CallStackManager';
import { ScopeManager } from '../inspection/ScopeManager';
import { VariableManager } from '../inspection/VariableManager';
import { EvalHandler } from '../inspection/EvalHandler';
import { logger } from '../util/Logger';

const THREAD_ID = 1;
const REACT_SCOPE_REF_BASE = 900000;
const REACT_HOOKS_REF_BASE = 910000;

/**
 * Compile a glob pattern (*, **, ?) to a RegExp. Called once per pattern at
 * launch/attach time — cached on the session so hot paths never re-compile.
 */
function compileGlob(pattern: string): RegExp {
  const regexStr = pattern
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(regexStr);
}

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  viteUrl?: string;
  /** Browser application page. May use a different local origin from the Vite module server. */
  pageUrl?: string;
  /** Internal marker on MCP-generated configs; never exposed as a public launch option. */
  _viteDebuggerMcpRequireWorkspaceMatch?: boolean;
  /** Correlates MCP starts and distinguishes schema defaults from launch.json values. */
  _viteDebuggerMcpStartId?: string;
  /** True only when chromePort was an own property of the selected launch config. */
  _viteDebuggerMcpChromePortExplicit?: boolean;
  chromePort?: number;
  webRoot?: string;
  sourceMapPathOverrides?: Record<string, string>;
  skipFiles?: string[];
  reloadOnAttach?: boolean;
}

interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
  viteUrl?: string;
  /** Browser application page. May use a different local origin from the Vite module server. */
  pageUrl?: string;
  /** Internal marker on MCP-generated configs; never exposed as a public launch option. */
  _viteDebuggerMcpRequireWorkspaceMatch?: boolean;
  chromePort?: number;
  webRoot?: string;
  sourceMapPathOverrides?: Record<string, string>;
  skipFiles?: string[];
  reloadOnAttach?: boolean;
}

interface McpCustomRequestArguments {
  expression?: string;
  cacheKey?: string;
  method?: string;
  params?: unknown;
}

type McpControlAction =
  | 'pause'
  | 'continue'
  | 'step_over'
  | 'step_into'
  | 'step_out'
  | 'reload';

/**
 * Pause data owned by one Chrome page target.
 *
 * Chrome can pause more than one tab at once. DAP exposes a single synthetic
 * thread, but MCP callers address real page targets, so their snapshots must
 * not share the adapter's single DAP stack buffer.
 */
interface McpPausedTargetState {
  targetId: string;
  sessionId?: string;
  pauseEpoch: number;
  reason: string;
  pausedEvent: PausedEvent;
  resolvedFrames: ResolvedCallFrame[];
  callStackManager: CallStackManager | null;
}

const MCP_MAX_FRAMES = 20;
const MCP_MAX_SCOPES = 4;
const MCP_MAX_VARIABLES_PER_SCOPE = 20;
const MCP_MAX_VALUE_LENGTH = 300;
const MCP_MAX_BREAKPOINTS = 200;
const MCP_MAX_EVALUATION_EXPRESSION_LENGTH = 10_000;

export class ViteDebugSession extends LoggingDebugSession {
  private cdp: CdpClient | null = null;
  private viteServer: ViteServerInfo | null = null;
  /** Actual port selected after discovery/launch, not merely launch.json input. */
  private activeChromePort: number | null = null;
  /** Single-flight guard used by launch and MCP recovery so concurrent callers open at most one tab. */
  private viteTargetCreation: Promise<{ targetId: string; created: boolean }> | null = null;
  /** MCP-visible execution state. Epoch changes on every real CDP pause. */
  private paused = false;
  private pauseReason: string | null = null;
  private pauseEpoch = 0;
  private lastPausedEvent: PausedEvent | null = null;
  private lastPauseTargetId: string | null = null;
  /** Targets for which a DAP/MCP pause command is waiting to surface. */
  private requestedPauseTargets = new Set<string>();
  /** Target-scoped pause snapshots for MCP. Never expose session ids. */
  private mcpPausedTargets = new Map<string, McpPausedTargetState>();
  private urlMapper: ViteUrlMapper | null = null;
  private sourceMapResolver: SourceMapResolver | null = null;
  private breakpointManager: BreakpointManager | null = null;
  private callStackManager: CallStackManager | null = null;
  private scopeManager: ScopeManager | null = null;
  private variableManager: VariableManager | null = null;
  private evalHandler: EvalHandler | null = null;
  private networkBreakpointManager: NetworkBreakpointManager | null = null;

  private resolvedFrames: ResolvedCallFrame[] = [];
  private knownScriptUrls = new Map<string, string>();  // url -> latest scriptId (any tab)
  // HMR detection is per-tab (session): the SAME url is parsed with a different
  // scriptId in every tab, so a global url->scriptId map would mistake a second
  // tab's first parse for an HMR replacement. Keyed by sessionId -> (url -> scriptId).
  private hmrScriptUrlsBySession = new Map<string, Map<string, string>>();
  private scriptIdToUrl = new Map<string, string>();     // scriptId -> url (for sourceRequest)
  private sourceRefToScriptId = new Map<number, string>(); // sourceReference -> scriptId
  private nextSourceRef = 1;
  private exceptionBreakMode: 'none' | 'uncaught' | 'all' = 'none';
  private reactComponentName: string | null = null;
  private reactComponentObjectId: string | null = null;
  private reactHooksObjectId: string | null = null;
  private smartStepCount = 0;
  private static readonly MAX_SMART_STEPS = 20;
  private lastStepAction: 'stepOver' | 'stepInto' | 'stepOut' | null = null;
  /** scriptId of the most recent user-visible pause that landed in user code
   *  (i.e., top frame path is set and not inside node_modules). Null after any
   *  pause that didn't land in user code. Used to detect frame transitions:
   *  if `lastUserPauseScriptId !== null` and the next pause's scriptId differs,
   *  we just crossed out of a user frame — likely returning from a user
   *  component into React's reconciler. In that case smart-step pauses once
   *  at the first non-user landing point (even when the source map has no
   *  entry for the position, as happens inside pre-bundled react-dom chunks).
   *  Covers stepOver (JSX-return case), stepInto (e.g., stepping into a JSX
   *  element and hitting the reconciler first), and stepOut. */
  private lastUserPauseScriptId: string | null = null;
  private stepInTargetLocations = new Map<number, BreakLocation>();
  private tempBreakpointId: string | null = null;
  private sourceMapRetryTimer: NodeJS.Timeout | null = null;
  /** Precompiled regexes for user-configured skipFiles globs */
  private skipFileRegexes: RegExp[] = [];
  /** Opt-in: when true, Page.reload is invoked once after configurationDone
   *  so breakpoints set on already-executed code (mounted component bodies,
   *  top-level module code) hit on the fresh execution. Default false —
   *  most users prefer to keep their page state and let bps hit naturally
   *  when the relevant code runs again (event handlers, React re-renders
   *  triggered by interaction). Same constraint applies to Chrome DevTools:
   *  CDP can't replay execution that already completed. */
  private reloadOnAttach = false;
  /** Vite URLs we've already triggered a proactive `import()` for, so a
   *  second setBreakpoints request on the same source doesn't fire another
   *  import. Once the module is fetched its scriptParsed event drives the
   *  pending-bp resolution path; we just need to nudge it once. */
  private proactivelyImportedUrls = new Set<string>();
  /** Pending HMR script IDs to batch-process */
  private pendingHmrScriptIds: string[] = [];
  private hmrBatchTimer: NodeJS.Timeout | null = null;
  /** Scripts we've permanently blackboxed at the CDP level because they have
   *  no source map and no local counterpart. Step-through skips them entirely. */
  private unmappableScripts = new Set<string>();
  /** cacheKey → persistent scriptId produced by Runtime.compileScript. Lets
   *  the React tree walker (~6 KB expression) be parsed once and reused. */
  private compiledScripts = new Map<string, string>();

  constructor() {
    super('vite-debugger.log');
  }

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    _args: DebugProtocol.InitializeRequestArguments
  ): void {
    response.body = response.body || {};
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsFunctionBreakpoints = true;
    response.body.supportsConditionalBreakpoints = true;
    response.body.supportsHitConditionalBreakpoints = true;
    response.body.supportsEvaluateForHovers = true;
    response.body.supportsSetVariable = false;
    response.body.supportsStepBack = false;
    response.body.supportsRestartFrame = false;
    response.body.supportsGotoTargetsRequest = false;
    response.body.supportsStepInTargetsRequest = true;
    response.body.supportsCompletionsRequest = false;
    response.body.supportsModulesRequest = false;
    response.body.supportsExceptionInfoRequest = false;
    response.body.supportsLogPoints = true;
    response.body.supportsExceptionOptions = true;
    response.body.supportsLoadedSourcesRequest = true;
    response.body.supportsBreakpointLocationsRequest = true;
    response.body.supportedChecksumAlgorithms = ['SHA256'];
    response.body.exceptionBreakpointFilters = [
      {
        filter: 'uncaught',
        label: 'Uncaught Exceptions',
        default: false,
      },
      {
        filter: 'all',
        label: 'All Exceptions',
        default: false,
      },
    ];

    this.sendResponse(response);
  }

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments
  ): Promise<void> {
    try {
      const webRoot = args.webRoot || process.cwd();
      const mcpStarted = typeof args._viteDebuggerMcpStartId === 'string';
      const chromePortIsExplicit = args._viteDebuggerMcpChromePortExplicit ?? (
        !mcpStarted && args.chromePort !== undefined
      );
      const requestedChromePort = chromePortIsExplicit
        ? this.validateOptionalChromePort(args.chromePort)
        : undefined;
      this.skipFileRegexes = (args.skipFiles ?? []).map(compileGlob);
      this.reloadOnAttach = args.reloadOnAttach ?? false;

      // Step 1: Detect Vite server
      this.viteServer = await detectFirstViteServer(
        args.viteUrl,
        webRoot,
        args._viteDebuggerMcpRequireWorkspaceMatch === true,
      );
      if (!this.viteServer) {
        this.sendErrorResponse(
          response,
          1001,
          `No unambiguous running Vite dev server found for webRoot "${webRoot}". ` +
          'Start Vite first or set viteUrl explicitly.',
        );
        return;
      }
      this.applyConfiguredPageUrl(args.pageUrl);
      logger.info(`Vite server found: ${formatViteServerInfo(this.viteServer)}`);
      this.sendEvent(new OutputEvent(`Vite server: ${formatViteServerInfo(this.viteServer)}\n`, 'console'));
      this.reportLocalTlsCertificateBypass();

      // Step 2: Find Chrome with debug port
      const activeChromePort = await this.ensureLaunchChromeDebugPort(requestedChromePort, webRoot);

      // Step 3: Connect
      await this.connectAndSetup(activeChromePort, webRoot);
      await this.ensureLaunchViteTarget(activeChromePort);

      this.sendResponse(response);
      this.sendEvent(new InitializedEvent());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.sendErrorResponse(response, 1002, `Launch failed: ${msg}`);
    }
  }

  protected async attachRequest(
    response: DebugProtocol.AttachResponse,
    args: AttachRequestArguments
  ): Promise<void> {
    try {
      const webRoot = args.webRoot || process.cwd();
      const chromePort = this.validateOptionalChromePort(args.chromePort) ?? 9222;
      this.skipFileRegexes = (args.skipFiles ?? []).map(compileGlob);
      this.reloadOnAttach = args.reloadOnAttach ?? false;

      // Detect Vite server
      this.viteServer = await detectFirstViteServer(
        args.viteUrl,
        webRoot,
        args._viteDebuggerMcpRequireWorkspaceMatch === true,
      );
      if (!this.viteServer) {
        this.sendErrorResponse(
          response,
          1001,
          `No unambiguous running Vite dev server found for webRoot "${webRoot}". ` +
          'Start Vite first or set viteUrl explicitly.',
        );
        return;
      }
      this.applyConfiguredPageUrl(args.pageUrl);
      logger.info(`Vite server found: ${formatViteServerInfo(this.viteServer)}`);
      this.reportLocalTlsCertificateBypass();

      // Find Chrome debug port (attach mode: won't launch new Chrome, but will restart if needed)
      const activeChromePort = await this.ensureChromeDebugPort(chromePort);

      await this.connectAndSetup(activeChromePort, webRoot);

      this.sendResponse(response);
      this.sendEvent(new InitializedEvent());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.sendErrorResponse(response, 1004, `Attach failed: ${msg}`);
    }
  }

  private reportLocalTlsCertificateBypass(): void {
    if (!this.viteServer?.localTlsCertificateBypass) return;
    this.sendEvent(new OutputEvent(
      'Warning: Node did not trust the Vite HTTPS certificate. Detection was allowed only because ' +
      'the host resolved exclusively to loopback. Chrome must still trust the certificate or the app may show a certificate error.\n',
      'stderr',
    ));
  }

  private applyConfiguredPageUrl(pageUrl: string | undefined): void {
    if (!pageUrl || !this.viteServer) return;
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('pageUrl must use http or https');
    }
    this.viteServer = { ...this.viteServer, pageUrl: parsed.href };
  }

  private validateOptionalChromePort(chromePort: number | undefined): number | undefined {
    if (chromePort === undefined) return undefined;
    if (!Number.isInteger(chromePort) || chromePort < 1 || chromePort > 65535) {
      throw new Error('chromePort must be an integer between 1 and 65535');
    }
    return chromePort;
  }

  /**
   * Launch sessions only reuse a remote-debugging endpoint when the user
   * explicitly selected that port. Machine-wide discovery can otherwise grab
   * a transient Lighthouse/headless Chrome and couple this debug session to a
   * browser process that the extension neither owns nor can keep alive.
   *
   * With no explicit port (the MCP-generated default), Chrome gets a fresh
   * profile and asks the OS for its own remote-debugging port. An unavailable
   * explicit port also starts an isolated Chrome, but keeps the requested port.
   */
  private async ensureLaunchChromeDebugPort(
    requestedPort: number | undefined,
    profileScope: string,
  ): Promise<number> {
    if (requestedPort !== undefined && await isChromeDebuggable(requestedPort)) {
      this.sendEvent(new OutputEvent(`Chrome debug port ${requestedPort} ready\n`, 'console'));
      return requestedPort;
    }

    this.sendEvent(new OutputEvent(
      requestedPort === undefined
        ? 'Launching isolated debug Chrome with a leased port...\n'
        : `Launching isolated debug Chrome on requested port ${requestedPort}...\n`,
      'console',
    ));
    return launchManagedDebugChrome(this.vitePageUrl(), requestedPort, profileScope);
  }

  /**
   * Ensure a debuggable Chrome is available.
   * Priority:
   *   1. Specified chromePort already has a debuggable Chrome → use it
   *   2. Another debug port found on a running Chrome → use it
   *   3. Launch a separate debug Chrome instance (doesn't touch the user's normal Chrome)
   */
  private async ensureChromeDebugPort(chromePort: number): Promise<number> {
    // 1. Check specified port
    if (await isChromeDebuggable(chromePort)) {
      this.sendEvent(new OutputEvent(`Chrome debug port ${chromePort} ready\n`, 'console'));
      return chromePort;
    }

    // 2. Auto-discover existing debug port
    this.sendEvent(new OutputEvent('Searching for Chrome debug port...\n', 'console'));
    const existingPort = await findExistingChromeDebugPort();
    if (existingPort) {
      this.sendEvent(new OutputEvent(`Found Chrome debug port: ${existingPort}\n`, 'console'));
      return existingPort;
    }

    // 3. Launch a separate debug Chrome with the Vite URL
    //    Normal Chrome stays untouched — debug Chrome runs as a separate instance
    this.sendEvent(new OutputEvent(
      `Launching debug Chrome on port ${chromePort} with Vite URL...\n`, 'console'
    ));
    await launchDebugChrome(this.vitePageUrl(), chromePort);
    return chromePort;
  }

  private async connectAndSetup(chromePort: number, webRoot: string): Promise<void> {
    // Initialize components
    const viteRoot = this.viteServer!.root;
    this.urlMapper = new ViteUrlMapper(this.viteServer!.url, webRoot, viteRoot);
    this.sourceMapResolver = new SourceMapResolver(webRoot, viteRoot);

    // Connect to Chrome WITHOUT enabling domains yet. Listeners must be in
    // place before enable so the scriptParsed replay (and other replay-prone
    // events) fans out into our handlers — registering them after enable
    // would silently drop the replay, which is what made re-attach against
    // an already-loaded page require a manual page reload to start working.
    this.cdp = await CdpClient.connect(chromePort, this.vitePageUrl());
    this.activeChromePort = chromePort;

    // Initialize managers (depends on cdp)
    this.breakpointManager = new BreakpointManager(this.cdp, this.sourceMapResolver, this.viteServer!.url);
    this.callStackManager = new CallStackManager(this.sourceMapResolver, this.urlMapper);
    this.scopeManager = new ScopeManager();
    this.variableManager = new VariableManager(this.cdp);
    this.evalHandler = new EvalHandler(this.cdp, this.variableManager);

    // Initialize network breakpoint manager
    this.networkBreakpointManager = new NetworkBreakpointManager(this.cdp);
    this.networkBreakpointManager.onMatch(async (_rule, _request, sessionId) => {
      // Fetch events are scoped to a flattened target session. Resolve that
      // session back to its public target id so a request in one tab can never
      // pause whichever sibling tab happened to be active most recently.
      const cdp = this.cdp;
      if (!cdp) return;
      const targetId = sessionId ? cdp.targetIdForSession(sessionId) : cdp.activeTargetId;
      if (sessionId && !targetId) {
        logger.debug(`Ignoring network breakpoint from unmanaged target session ${sessionId}`);
        return;
      }
      await cdp.pause(targetId);
    });

    // Wire up source map loaded callback. Three responsibilities:
    //  (1) Resolve pending breakpoints against the newly mapped source.
    //  (2) If we had blackboxed this script because the map was missing
    //      earlier, lift the blackbox now so stepping can enter it.
    this.sourceMapResolver.onSourceMapLoaded = (scriptId: string) => {
      // (1) Pending breakpoints
      if (this.breakpointManager && this.breakpointManager.hasPendingBreakpoints()) {
        const url = this.scriptIdToUrl.get(scriptId);
        if (url) {
          this.breakpointManager.resolveBreakpointsForScript(scriptId, url).then(resolved => {
            for (const bp of resolved) {
              if (bp.owner !== 'vscode') continue;
              this.sendEvent(new BreakpointEvent('changed', {
                id: bp.dapId,
                verified: true,
                line: bp.line,
              } as DebugProtocol.Breakpoint));
            }
          }).catch(() => {});
        }
      }

      // (2) Undo any prior "server-only" blackbox — we can now show the map.
      if (this.unmappableScripts.has(scriptId) && this.cdp) {
        this.unmappableScripts.delete(scriptId);
        this.cdp.setBlackboxedRanges(scriptId, []).catch(() => {});
        logger.debug(`Lifted blackbox for ${scriptId} after source map loaded`);
      }
    };

    // Set up CDP event handlers BEFORE enabling domains. Debugger.enable
    // immediately replays every already-parsed script via scriptParsed —
    // we need our handler attached or those replays vanish.
    this.cdp.on('scriptParsed', (params: ScriptParsedEvent, sessionId?: string) => this.onScriptParsed(params, sessionId));
    this.cdp.on('paused', (params: PausedEvent, sessionId?: string) => this.onPaused(params, sessionId));
    this.cdp.on('resumed', (sessionId?: string) => this.onResumed(sessionId));
    this.cdp.on('disconnected', () => this.onDisconnected());
    this.cdp.on('consoleAPICalled', (params: ConsoleAPICalledEvent) => this.onConsoleAPICalled(params));
    this.cdp.on('requestPaused', (params: FetchRequestPausedEvent, sessionId?: string) => {
      const manager = this.networkBreakpointManager;
      if (manager) void manager.handleRequest(params, sessionId);
    });

    // A Vite app is often open in several tabs; each is a separate CDP target.
    // We attach to all of them so breakpoints fire no matter which tab runs the
    // code (and tabs opened later attach automatically).
    this.cdp.on('targetAttached', (_sessionId: string, info: { url: string }) => {
      this.sendEvent(new OutputEvent(
        `Debugging tab: ${info.url} (${this.cdp?.attachedTabCount ?? 1} tab(s) attached)\n`, 'console'
      ));
    });
    this.cdp.on('targetDetached', (sessionId: string) => {
      this.hmrScriptUrlsBySession.delete(sessionId);
      this.removeMcpPausedSession(sessionId);
      const managedTargetIds = new Set(this.cdp?.listTargets().map((target) => target.targetId) ?? []);
      for (const targetId of this.requestedPauseTargets) {
        if (!managedTargetIds.has(targetId)) this.requestedPauseTargets.delete(targetId);
      }
      this.sendEvent(new OutputEvent(
        `Tab closed (${this.cdp?.attachedTabCount ?? 0} tab(s) attached)\n`, 'console'
      ));
    });

    // Now enable domains — replay events flow into the handlers above.
    await this.cdp.enableDomains();

    // Blackbox Vite-generated runtime code that has no source-map equivalent.
    // We deliberately do NOT blanket-blackbox /node_modules/ — the user may
    // want to step into library code, and when a source map is available the
    // original source (e.g., react-dom.development.js) is readable. For
    // unmappable dep scripts we apply a per-script blackbox range on-demand
    // via markScriptUnmappable().
    await this.cdp.setBlackboxPatterns([
      '/@vite/',               // Vite client internals
      '/@react-refresh',       // React refresh runtime
      '__vite_',               // Vite HMR helpers
      '@vite-plugin-checker',  // Vite plugins
    ]);
    logger.info('Blackbox patterns set for Vite runtime code');

    // Set exception breakpoint state
    await this.cdp.setPauseOnExceptions(this.exceptionBreakMode);

    // Schedule retry for failed source maps (Vite might not be ready for all modules immediately)
    this.scheduleSourceMapRetry();

    this.sendEvent(new OutputEvent('Connected to Chrome DevTools\n', 'console'));
  }

  /**
   * `launch` owns opening the application. Reusing an already-debuggable Chrome
   * must not silently degrade into a connected session with zero managed tabs.
   * `attach` intentionally does not call this helper and preserves browser state.
   */
  private async ensureLaunchViteTarget(chromePort: number): Promise<void> {
    const result = await this.ensureManagedViteTarget(chromePort);
    if (result.created) {
      this.sendEvent(new OutputEvent(`Opened Vite app tab: ${this.vitePageUrl()}\n`, 'console'));
    }
  }

  private vitePageUrl(): string {
    if (!this.viteServer) throw new Error('No Vite server is selected');
    return this.viteServer.pageUrl ?? this.viteServer.url;
  }

  /**
   * Ensure Chrome contains one page on this session's exact Vite origin and
   * wait until the adapter has attached to it. The raw Chrome target lookup is
   * important here: auto-attach may still be enabling the page when launch (or
   * an MCP recovery call) arrives, and opening a duplicate would be surprising.
   */
  private async ensureManagedViteTarget(
    chromePort: number,
  ): Promise<{ targetId: string; created: boolean }> {
    const managed = this.cdp?.listTargets().find((target) => target.type === 'page');
    if (managed) return { targetId: managed.targetId, created: false };
    if (this.viteTargetCreation) return this.viteTargetCreation;

    const operation = (async (): Promise<{ targetId: string; created: boolean }> => {
      const cdp = this.cdp;
      const viteUrl = this.viteServer?.url;
      const pageUrl = this.viteServer?.pageUrl ?? viteUrl;
      if (!cdp?.isConnected || !viteUrl || !pageUrl) {
        throw new Error('Cannot open the Vite tab before Chrome is connected');
      }

      const existing = await findViteTab(chromePort, pageUrl);
      const expectedTargetId = existing?.id ?? await cdp.createTarget(pageUrl);
      const created = !existing;
      const deadline = Date.now() + 10_000;

      while (Date.now() < deadline) {
        if (this.cdp !== cdp || !cdp.isConnected) {
          throw new Error('Chrome disconnected while opening the Vite app tab');
        }
        const targets = cdp.listTargets();
        const target = targets.find((candidate) => candidate.targetId === expectedTargetId)
          ?? targets.find((candidate) => candidate.type === 'page');
        if (target) return { targetId: target.targetId, created };
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      throw new Error(
        `Chrome opened ${pageUrl}, but Vite Debugger did not attach to its page target within 10 seconds.`,
      );
    })();

    this.viteTargetCreation = operation;
    try {
      return await operation;
    } finally {
      if (this.viteTargetCreation === operation) this.viteTargetCreation = null;
    }
  }

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    _args: DebugProtocol.ConfigurationDoneArguments
  ): void {
    this.sendResponse(response);

    // Opt-in reload — only when user explicitly sets reloadOnAttach=true.
    // Default off so the user keeps their page state on attach. CDP can't
    // replay execution that already finished, so bps on already-mounted
    // component bodies / top-level module code only hit if (a) the user
    // triggers a re-render via interaction or (b) reloadOnAttach is on.
    if (this.reloadOnAttach && this.cdp) {
      logger.info('reloadOnAttach=true: reloading page so initial breakpoints catch the next execution');
      this.cdp.reload(false).catch((e) => {
        logger.warn(`Page.reload after attach failed: ${e}`);
      });
    }
  }

  // --- Breakpoints ---

  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments
  ): Promise<void> {
    const sourcePath = args.source.path;
    if (!sourcePath || !this.breakpointManager) {
      response.body = { breakpoints: [] };
      this.sendResponse(response);
      return;
    }

    const breakpoints = await this.breakpointManager.setBreakpoints(
      sourcePath,
      args.breakpoints ?? []
    );

    response.body = { breakpoints };
    this.sendResponse(response);

    // If any returned bp is unverified the source map for this file isn't
    // loaded yet — typically because the module is lazy-routed and hasn't
    // been imported by the running page yet. Nudge the browser to import
    // it so its scriptParsed event fires, the source map loads, and the
    // pending bp is resolved automatically (via onSourceMapLoaded). Without
    // this the user has to navigate to the page that uses the module before
    // any bp on it can hit.
    const hasUnverified = breakpoints.some((bp) => !bp.verified);
    if (hasUnverified && (args.breakpoints?.length ?? 0) > 0) {
      this.tryProactiveModuleLoad(sourcePath).catch(() => undefined);
    }
  }

  /**
   * Trigger `import('<viteUrl>')` in the running page so a lazy-loaded
   * module is fetched and parsed, even if the user hasn't navigated to
   * the route that imports it. This unblocks pending breakpoints on
   * code-split files: once the module is imported, its scriptParsed +
   * source-map-loaded path resolves the bp automatically.
   *
   * The import is fire-and-forget — failures (e.g. 404, syntax error,
   * non-importable file like a `.css`) are swallowed because they're
   * expected for many of the paths VSCode sends bps for (git: URIs,
   * non-JS files, files that aren't actually under the Vite root).
   */
  private async tryProactiveModuleLoad(sourcePath: string): Promise<void> {
    if (!this.cdp || !this.urlMapper) return;

    // VSCode sometimes sends bps for git: / untitled: virtual sources during
    // diff views. Those have no on-server URL — skip.
    if (sourcePath.startsWith('git:') || sourcePath.startsWith('untitled:')) return;

    // Only nudge for source files Vite will serve as ES modules. CSS / JSON /
    // SVG bps are unusual and Vite returns these with non-module MIME, which
    // would just throw a SyntaxError on import. Skip noisily-failing kinds.
    if (!/\.(tsx?|jsx?|m?js|svelte|vue)$/i.test(sourcePath)) return;

    const viteUrl = this.urlMapper.filePathToViteUrl(sourcePath);
    if (this.proactivelyImportedUrls.has(viteUrl)) return;
    this.proactivelyImportedUrls.add(viteUrl);

    // Resolve to "ok" / error string inside the page so awaitPromise gives us
    // the import outcome via returnByValue. Without awaitPromise we'd just
    // see a pending promise and have no idea whether the page-side import
    // actually completed (or failed silently with a 404 / CORS / MIME).
    const expression = `
      import(${JSON.stringify(viteUrl)})
        .then(() => "__vdbg_ok__")
        .catch((e) => "__vdbg_err__:" + (e && (e.message || e.toString()) || "unknown"))
    `;
    try {
      const result = await this.cdp.evaluateForValue<string>(expression);
      if (typeof result === 'string' && result.startsWith('__vdbg_err__:')) {
        logger.warn(`Proactive import failed for ${viteUrl}: ${result.slice('__vdbg_err__:'.length)}`);
      } else {
        logger.debug(`Proactive import succeeded for ${viteUrl}`);
      }
    } catch (e) {
      logger.warn(`Proactive import threw for ${viteUrl}: ${e}`);
    }
  }

  /**
   * DAP `breakpointLocations` — tells the client which (line, column) pairs
   * accept a breakpoint inside the requested source range. VSCode renders
   * these as the clickable bp dots in the gutter, which is how the user
   * places a breakpoint inside a single-line lambda body or on a specific
   * prop of multi-line JSX.
   *
   * Strategy: for every original line in range, get all generated positions
   * via the source-map-level index, ask CDP `getPossibleBreakpoints` for
   * each distinct generated line, then back-map each result to original
   * (line, column). Positions outside the requested source are dropped.
   */
  protected async breakpointLocationsRequest(
    response: DebugProtocol.BreakpointLocationsResponse,
    args: DebugProtocol.BreakpointLocationsArguments,
  ): Promise<void> {
    const sourcePath = args.source.path;
    if (!sourcePath || !this.sourceMapResolver || !this.cdp) {
      response.body = { breakpoints: [] };
      this.sendResponse(response);
      return;
    }

    const startLine = args.line;
    const endLine = args.endLine ?? args.line;
    const normalizedPath = sourcePath.replace(/\\/g, '/');

    // Collect distinct (scriptId, genLine) ranges we need to query. A single
    // original line often maps to many generated positions spread across
    // several generated lines (JSX expansion, HMR wrappers, etc.); a single
    // generated line can also host mappings for several original lines.
    // Dedupe so getPossibleBreakpoints is called once per distinct gen-line.
    const genLinesByScript = new Map<string, Set<number>>();
    for (let origLine = startLine; origLine <= endLine; origLine++) {
      const genPositions = this.sourceMapResolver.getGeneratedPositionsForOriginalLine(
        sourcePath,
        origLine,
      );
      for (const gp of genPositions) {
        let lines = genLinesByScript.get(gp.scriptId);
        if (!lines) {
          lines = new Set();
          genLinesByScript.set(gp.scriptId, lines);
        }
        lines.add(gp.lineNumber);
      }
    }

    if (genLinesByScript.size === 0) {
      response.body = { breakpoints: [] };
      this.sendResponse(response);
      return;
    }

    // Query CDP per (scriptId, genLine) in parallel.
    const queryResults = await Promise.all(
      [...genLinesByScript].flatMap(([scriptId, lines]) =>
        [...lines].map(async (genLine) => {
          try {
            const locations = await this.cdp!.getPossibleBreakpoints(
              { scriptId, lineNumber: genLine, columnNumber: 0 },
              { scriptId, lineNumber: genLine + 1, columnNumber: 0 },
            );
            return { scriptId, locations };
          } catch {
            return { scriptId, locations: [] as BreakLocation[] };
          }
        }),
      ),
    );

    // Back-map each CDP location to the original source; keep only those
    // that land in the requested source and line range.
    const seen = new Set<string>();
    const breakpoints: DebugProtocol.BreakpointLocation[] = [];
    for (const { scriptId, locations } of queryResults) {
      const backs = await Promise.all(
        locations.map((loc) =>
          this.sourceMapResolver!.generatedToOriginal(
            scriptId,
            loc.lineNumber,
            loc.columnNumber ?? 0,
          ),
        ),
      );
      for (const original of backs) {
        if (!original) continue;
        if (original.source !== normalizedPath) continue;
        if (original.line < startLine || original.line > endLine) continue;
        // DAP columns are 1-based; generatedToOriginal returns 0-based.
        const col = (original.column ?? 0) + 1;
        const key = `${original.line}:${col}`;
        if (seen.has(key)) continue;
        seen.add(key);
        breakpoints.push({ line: original.line, column: col });
      }
    }

    breakpoints.sort((a, b) => {
      if (a.line !== b.line) return a.line - b.line;
      return (a.column ?? 0) - (b.column ?? 0);
    });

    response.body = { breakpoints };
    this.sendResponse(response);
  }

  protected async setExceptionBreakPointsRequest(
    response: DebugProtocol.SetExceptionBreakpointsResponse,
    args: DebugProtocol.SetExceptionBreakpointsArguments
  ): Promise<void> {
    const filters = args.filters;

    if (filters.includes('all')) {
      this.exceptionBreakMode = 'all';
    } else if (filters.includes('uncaught')) {
      this.exceptionBreakMode = 'uncaught';
    } else {
      this.exceptionBreakMode = 'none';
    }

    if (this.cdp) {
      await this.cdp.setPauseOnExceptions(this.exceptionBreakMode);
    }

    this.sendResponse(response);
  }

  protected async setFunctionBreakPointsRequest(
    response: DebugProtocol.SetFunctionBreakpointsResponse,
    args: DebugProtocol.SetFunctionBreakpointsArguments
  ): Promise<void> {
    if (!this.networkBreakpointManager) {
      response.body = { breakpoints: [] };
      this.sendResponse(response);
      return;
    }

    const names = args.breakpoints.map(bp => bp.name);
    const rules = this.networkBreakpointManager.setRules(names);

    response.body = {
      breakpoints: args.breakpoints.map((bp) => {
        const rule = rules.find(r => r.name === bp.name);
        return {
          verified: !!rule,
          message: rule ? `Network: ${rule.type}:${rule.pattern}` : `Unknown breakpoint format: ${bp.name}`,
        };
      }),
    };

    this.sendResponse(response);
  }

  // --- Threads ---

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = {
      threads: [new Thread(THREAD_ID, 'Main Thread')],
    };
    this.sendResponse(response);
  }

  // --- Stack Trace ---

  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments
  ): Promise<void> {
    const startFrame = args.startFrame ?? 0;
    const maxFrames = args.levels ?? this.resolvedFrames.length;

    const frames = this.resolvedFrames
      .slice(startFrame, startFrame + maxFrames)
      .map(f => f.dapFrame);

    logger.debug(
      `stackTraceRequest: start=${startFrame} levels=${args.levels ?? 'all'} ` +
      `returning=${frames.length}/${this.resolvedFrames.length} ` +
      `top=${frames[0] ? `${frames[0].source?.path ?? frames[0].source?.name ?? '?'}:${frames[0].line}` : 'none'}`
    );

    // Dump the exact DAP StackFrame objects for the top 3 frames so we can
    // diagnose why VSCode may be auto-focusing a non-top frame after HMR.
    // Looking for: sourceReference unexpectedly set, presentationHint on the
    // top frame, missing source.path, odd column values.
    for (let i = 0; i < Math.min(3, frames.length); i++) {
      logger.debug(`stackTraceRequest frame[${i}]: ${JSON.stringify(frames[i])}`);
    }

    response.body = {
      stackFrames: frames,
      totalFrames: this.resolvedFrames.length,
    };
    this.sendResponse(response);
  }

  // --- Scopes & Variables ---

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments
  ): void {
    if (!this.scopeManager || !this.callStackManager || !this.variableManager) {
      response.body = { scopes: [] };
      this.sendResponse(response);
      return;
    }

    const cdpFrame = this.callStackManager.getCdpFrame(args.frameId);
    if (!cdpFrame) {
      response.body = { scopes: [] };
      this.sendResponse(response);
      return;
    }

    const managedScopes = this.scopeManager.resolveScopesForFrame(cdpFrame);

    // Register scope object IDs in the variable manager
    for (const ms of managedScopes) {
      const objectId = ms.cdpScope.object.objectId;
      if (objectId) {
        this.variableManager.registerScopeObjectId(objectId, ms.dapScope.variablesReference);
      }
    }

    const scopes = managedScopes.map(ms => ms.dapScope);

    // Add React component scopes if available for this frame
    if (args.frameId <= 1) {
      const componentLabel = this.reactComponentName ?? 'Component';

      if (this.reactHooksObjectId) {
        const hooksRef = REACT_HOOKS_REF_BASE;
        this.variableManager.registerScopeObjectId(this.reactHooksObjectId, hooksRef);
        scopes.unshift({
          name: `React: <${componentLabel}> Hooks`,
          variablesReference: hooksRef,
          expensive: false,
        });
      }

      if (this.reactComponentObjectId) {
        const reactRef = REACT_SCOPE_REF_BASE;
        this.variableManager.registerScopeObjectId(this.reactComponentObjectId, reactRef);
        scopes.unshift({
          name: `React: <${componentLabel}> Props`,
          variablesReference: reactRef,
          expensive: false,
        });
      }
    }

    response.body = { scopes };
    this.sendResponse(response);
  }

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments
  ): Promise<void> {
    if (!this.variableManager) {
      response.body = { variables: [] };
      this.sendResponse(response);
      return;
    }

    const variables = await this.variableManager.getVariables(args.variablesReference);
    response.body = { variables };
    this.sendResponse(response);
  }

  // --- Evaluate ---

  protected async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments
  ): Promise<void> {
    if (!this.evalHandler) {
      this.sendErrorResponse(response, 2001, 'Not connected');
      return;
    }

    let callFrameId: string | undefined;
    if (args.frameId && this.callStackManager) {
      const cdpFrame = this.callStackManager.getCdpFrame(args.frameId);
      callFrameId = cdpFrame?.callFrameId;
    }

    const result = await this.evalHandler.evaluate(
      args.expression,
      args.frameId,
      callFrameId,
      args.context as 'watch' | 'repl' | 'hover' | 'clipboard' | undefined,
    );

    response.body = result;
    this.sendResponse(response);
  }

  // --- Execution Control ---

  protected async continueRequest(
    response: DebugProtocol.ContinueResponse,
    _args: DebugProtocol.ContinueArguments
  ): Promise<void> {
    this.lastStepAction = null;
    this.smartStepCount = 0;
    if (this.cdp) {
      await this.cdp.resume();
    }
    response.body = { allThreadsContinued: true };
    this.sendResponse(response);
  }

  protected async nextRequest(
    response: DebugProtocol.NextResponse,
    _args: DebugProtocol.NextArguments
  ): Promise<void> {
    this.lastStepAction = 'stepOver';
    this.smartStepCount = 0;
    if (this.cdp) {
      await this.cdp.stepOver();
    }
    this.sendResponse(response);
  }

  protected async stepInTargetsRequest(
    response: DebugProtocol.StepInTargetsResponse,
    args: DebugProtocol.StepInTargetsArguments
  ): Promise<void> {
    if (!this.cdp || !this.callStackManager || !this.sourceMapResolver) {
      response.body = { targets: [] };
      this.sendResponse(response);
      return;
    }

    const cdpFrame = this.callStackManager.getCdpFrame(args.frameId);
    if (!cdpFrame) {
      response.body = { targets: [] };
      this.sendResponse(response);
      return;
    }

    const { scriptId, lineNumber } = cdpFrame.location;

    try {
      // Get possible breakpoint locations on the current line
      const locations = await this.cdp.getPossibleBreakpoints(
        { scriptId, lineNumber, columnNumber: 0 },
        { scriptId, lineNumber: lineNumber + 1, columnNumber: 0 }
      );

      // Filter to 'call' type locations (function call sites)
      const callLocations = locations.filter(loc => loc.type === 'call');

      this.stepInTargetLocations.clear();
      const locsToUse = callLocations.length > 0 ? callLocations : locations;

      // Resolve all original positions in parallel — each lookup is independent
      // but the old loop awaited them in series.
      const originals = await Promise.all(locsToUse.map((loc) =>
        this.sourceMapResolver!.generatedToOriginal(scriptId, loc.lineNumber, loc.columnNumber ?? 0)
      ));

      const targets: DebugProtocol.StepInTarget[] = locsToUse.map((loc, idx) => {
        const original = originals[idx];
        const targetId = idx + 1;
        this.stepInTargetLocations.set(targetId, loc);

        let label: string;
        if (original) {
          const name = original.source.split('/').pop();
          label = callLocations.length > 0
            ? `Call at ${name}:${original.line}:${original.column + 1}`
            : `${name}:${original.line}:${original.column + 1}`;
        } else {
          label = callLocations.length > 0
            ? `Call at line ${loc.lineNumber + 1}:${(loc.columnNumber ?? 0) + 1}`
            : `line ${loc.lineNumber + 1}:${(loc.columnNumber ?? 0) + 1}`;
        }

        return {
          id: targetId,
          label,
          line: original?.line,
          column: original ? original.column + 1 : undefined,
        };
      });

      response.body = { targets };
    } catch (e) {
      logger.debug(`stepInTargets failed: ${e}`);
      response.body = { targets: [] };
    }

    this.sendResponse(response);
  }

  protected async stepInRequest(
    response: DebugProtocol.StepInResponse,
    args: DebugProtocol.StepInArguments
  ): Promise<void> {
    this.lastStepAction = 'stepInto';
    this.smartStepCount = 0;
    if (this.cdp) {
      if (args.targetId && this.stepInTargetLocations.has(args.targetId)) {
        const loc = this.stepInTargetLocations.get(args.targetId)!;
        try {
          // Set a temporary breakpoint at the target location and resume
          const bp = await this.cdp.setBreakpoint({
            scriptId: loc.scriptId,
            lineNumber: loc.lineNumber,
            columnNumber: loc.columnNumber,
          });
          this.tempBreakpointId = bp.breakpointId;
          await this.cdp.resume();
        } catch (e) {
          logger.debug(`stepIn with targetId failed, falling back to normal stepInto: ${e}`);
          await this.cdp.stepInto();
        }
      } else {
        await this.cdp.stepInto();
      }
    }
    this.sendResponse(response);
  }

  protected async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    _args: DebugProtocol.StepOutArguments
  ): Promise<void> {
    this.lastStepAction = 'stepOut';
    this.smartStepCount = 0;
    if (this.cdp) {
      await this.cdp.stepOut();
    }
    this.sendResponse(response);
  }

  protected async pauseRequest(
    response: DebugProtocol.PauseResponse,
    _args: DebugProtocol.PauseArguments
  ): Promise<void> {
    if (this.cdp) {
      const targetId = this.cdp.activeTargetId;
      if (targetId) this.requestedPauseTargets.add(targetId);
      try {
        await this.cdp.pause(targetId);
      } catch (error) {
        if (targetId) this.requestedPauseTargets.delete(targetId);
        throw error;
      }
    }
    this.sendResponse(response);
  }

  // --- Source ---

  protected async sourceRequest(
    response: DebugProtocol.SourceResponse,
    args: DebugProtocol.SourceArguments
  ): Promise<void> {
    const sourceRef = args.sourceReference;
    const scriptId = this.sourceRefToScriptId.get(sourceRef);

    if (!scriptId || !this.cdp) {
      this.sendErrorResponse(response, 2002, 'Source not available');
      return;
    }

    try {
      // Prefer the original source file from disk over compiled JS
      if (this.sourceMapResolver) {
        const primarySource = this.sourceMapResolver.getPrimarySourceForScript(scriptId);
        if (primarySource) {
          try {
            const fs = await import('fs');
            const content = await fs.promises.readFile(primarySource, 'utf-8');
            response.body = {
              content,
              mimeType: primarySource.endsWith('.tsx') || primarySource.endsWith('.ts')
                ? 'text/typescript' : 'text/javascript',
            };
            this.sendResponse(response);
            return;
          } catch {
            // File doesn't exist on disk — fall through to CDP source
          }
        }
      }

      // Fallback: return the compiled JS from Chrome
      const source = await this.cdp.getScriptSource(scriptId);
      response.body = {
        content: source,
        mimeType: 'text/javascript',
      };
      this.sendResponse(response);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.sendErrorResponse(response, 2003, `Failed to get source: ${msg}`);
    }
  }

  // --- Loaded Sources ---

  protected async loadedSourcesRequest(
    response: DebugProtocol.LoadedSourcesResponse,
    _args: DebugProtocol.LoadedSourcesArguments
  ): Promise<void> {
    // Resolve every script's file existence in parallel — was O(N) sync stats
    // inside a for-loop that blocked the event loop on large projects.
    const entries = [...this.knownScriptUrls]
      .filter(([url]) => !(url.includes('/@vite/') || url.includes('/@react-refresh') || url.includes('__vite_')));

    const sources: DebugProtocol.Source[] = await Promise.all(
      entries.map(([url, scriptId]) => this.createSourceForScript(url, scriptId))
    );

    response.body = { sources };
    this.sendResponse(response);
  }

  // --- Disconnect ---

  protected async disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    _args: DebugProtocol.DisconnectArguments
  ): Promise<void> {
    await this.cleanup();
    this.sendResponse(response);
  }

  // --- Custom Requests ---

  /**
   * Handle extension-specific DAP requests. Used for the React component tree
   * view to evaluate expressions and get values back directly (bypassing the
   * preview-oriented Variables conversion used by the DAP `evaluate` request).
   */
  protected async customRequest(
    command: string,
    response: DebugProtocol.Response,
    args: McpCustomRequestArguments | undefined,
  ): Promise<void> {
    if (command === 'viteDebugger.evalForValue') {
      if (!this.cdp) {
        response.success = false;
        response.message = 'Debug session not connected';
        this.sendResponse(response);
        return;
      }
      const expression = args?.expression;
      if (typeof expression !== 'string') {
        response.success = false;
        response.message = 'Missing expression argument';
        this.sendResponse(response);
        return;
      }
      try {
        const value = args?.cacheKey
          ? await this.runCompiledOrEval(args.cacheKey, expression)
          : await this.cdp.evaluateForValue(expression);
        response.body = { value };
        this.sendResponse(response);
      } catch (e) {
        response.success = false;
        response.message = e instanceof Error ? e.message : String(e);
        this.sendResponse(response);
      }
      return;
    }

    if (command === 'viteDebugger.mcp') {
      const method = args?.method;
      if (typeof method !== 'string' || method.length === 0) {
        response.success = false;
        response.message = 'Missing MCP method argument';
        this.sendResponse(response);
        return;
      }

      try {
        const result = await this.handleMcpRequest(method, args?.params);
        // VS Code's customRequest() already resolves to response.body. Keep the
        // method result direct so the bridge does not create nested envelopes.
        response.body = result;
      } catch (e) {
        response.success = false;
        response.message = this.truncateMcpText(
          e instanceof Error ? e.message : String(e),
          1000,
        );
      }
      this.sendResponse(response);
      return;
    }
    super.customRequest(command, response, args as never);
  }

  /** Dispatch the narrow, structured API consumed by the MCP bridge. */
  private async handleMcpRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'status':
        return this.buildMcpStatus();
      case 'ensureBrowserTarget':
        return this.handleMcpEnsureBrowserTarget();
      case 'snapshot':
        return this.buildMcpSnapshot(params);
      case 'control':
        return this.handleMcpControl(params);
      case 'evaluate':
        return this.handleMcpEvaluate(params);
      case 'replaceBreakpoints':
        return this.handleMcpReplaceBreakpoints(params);
      default:
        throw new Error(`Unknown MCP method: ${this.truncateMcpText(method, 100)}`);
    }
  }

  /** Recreate the managed Vite page after it was closed, without exposing raw CDP to MCP. */
  private async handleMcpEnsureBrowserTarget(): Promise<object> {
    const chromePort = this.activeChromePort;
    const viteUrl = this.viteServer?.url;
    const pageUrl = this.viteServer?.pageUrl ?? viteUrl;
    if (!this.cdp?.isConnected || chromePort === null || !viteUrl || !pageUrl) {
      throw new Error('The Vite debug session is not connected to Chrome');
    }
    if (this.mcpPausedTargets.size > 0) {
      throw new Error('Cannot open a browser target while JavaScript is paused; resume execution first');
    }

    const result = await this.ensureManagedViteTarget(chromePort);
    if (result.created) {
      this.sendEvent(new OutputEvent(`Reopened Vite app tab for browser automation: ${pageUrl}\n`, 'console'));
    }
    return {
      targetId: result.targetId,
      created: result.created,
      url: this.sanitizeMcpUrl(pageUrl),
    };
  }

  private buildMcpStatus(): object {
    const targets = (this.cdp?.listTargets() ?? []).map((target) => ({
      targetId: target.targetId,
      type: target.type,
      title: this.truncateMcpText(target.title || '(untitled)', 200),
      url: this.sanitizeMcpUrl(target.url),
      active: target.active,
      primary: target.primary,
      paused: target.paused,
    }));

    const activePause = this.selectMcpPausedTarget();
    const pausedTargetIds = [...this.mcpPausedTargets.values()]
      .sort((a, b) => a.pauseEpoch - b.pauseEpoch)
      .map((state) => state.targetId);
    const localTlsCertificateBypass = this.viteServer?.localTlsCertificateBypass === true;

    return {
      connected: this.cdp?.isConnected ?? false,
      viteUrl: this.viteServer ? this.sanitizeMcpUrl(this.viteServer.url) : null,
      pageUrl: this.viteServer
        ? this.sanitizeMcpUrl(this.viteServer.pageUrl ?? this.viteServer.url)
        : null,
      localTlsCertificateBypass,
      tlsCertificateWarning: localTlsCertificateBypass
        ? 'The Vite certificate was accepted by Node only after the hostname resolved exclusively to loopback. ' +
          'Open the Vite URL once in this project-owned debug Chrome profile and trust the local certificate, ' +
          'or install its local CA in Chrome/OS, before browser automation.'
        : null,
      chromePort: this.activeChromePort,
      paused: pausedTargetIds.length > 0,
      pauseReason: activePause?.reason ?? null,
      pauseEpoch: this.pauseEpoch,
      activeTargetId: this.cdp?.activeTargetId ?? null,
      pauseTargetId: activePause?.targetId ?? null,
      pausedTargetIds,
      targets,
    };
  }

  /**
   * Return a bounded pause snapshot. Values are shallow previews only: object
   * ids and connection/session ids never leave the adapter, obvious credential
   * fields are redacted, and every collection/string has a hard limit.
   */
  private async buildMcpSnapshot(params: unknown): Promise<object> {
    const input = this.asMcpRecord(params);
    const requestedTargetId = this.optionalMcpString(input.targetId, 'targetId', 200);
    const frameLimit = this.boundedMcpInteger(
      input.frameLimit ?? input.maxFrames,
      MCP_MAX_FRAMES,
      1,
      MCP_MAX_FRAMES,
    );
    const variableLimit = this.boundedMcpInteger(
      input.variableLimit ?? input.maxVariables,
      MCP_MAX_VARIABLES_PER_SCOPE,
      1,
      MCP_MAX_VARIABLES_PER_SCOPE,
    );

    if (requestedTargetId && !this.cdp?.listTargets().some((item) => item.targetId === requestedTargetId)) {
      throw new Error(`Unknown or unmanaged Chrome target: ${requestedTargetId}`);
    }

    // With no targetId, snapshot follows Chrome's active paused target (the
    // most recently paused tab). With targetId it is strictly target-scoped:
    // asking for a running tab returns paused:false even if another tab is
    // paused.
    const pauseState = requestedTargetId
      ? this.mcpPausedTargets.get(requestedTargetId)
      : this.selectMcpPausedTarget();

    if (!pauseState) {
      return {
        paused: false,
        pauseEpoch: this.pauseEpoch,
        targetId: requestedTargetId ?? null,
        reason: null,
        ready: false,
        frames: [],
        scopes: [],
      };
    }

    const frames = pauseState.resolvedFrames.slice(0, frameLimit).map(({ dapFrame }) => ({
      name: this.truncateMcpText(dapFrame.name || '(anonymous)', 300),
      source: dapFrame.source ? {
        name: this.truncateMcpText(dapFrame.source.name ?? '', 300),
        path: dapFrame.source.path
          ? this.truncateMcpText(dapFrame.source.path, 4096)
          : null,
      } : null,
      line: dapFrame.line,
      column: dapFrame.column,
      presentationHint: dapFrame.presentationHint ?? null,
    }));

    const topFrame = pauseState.resolvedFrames[0]?.cdpCallFrame;
    const eligibleScopes = (topFrame?.scopeChain ?? []).filter((scope) =>
      scope.type !== 'global' && scope.type !== 'script' && scope.type !== 'module'
    );
    const selectedScopes = eligibleScopes.slice(0, MCP_MAX_SCOPES);
    const scopes = await Promise.all(selectedScopes.map(async (scope) => {
      const objectId = scope.object.objectId;
      if (!this.cdp || !objectId) {
        return {
          name: this.mcpScopeName(scope.type, scope.name),
          type: scope.type,
          variables: [],
          truncated: false,
        };
      }

      try {
        const properties = await this.withTimeout(
          this.cdp.getProperties(objectId, true, pauseState.targetId),
          750,
        );
        const visible = properties.filter((property) => property.name !== '__proto__' && property.value);
        return {
          name: this.mcpScopeName(scope.type, scope.name),
          type: scope.type,
          variables: visible.slice(0, variableLimit).map((property) =>
            this.summarizeMcpVariable(property.name, property.value!)
          ),
          truncated: visible.length > variableLimit,
        };
      } catch {
        return {
          name: this.mcpScopeName(scope.type, scope.name),
          type: scope.type,
          variables: [],
          truncated: false,
          unavailable: true,
        };
      }
    }));

    return {
      paused: true,
      pauseEpoch: pauseState.pauseEpoch,
      targetId: pauseState.targetId,
      reason: pauseState.reason,
      hitBreakpoints: (pauseState.pausedEvent.hitBreakpoints ?? [])
        .slice(0, 20)
        .map((id) => this.truncateMcpText(id, 200)),
      ready: frames.length > 0,
      frames,
      scopes,
      truncated: {
        frames: pauseState.resolvedFrames.length > frameLimit,
        scopes: eligibleScopes.length > MCP_MAX_SCOPES,
      },
    };
  }

  private async handleMcpControl(params: unknown): Promise<object> {
    if (!this.cdp?.isConnected) throw new Error('Debug session not connected');
    const input = this.asMcpRecord(params);
    const rawAction = this.requiredMcpString(input.action, 'action', 40);
    const aliases: Record<string, McpControlAction> = {
      pause: 'pause',
      continue: 'continue',
      resume: 'continue',
      step_over: 'step_over',
      stepOver: 'step_over',
      step_into: 'step_into',
      stepInto: 'step_into',
      step_out: 'step_out',
      stepOut: 'step_out',
      reload: 'reload',
    };
    const action = aliases[rawAction];
    if (!action) throw new Error(`Unsupported control action: ${rawAction}`);

    const requestedTargetId = this.optionalMcpString(input.targetId, 'targetId', 200);
    const targets = this.cdp.listTargets();
    if (requestedTargetId && !targets.some((target) => target.targetId === requestedTargetId)) {
      throw new Error(`Unknown or unmanaged Chrome target: ${requestedTargetId}`);
    }

    const requiresPausedTarget = action === 'continue'
      || action === 'step_over'
      || action === 'step_into'
      || action === 'step_out';
    const defaultPausedTarget = this.selectMcpPausedTarget()?.targetId;
    const targetId = requestedTargetId
      ?? (requiresPausedTarget ? defaultPausedTarget : this.cdp.activeTargetId);

    if (requiresPausedTarget && (!targetId || !this.mcpPausedTargets.has(targetId))) {
      throw new Error(
        requestedTargetId
          ? `Chrome target is not paused: ${requestedTargetId}`
          : 'No paused Chrome target is available for this action',
      );
    }

    switch (action) {
      case 'pause':
        this.lastStepAction = null;
        this.smartStepCount = 0;
        if (targetId) this.requestedPauseTargets.add(targetId);
        try {
          await this.cdp.pause(targetId);
        } catch (error) {
          if (targetId) this.requestedPauseTargets.delete(targetId);
          throw error;
        }
        break;
      case 'continue':
        this.lastStepAction = null;
        this.smartStepCount = 0;
        await this.cdp.resume(targetId);
        break;
      case 'step_over':
        this.lastStepAction = 'stepOver';
        this.smartStepCount = 0;
        await this.cdp.stepOver(targetId);
        break;
      case 'step_into':
        this.lastStepAction = 'stepInto';
        this.smartStepCount = 0;
        await this.cdp.stepInto(targetId);
        break;
      case 'step_out':
        this.lastStepAction = 'stepOut';
        this.smartStepCount = 0;
        await this.cdp.stepOut(targetId);
        break;
      case 'reload':
        // Preserve the existing "reload all Vite tabs" behaviour when no
        // targetId is supplied; all other actions resolve one concrete target.
        await this.cdp.reload(input.ignoreCache === true, requestedTargetId);
        break;
    }

    return {
      accepted: true,
      action,
      targetId: action === 'reload' ? requestedTargetId ?? null : targetId ?? null,
      pauseEpoch: this.pauseEpoch,
    };
  }

  /** Evaluate in one paused frame without exposing CDP object or session ids. */
  private async handleMcpEvaluate(params: unknown): Promise<object> {
    if (!this.cdp?.isConnected) throw new Error('Debug session not connected');
    const input = this.asMcpRecord(params);
    const expression = this.requiredMcpString(
      input.expression,
      'expression',
      MCP_MAX_EVALUATION_EXPRESSION_LENGTH,
    );
    const requestedTargetId = this.optionalMcpString(input.targetId, 'targetId', 200);
    const frameIndex = input.frameIndex === undefined ? 0 : input.frameIndex;
    if (!Number.isInteger(frameIndex) || (frameIndex as number) < 0 || (frameIndex as number) >= MCP_MAX_FRAMES) {
      throw new Error(`frameIndex must be an integer between 0 and ${MCP_MAX_FRAMES - 1}`);
    }
    const requestedPauseEpoch = input.pauseEpoch;
    if (requestedPauseEpoch !== undefined &&
        (!Number.isInteger(requestedPauseEpoch) || (requestedPauseEpoch as number) < 0)) {
      throw new Error('pauseEpoch must be a non-negative integer');
    }
    const allowSideEffects = input.allowSideEffects ?? false;
    if (typeof allowSideEffects !== 'boolean') {
      throw new Error('allowSideEffects must be a boolean');
    }
    const pauseState = requestedTargetId
      ? this.mcpPausedTargets.get(requestedTargetId)
      : this.selectMcpPausedTarget();
    if (!pauseState) {
      throw new Error(
        requestedTargetId
          ? `Chrome target is not paused: ${requestedTargetId}`
          : 'No paused Chrome target is available for evaluation',
      );
    }
    if (requestedPauseEpoch !== undefined && requestedPauseEpoch !== pauseState.pauseEpoch) {
      throw new Error(
        `Stale pauseEpoch ${requestedPauseEpoch}; current pauseEpoch is ${pauseState.pauseEpoch}`,
      );
    }
    const frame = pauseState.resolvedFrames[frameIndex as number]?.cdpCallFrame;
    if (!frame) {
      throw new Error(
        `Paused frame ${frameIndex} is unavailable; the snapshot has ${pauseState.resolvedFrames.length} frame(s)`,
      );
    }

    const result = await this.withTimeout(
      this.cdp.evaluateOnCallFrame(
        frame.callFrameId,
        expression,
        false,
        pauseState.targetId,
        { throwOnSideEffect: !allowSideEffects, timeoutMs: 1_000 },
      ),
      2_000,
    );
    if (this.mcpPausedTargets.get(pauseState.targetId) !== pauseState) {
      throw new Error('Debugger pause changed while the expression was being evaluated');
    }
    return {
      targetId: pauseState.targetId,
      pauseEpoch: pauseState.pauseEpoch,
      frameIndex: frameIndex as number,
      result: this.summarizeMcpVariable('result', result),
    };
  }

  private async handleMcpReplaceBreakpoints(params: unknown): Promise<object> {
    if (!this.breakpointManager) throw new Error('Debug session not connected');
    const input = this.asMcpRecord(params);
    const sourcePath = this.requiredMcpString(input.sourcePath ?? input.source, 'sourcePath', 4096);
    if (sourcePath.includes('\0')) throw new Error('sourcePath contains a null byte');
    if (!Array.isArray(input.breakpoints)) throw new Error('breakpoints must be an array');
    if (input.breakpoints.length > MCP_MAX_BREAKPOINTS) {
      throw new Error(`Too many breakpoints (maximum ${MCP_MAX_BREAKPOINTS})`);
    }

    const requested: DebugProtocol.SourceBreakpoint[] = input.breakpoints.map((value, index) => {
      const breakpoint = this.asMcpRecord(value, `breakpoints[${index}]`);
      const line = this.boundedMcpInteger(breakpoint.line, 0, 1, 1_000_000_000);
      if (line === 0) throw new Error(`breakpoints[${index}].line must be a positive integer`);
      const column = breakpoint.column === undefined
        ? undefined
        : this.boundedMcpInteger(breakpoint.column, 0, 1, 1_000_000_000);
      if (breakpoint.column !== undefined && column === 0) {
        throw new Error(`breakpoints[${index}].column must be a positive integer`);
      }
      return {
        line,
        column,
        condition: this.optionalMcpString(breakpoint.condition, `breakpoints[${index}].condition`, 4096),
        hitCondition: this.optionalMcpString(breakpoint.hitCondition, `breakpoints[${index}].hitCondition`, 200),
        logMessage: this.optionalMcpString(breakpoint.logMessage, `breakpoints[${index}].logMessage`, 4096),
      };
    });

    const breakpoints = await this.breakpointManager.setBreakpoints(sourcePath, requested, 'agent');
    if (requested.length > 0 && breakpoints.some((breakpoint) => !breakpoint.verified)) {
      this.tryProactiveModuleLoad(sourcePath).catch(() => undefined);
    }

    return {
      ownership: 'agent',
      sourcePath,
      breakpoints: breakpoints.map((breakpoint) => ({
        id: breakpoint.id,
        verified: breakpoint.verified,
        line: breakpoint.line,
        column: breakpoint.column ?? null,
        message: breakpoint.message
          ? this.truncateMcpText(breakpoint.message, 500)
          : null,
      })),
    };
  }

  private summarizeMcpVariable(name: string, value: RemoteObject): object {
    const safeName = this.truncateMcpText(name, 300);
    if (this.isSensitiveMcpName(name)) {
      return { name: safeName, type: value.type, value: '[REDACTED]', redacted: true };
    }

    let preview: string;
    switch (value.type) {
      case 'undefined':
        preview = 'undefined';
        break;
      case 'string':
        preview = JSON.stringify(value.value ?? '');
        break;
      case 'boolean':
      case 'number':
      case 'bigint':
        preview = String(value.value ?? value.description ?? value.type);
        break;
      case 'function':
        preview = value.className ? `[Function ${value.className}]` : '[Function]';
        break;
      case 'object':
        preview = value.subtype === 'null'
          ? 'null'
          : value.preview?.description ?? value.description ?? value.className ?? value.subtype ?? 'Object';
        break;
      default:
        preview = value.description ?? String(value.value ?? value.type);
        break;
    }

    return {
      name: safeName,
      type: value.type,
      subtype: value.subtype ?? null,
      value: this.truncateMcpText(preview, MCP_MAX_VALUE_LENGTH),
      expandable: Boolean(value.objectId),
    };
  }

  private mcpScopeName(type: string, name?: string): string {
    return this.truncateMcpText(name ? `${type} (${name})` : type, 300);
  }

  private isSensitiveMcpName(name: string): boolean {
    return /(?:pass(?:word|wd)?|secret|token|api[-_]?key|auth(?:orization)?|cookie|credential|private[-_]?key|bearer|jwt|session[-_]?id)/i.test(name);
  }

  private sanitizeMcpUrl(raw: string): string {
    const bounded = this.truncateMcpText(raw, 4096);
    try {
      const url = new URL(bounded);
      url.username = '';
      url.password = '';
      const keys = [...new Set(url.searchParams.keys())];
      url.search = '';
      for (const key of keys.slice(0, 30)) url.searchParams.append(key, '[redacted]');
      url.hash = '';
      return this.truncateMcpText(url.toString(), 4096);
    } catch {
      return bounded.split(/[?#]/, 1)[0];
    }
  }

  private truncateMcpText(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
  }

  private asMcpRecord(value: unknown, label: string = 'params'): Record<string, unknown> {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
  }

  private requiredMcpString(value: unknown, label: string, maxLength: number): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${label} must be a non-empty string`);
    }
    if (value.length > maxLength) throw new Error(`${label} is too long`);
    return value;
  }

  private optionalMcpString(value: unknown, label: string, maxLength: number): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new Error(`${label} must be a string`);
    if (value.length > maxLength) throw new Error(`${label} is too long`);
    return value;
  }

  private boundedMcpInteger(value: unknown, fallback: number, min: number, max: number): number {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      return fallback;
    }
    return value;
  }

  /**
   * Run a cached compiled script if we have one; otherwise compile (once) and
   * run. Falls back to Runtime.evaluate if persistent compilation isn't
   * available (older Chrome) or the cached scriptId got invalidated by a page
   * navigation — on the next call we'll recompile.
   */
  private async runCompiledOrEval(cacheKey: string, expression: string): Promise<unknown> {
    if (!this.cdp) throw new Error('Not connected');
    const cached = this.compiledScripts.get(cacheKey);
    if (cached) {
      try {
        return await this.cdp.runCompiledScript(cached);
      } catch {
        this.compiledScripts.delete(cacheKey);
      }
    }
    try {
      const scriptId = await this.cdp.compileScript(expression);
      this.compiledScripts.set(cacheKey, scriptId);
      return await this.cdp.runCompiledScript(scriptId);
    } catch {
      // compileScript / runScript not available — fall back to plain evaluate.
      return this.cdp.evaluateForValue(expression);
    }
  }

  // --- CDP Event Handlers ---

  private async onScriptParsed(params: ScriptParsedEvent, sessionId?: string): Promise<void> {
    if (!params.url || !params.sourceMapURL) return;

    // Normalize for HMR detection — Vite's ?v=/?t= change on every reload.
    const normalizedUrl = normalizeViteUrl(params.url);

    // HMR is detected per-tab (session): within ONE tab, the same url getting a
    // new scriptId means the module was hot-replaced. Across tabs the same url
    // naturally parses under different scriptIds — that is NOT an HMR event, and
    // a global url->scriptId map would misfire a full breakpoint re-resolution
    // every time a second tab loads.
    const sessionKey = sessionId ?? '';
    let perSession = this.hmrScriptUrlsBySession.get(sessionKey);
    if (!perSession) {
      perSession = new Map();
      this.hmrScriptUrlsBySession.set(sessionKey, perSession);
    }
    const previousScriptId = perSession.get(normalizedUrl);
    const isHmrReload = previousScriptId !== undefined && previousScriptId !== params.scriptId;
    perSession.set(normalizedUrl, params.scriptId);

    // Global url -> latest scriptId (deduped by url across tabs), used by
    // loadedSourcesRequest and console-message source resolution.
    this.knownScriptUrls.set(normalizedUrl, params.scriptId);
    this.scriptIdToUrl.set(params.scriptId, normalizedUrl);
    if (isHmrReload && previousScriptId) {
      this.scriptIdToUrl.delete(previousScriptId);
      this.unmappableScripts.delete(previousScriptId);
    }

    // Register source map: track metadata immediately, then load eagerly.
    // ensureSourceMap populates sourceToScripts which is needed for breakpoint resolution.
    if (this.sourceMapResolver) {
      if (isHmrReload) {
        this.sourceMapResolver.unregisterScript(previousScriptId);
      }
      this.sourceMapResolver.trackScript(params.scriptId, params.url, params.sourceMapURL);

      // Await source map load — needed for breakpoint resolution below.
      // If loading fails, onSourceMapLoaded callback won't fire, and retry timer
      // will handle it later.
      const loaded = await this.sourceMapResolver.ensureSourceMap(params.scriptId);
      if (!loaded) {
        logger.warn(`Source map not available for ${params.url} — breakpoints for this file will be pending`);
        // Schedule retry if there are pending breakpoints
        if (this.breakpointManager?.hasPendingBreakpoints()) {
          this.scheduleSourceMapRetry();
        }
      }
    }

    // Resolve pending breakpoints for this script
    // (onSourceMapLoaded callback handles the case where source map loads later via retry)
    if (this.breakpointManager && this.sourceMapResolver) {
      if (isHmrReload) {
        // Batch HMR events: collect script IDs and process after a short delay.
        // A single HMR cycle re-parses many scripts — batching avoids redundant
        // breakpoint remove/re-set cycles and eliminates log spam.
        this.pendingHmrScriptIds.push(params.scriptId);
        if (!this.hmrBatchTimer) {
          this.hmrBatchTimer = setTimeout(() => this.flushHmrBatch(), 100);
        }
      } else {
        const resolved = await this.breakpointManager.resolveBreakpointsForScript(params.scriptId, params.url);
        for (const bp of resolved) {
          if (bp.owner !== 'vscode') continue;
          this.sendEvent(new BreakpointEvent('changed', {
            id: bp.dapId,
            verified: true,
            line: bp.line,
          } as DebugProtocol.Breakpoint));
        }
      }
    }

    // Notify VSCode's Loaded Sources panel. Keep this shape identical to the
    // loadedSourcesRequest response so VSCode does not drop checksum state
    // after HMR and mark the top stack frame as modified/disabled.
    const loadedSource = await this.createSourceForScript(params.url, params.scriptId);
    this.sendEvent(new LoadedSourceEvent(isHmrReload ? 'changed' : 'new', loadedSource));
  }

  private async createSourceForScript(url: string, scriptId: string): Promise<DebugProtocol.Source> {
    const normalizedUrl = normalizeViteUrl(url);
    const source: DebugProtocol.Source = {
      name: normalizedUrl.split('/').pop() ?? normalizedUrl,
    };
    const filePath = this.urlMapper?.viteUrlToFilePath(url);

    if (filePath && await fileExistsCache.existsAsync(filePath)) {
      source.path = filePath;
      if (filePath.includes('/node_modules/')) {
        source.presentationHint = 'deemphasize';
      } else {
        const sha = await fileChecksumCache.sha256(filePath);
        if (sha) {
          source.checksums = [{ algorithm: 'SHA256', checksum: sha }];
        }
      }
    } else {
      const ref = this.nextSourceRef++;
      this.sourceRefToScriptId.set(ref, scriptId);
      source.sourceReference = ref;
    }

    return source;
  }

  /**
   * Process batched HMR script events. Collects all affected source paths
   * from the HMR cycle and handles breakpoints once, then logs a single summary.
   */
  private async flushHmrBatch(): Promise<void> {
    this.hmrBatchTimer = null;
    const scriptIds = this.pendingHmrScriptIds.splice(0);
    if (scriptIds.length === 0) return;
    if (!this.breakpointManager || !this.sourceMapResolver) return;

    // Collect all source file paths affected by this HMR cycle
    const affectedSourcePaths = new Set<string>();
    for (const scriptId of scriptIds) {
      const sources = this.sourceMapResolver.getSourcesForScript(scriptId);
      for (const s of sources) {
        affectedSourcePaths.add(s);
      }
    }

    if (affectedSourcePaths.size === 0) {
      // Still drain the changed-source set and prior snapshots so they
      // don't leak into a later batch where those paths aren't affected.
      this.sourceMapResolver.consumeChangedSources();
      this.sourceMapResolver.clearPriorSnapshots();
      return;
    }

    // User-edited sources need special handling: their stored bp.line is
    // pre-edit and cannot be re-mapped through the new source map without
    // landing on the wrong code. Defer re-resolving those until VSCode
    // sends an updated setBreakpoints.
    const changedSources = this.sourceMapResolver.consumeChangedSources();
    const editedSourcePaths = new Set<string>();
    for (const s of affectedSourcePaths) {
      if (changedSources.has(s)) editedSourcePaths.add(s);
    }

    const { resolved, unresolved, deferred } = await this.breakpointManager.handleHmrReload(
      affectedSourcePaths, editedSourcePaths,
    );
    for (const bp of resolved) {
      if (bp.owner !== 'vscode') continue;
      this.sendEvent(new BreakpointEvent('changed', {
        id: bp.dapId,
        verified: true,
        line: bp.line,
      } as DebugProtocol.Breakpoint));
    }
    for (const bp of unresolved) {
      if (bp.owner !== 'vscode') continue;
      this.sendEvent(new BreakpointEvent('changed', {
        id: bp.dapId,
        verified: false,
        line: bp.line,
        message: 'Breakpoint not resolved after HMR — source map position changed',
      } as DebugProtocol.Breakpoint));
    }
    for (const bp of deferred) {
      if (bp.owner !== 'vscode') continue;
      // Do NOT include `line` — the stored bp.line is the pre-edit snapshot
      // and emitting it would yank VSCode's marker back to the wrong row.
      // Omitting `line` signals verified:false without moving the marker;
      // the next setBreakpoints from VSCode carries the true new line.
      this.sendEvent(new BreakpointEvent('changed', {
        id: bp.dapId,
        verified: false,
        message: 'Breakpoint pending — waiting for editor to send updated line',
      } as DebugProtocol.Breakpoint));
    }
    if (resolved.length > 0 || unresolved.length > 0 || deferred.length > 0) {
      logger.info(
        `HMR reload: ${scriptIds.length} scripts, ${resolved.length} re-set, ` +
        `${unresolved.length} unresolved, ${deferred.length} deferred (edited)`,
      );
    }

    // Prior-content snapshots are only meaningful for THIS HMR cycle.
    // Drop them so subsequent non-HMR operations (or the next HMR cycle)
    // don't see stale "edited" state.
    this.sourceMapResolver.clearPriorSnapshots();
  }

  private async onPaused(params: PausedEvent, sessionId?: string): Promise<void> {
    // Update automation-visible state immediately. Frame/scope summaries are
    // populated later in this handler, before the DAP StoppedEvent is sent.
    const pauseTargetId = this.cdp?.targetIdForSession(sessionId)
      ?? this.cdp?.activeTargetId
      ?? null;
    this.paused = true;
    this.pauseReason = params.reason;
    const pauseEpoch = ++this.pauseEpoch;
    this.lastPausedEvent = params;
    this.lastPauseTargetId = pauseTargetId;
    this.resolvedFrames = [];

    const pauseState: McpPausedTargetState | null = pauseTargetId ? {
      targetId: pauseTargetId,
      sessionId,
      pauseEpoch,
      reason: params.reason,
      pausedEvent: params,
      resolvedFrames: [],
      callStackManager: null,
    } : null;
    if (pauseState) this.mcpPausedTargets.set(pauseState.targetId, pauseState);

    const pauseTopScriptId = params.callFrames[0]?.location.scriptId ?? '?';
    const topLoc = params.callFrames[0]?.location;
    logger.debug(`onPaused entered: reason=${params.reason} frames=${params.callFrames.length} topScript=${pauseTopScriptId} hitBps=${params.hitBreakpoints?.length ?? 0}`);

    // Diagnostic: map the pause position back to original source and
    // correlate any hitBreakpoints with our managed bps. When the user
    // reports "pause landed in react-dom", this log reveals whether (a)
    // CDP snapped our bp into an injected region whose source-map entry
    // points into a vendor file, or (b) the pause isn't from our bp at
    // all (exception, debugger stmt, etc.).
    if (topLoc && this.sourceMapResolver) {
      try {
        const mapped = await this.sourceMapResolver.generatedToOriginal(
          topLoc.scriptId, topLoc.lineNumber, topLoc.columnNumber ?? 0,
        );
        const hit = params.hitBreakpoints ?? [];
        const managed = this.breakpointManager?.getAllBreakpoints();
        const hitMatch: string[] = [];
        if (managed) {
          for (const [src, bps] of managed) {
            for (const b of bps) {
              if (b.cdpBreakpointId && hit.includes(b.cdpBreakpointId)) {
                hitMatch.push(`${src}:${b.line}(cdp=${b.cdpBreakpointId})`);
              }
            }
          }
        }
        logger.debug(
          `onPaused diag: genPos=${topLoc.scriptId}:${topLoc.lineNumber}:${topLoc.columnNumber ?? 0} ` +
          `mapsTo=${mapped ? `${mapped.source}:${mapped.line}:${mapped.column}` : 'null'} ` +
          `hitBps=[${hit.join(',')}] hitMatch=[${hitMatch.join(',')}]`
        );
      } catch (e) { logger.debug(`onPaused diag failed: ${e}`); }
    }

    // Clean up any temporary breakpoint from stepInTargets
    if (this.tempBreakpointId && this.cdp) {
      try { await this.cdp.removeBreakpoint(this.tempBreakpointId); } catch {}
      this.tempBreakpointId = null;
    }

    // Smart stepping: if we landed in non-user code, automatically step over
    // to reach user code. Works for both stepping and breakpoints hitting
    // injected wrapper code (e.g., @react-refresh _s() calls).
    const isException = params.reason === 'exception' || params.reason === 'promiseRejection';
    const isManualPause = params.reason === 'debugCommand'
      || (pauseTargetId !== null && this.requestedPauseTargets.delete(pauseTargetId));

    const isExplicitBreakpoint = params.reason === 'breakpoint' ||
      (params.reason === 'other' && params.hitBreakpoints && params.hitBreakpoints.length > 0);

    // Lazy source-map handshake for the top frame's script. If the script
    // declared a sourceMappingURL but the map hasn't finished loading yet,
    // wait briefly so the user sees the resolved original position (not a
    // minified line/column). If the script has no map and isn't synced to
    // disk, blackbox it so subsequent stepping skips through.
    logger.debug('onPaused: awaiting ensureTopFrameSourceMap');
    await this.ensureTopFrameSourceMap(params);
    logger.debug('onPaused: ensureTopFrameSourceMap done');

    if (!isException && !isManualPause && this.cdp && this.sourceMapResolver) {
      const shouldSkip = await this.shouldSmartStep(params, isExplicitBreakpoint);
      if (shouldSkip) {
        this.smartStepCount++;

        // If we've been smart-stepping too long, we're stuck in a library
        // loop (e.g., a minified bundle with sparse mappings, or React's
        // workLoopSync). Resume so the user reaches the next breakpoint
        // instead of being stranded at an arbitrary column inside minified
        // code. The user→library boundary stop inside shouldSmartStep
        // usually prevents this bailout from being reached for the common
        // JSX-return case — a stepOver out of a user component now pauses
        // at the first react-dom frame rather than burning through 20
        // library steps.
        if (this.smartStepCount > ViteDebugSession.MAX_SMART_STEPS) {
          logger.debug('Smart step limit reached, resuming to next breakpoint');
          this.smartStepCount = 0;
          this.lastStepAction = null;
          await this.cdp.resume(pauseTargetId ?? undefined);
          return;
        }

        // Log only at boundaries — 1st step, every 5th, and the bailout handled
        // above. Previously logged every iteration, which spammed the output
        // channel during React internal loops.
        if (this.smartStepCount === 1 || this.smartStepCount % 5 === 0) {
          const topLoc = params.callFrames[0]?.location;
          logger.debug(`Smart step #${this.smartStepCount}: skipping injected code (script ${topLoc?.scriptId}, line ${(topLoc?.lineNumber ?? 0) + 1}, cmd=${this.lastStepAction ?? 'stepOver'})`);
        }
        // Respect the user's original intent when skipping: if they asked to
        // stepInto, keep descending so a user callback invoked from inside
        // library code (e.g., React reconciler → user Component, useMemo
        // factory) is reached rather than stepped over. stepOut continues
        // stepping out. Otherwise fall back to stepOver for line-level skips.
        if (this.lastStepAction === 'stepInto') {
          await this.cdp.stepInto(pauseTargetId ?? undefined);
        } else if (this.lastStepAction === 'stepOut') {
          await this.cdp.stepOut(pauseTargetId ?? undefined);
        } else {
          await this.cdp.stepOver(pauseTargetId ?? undefined);
        }
        return;
      }
    }

    // Reset smart step state — we're stopping here
    this.lastStepAction = null;
    this.smartStepCount = 0;

    // Clear previous pause state
    this.scopeManager?.clear();
    this.variableManager?.clear();

    // sourceReference registrar: maps sourceRef → scriptId for sourceRequest
    const registerSourceRef: SourceRefRegistrar = (scriptId: string) => {
      const ref = this.nextSourceRef++;
      this.sourceRefToScriptId.set(ref, scriptId);
      return ref;
    };

    // Resolve call frames
    if (this.sourceMapResolver && this.urlMapper) {
      logger.debug(`onPaused: awaiting resolveCallFrames (${params.callFrames.length} frames)`);
      const rcfStart = Date.now();
      // Each paused target gets an isolated frame map. Sharing the DAP
      // CallStackManager here lets a second tab clear the first tab's frames
      // while it is still resolving.
      const pauseCallStackManager = new CallStackManager(this.sourceMapResolver, this.urlMapper);
      let pauseFrames: ResolvedCallFrame[] = [];
      try {
        pauseFrames = await pauseCallStackManager.resolveCallFrames(
          params.callFrames, registerSourceRef
        );
        await this.applyBreakpointSourceFallback(params, pauseFrames);
        logger.debug(`onPaused: resolveCallFrames done in ${Date.now() - rcfStart}ms (${pauseFrames.length} resolved)`);
      } catch (e) {
        logger.warn(`resolveCallFrames failed after ${Date.now() - rcfStart}ms, stopping with empty stack: ${e}`);
        pauseFrames = [];
      }

      // Frame/source resolution is asynchronous. The target may have resumed,
      // detached, or entered a newer pause while it was in flight. In that
      // case this handler no longer owns the target's visible pause and must
      // not resurrect its MCP snapshot or overwrite the shared DAP buffers.
      if (!this.isCurrentPauseState(pauseState, pauseTargetId, pauseEpoch, params)) {
        logger.debug(
          `Dropping stale pause before frame publish: target=${pauseTargetId ?? '?'} epoch=${pauseEpoch}`,
        );
        return;
      }

      if (pauseState) {
        pauseState.resolvedFrames = pauseFrames;
        pauseState.callStackManager = pauseCallStackManager;
      }

      // DAP still exposes one synthetic thread. Publish this pause into the
      // legacy buffers immediately before its StoppedEvent, preserving the
      // adapter's existing single-thread UI behaviour. MCP never reads these
      // shared buffers; it uses pauseState above.
      this.resolvedFrames = pauseFrames;
      this.callStackManager = pauseCallStackManager;

      // Enhance top frame with React component info. Bounded — Runtime.evaluate
      // can hang while the debugger is paused (awaitPromise + microtask
      // starvation), and React info is a nice-to-have. A stall here must not
      // block StoppedEvent or VS Code's debug UI will never activate.
      if (pauseFrames.length > 0 && this.cdp && this.lastPauseTargetId === pauseTargetId) {
        const drcStart = Date.now();
        try {
          await this.withTimeout(this.detectReactComponent(params.callFrames[0]), 800);
          logger.debug(`onPaused: detectReactComponent done in ${Date.now() - drcStart}ms`);
        } catch (e) {
          logger.warn(`detectReactComponent skipped after ${Date.now() - drcStart}ms: ${e}`);
        }
      }
    }

    // Determine stop reason
    let reason: string;
    if (isManualPause) {
      reason = 'pause';
    } else {
      switch (params.reason) {
        case 'breakpoint':
        case 'other':
          reason = params.hitBreakpoints?.length ? 'breakpoint' : 'step';
          break;
        case 'exception':
        case 'promiseRejection':
          reason = 'exception';
          break;
        case 'debugCommand':
          reason = 'pause';
          break;
        default:
          reason = 'step';
      }
    }

    const visiblePauseFrames = pauseState?.resolvedFrames ?? this.resolvedFrames;
    const top = visiblePauseFrames[0]?.dapFrame;
    logger.debug(
      `Sending StoppedEvent: reason=${reason} threadId=${THREAD_ID} frames=${visiblePauseFrames.length} ` +
      `top=${top ? `${top.source?.path ?? top.source?.name ?? '?'}:${top.line}` : 'none'}`
    );

    // React/source enrichment above also awaits. Revalidate before changing
    // any stop-related shared state or announcing the stop so an older handler
    // cannot emit a ghost StoppedEvent after the same target resumed or
    // replaced this epoch with a newer pause.
    if (!this.isCurrentPauseState(pauseState, pauseTargetId, pauseEpoch, params)) {
      logger.debug(
        `Dropping stale pause before StoppedEvent: target=${pauseTargetId ?? '?'} epoch=${pauseEpoch}`,
      );
      return;
    }

    // Snapshot the scriptId if this pause is in user code so the next
    // smart-step decision can detect a user→library frame transition (see
    // shouldSmartStep). Clear it on any non-user pause so that subsequent
    // smart-steps inside library code don't keep tripping the boundary.
    const topPath = top?.source?.path;
    const topScriptId = params.callFrames[0]?.location.scriptId ?? null;
    if (!pauseTargetId || this.lastPauseTargetId === pauseTargetId) {
      this.lastUserPauseScriptId =
        topPath && !topPath.includes('/node_modules/') && topScriptId
          ? topScriptId
          : null;
    }

    this.sendEvent(new StoppedEvent(reason, THREAD_ID));
  }

  /**
   * Whether an asynchronous onPaused invocation still owns its target pause.
   * Identity keeps concurrent pauses in different tabs independent, while the
   * epoch/event fallback covers the rare case where CDP cannot resolve a
   * target id for the event.
   */
  private isCurrentPauseState(
    pauseState: McpPausedTargetState | null,
    targetId: string | null,
    epoch: number,
    pausedEvent: PausedEvent,
  ): boolean {
    if (pauseState) {
      const current = this.mcpPausedTargets.get(pauseState.targetId);
      return current === pauseState
        && current.pauseEpoch === epoch
        && pauseState.pauseEpoch === epoch;
    }

    return this.paused
      && this.pauseEpoch === epoch
      && this.lastPauseTargetId === targetId
      && this.lastPausedEvent === pausedEvent;
  }

  private async applyBreakpointSourceFallback(
    params: PausedEvent,
    resolvedFrames: ResolvedCallFrame[] = this.resolvedFrames,
  ): Promise<void> {
    if (resolvedFrames.length === 0 || !this.breakpointManager) return;
    const hit = this.breakpointManager.getBreakpointForCdpHit(params.hitBreakpoints);
    if (!hit) return;

    const top = resolvedFrames[0].dapFrame;
    if (top.source?.path) return;

    const source: DebugProtocol.Source = {
      name: hit.sourcePath.split(/[\\/]/).pop() ?? hit.sourcePath,
      path: hit.sourcePath,
    };
    if (!hit.sourcePath.includes('/node_modules/')) {
      const sha = await fileChecksumCache.sha256(hit.sourcePath);
      if (sha) {
        source.checksums = [{ algorithm: 'SHA256', checksum: sha }];
      }
    }

    top.source = source;
    top.line = hit.line;
    top.column = hit.column ?? top.column;
    top.presentationHint = undefined;
    logger.debug(
      `Applied breakpoint source fallback for source-less pause: ` +
      `${hit.sourcePath}:${hit.line}:${hit.column ?? top.column}`,
    );
  }

  /**
   * Ensure the source map for the current pause's top frame is loaded before
   * we decide how to present / step this location. Handles two pain points:
   *
   * 1. **Lazy handshake**: Vite serves source maps on demand. If the map
   *    request is in flight when we pause, we'd otherwise surface a minified
   *    location to VS Code. Waiting briefly (bounded) gives the map a chance
   *    to land, so the user sees the original `.tsx` or `node_modules/.../X.js`
   *    file with the right line/column.
   *
   * 2. **Server-only scripts**: Some Vite-served scripts (e.g., `.vite/deps/
   *    chunk-*.js` that aren't shipped with source maps) have no local
   *    counterpart we can map to. For these we apply a per-script CDP
   *    blackbox so Chrome's native stepper skips them entirely — the user's
   *    next step-over/step-into continues past this frame instead of sitting
   *    in unreadable generated code.
   */
  private async ensureTopFrameSourceMap(params: PausedEvent): Promise<void> {
    if (!this.cdp || !this.sourceMapResolver) return;
    const topFrame = params.callFrames[0];
    if (!topFrame) return;
    const scriptId = topFrame.location.scriptId;

    // Already blackboxed — nothing more to do.
    if (this.unmappableScripts.has(scriptId)) return;

    const hasUrl = this.sourceMapResolver.hasSourceMapUrl(scriptId);
    const alreadyLoaded = this.sourceMapResolver.isSourceMapLoaded(scriptId);

    if (hasUrl && !alreadyLoaded) {
      // Bounded wait: prefer correctness (wait for map) but don't hang the
      // pause indefinitely if the server is slow.
      try {
        await this.withTimeout(
          this.sourceMapResolver.ensureSourceMap(scriptId),
          1500,
        );
      } catch {
        // Timeout or load error — fall through to the no-map branch below.
      }
    }

    // Still no map after the handshake attempt? Decide whether the script
    // can be surfaced locally or should be blackboxed as server-only.
    if (!this.sourceMapResolver.isSourceMapLoaded(scriptId)) {
      if (this.isServerOnlyScript(scriptId)) {
        await this.markScriptUnmappable(scriptId);
      }
    }
  }

  /** Race a promise against a timeout. Rejects if the timeout fires first. */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  /**
   * A script is "server-only" — i.e. can't be meaningfully shown to the user
   * without a source map — when:
   *   - Its URL has no resolvable local path, OR
   *   - It's a Vite runtime URL (@vite, @react-refresh, …), OR
   *   - Its local path is a pre-bundled artifact (node_modules, .vite/deps)
   *     whose on-disk file is the generated output rather than original source, OR
   *   - The local file simply doesn't exist.
   *
   * For user-authored files (src/**), we do NOT mark them server-only even
   * if the source map is missing — stepping can fall back to generated
   * line/column on the user's own file, which is still navigable.
   */
  private isServerOnlyScript(scriptId: string): boolean {
    const url = this.scriptIdToUrl.get(scriptId);
    if (!url) return true;
    if (this.urlMapper?.isViteInternalUrl(url)) return true;

    const local = this.urlMapper?.viteUrlToFilePath(url);
    if (!local) return true;

    // Pre-bundled / third-party artifact — unreadable without a source map.
    if (local.includes('/node_modules/')) return true;

    return !fileExistsCache.existsSync(local);
  }

  /**
   * Blackbox a single script at the CDP level so Chrome's stepping engine
   * skips it. Using ranges (rather than URL patterns) lets us target
   * specific scripts we've decided we can't resolve — without taking the
   * whole URL out of the debuggable set.
   */
  private async markScriptUnmappable(scriptId: string): Promise<void> {
    if (this.unmappableScripts.has(scriptId) || !this.cdp) return;
    this.unmappableScripts.add(scriptId);
    try {
      // Blackbox the entire script: range from (0, 0) to a very large line.
      // An odd-length positions array is also valid (open-ended), but we
      // send an explicit pair for clarity across CDP versions.
      await this.cdp.setBlackboxedRanges(scriptId, [
        { lineNumber: 0, columnNumber: 0 },
        { lineNumber: Number.MAX_SAFE_INTEGER, columnNumber: 0 },
      ]);
      const url = this.scriptIdToUrl.get(scriptId);
      logger.debug(`Blackboxed unmappable script ${scriptId}${url ? ` (${url})` : ''}`);
    } catch (e) {
      // Blackboxing is best-effort — smart-step will still skip via shouldSmartStep.
      logger.debug(`Failed to blackbox script ${scriptId}: ${e}`);
    }
  }

  /**
   * Determine if the current pause location is non-user code that should be skipped.
   *
   * Decision table (in order):
   *   1. Explicit breakpoint hit → never auto-skip.
   *   2. No source map AND script already marked unmappable → skip.
   *   3. Source map resolves to user code → stop (unless skipFiles matches).
   *   4. Cross-cutting rule — frame transition out of user code: if the last
   *      user-visible pause was in user code and its scriptId differs from
   *      the current one, we just crossed a frame boundary (e.g., returning
   *      from a user component into React's reconciler, or stepping into a
   *      JSX element). Pause once at the first landing point — whether it's
   *      mapped to node_modules or has no mapping at all. Applies to
   *      stepOver/stepInto/stepOut. Subsequent steps from the library frame
   *      don't retrigger because the pause at library sets
   *      lastUserPauseScriptId to null.
   *   5. Source map resolves to node_modules → skip (unless rule 4 fired).
   *   6. Source map exists but this position has no mapping → injected
   *      preamble (e.g. `_s()`) or sparse-map library internal. Skip.
   */
  private async shouldSmartStep(params: PausedEvent, isExplicitBreakpoint: boolean = false): Promise<boolean> {
    if (isExplicitBreakpoint) return false;
    if (params.callFrames.length === 0) return false;

    const topFrame = params.callFrames[0];
    const { scriptId, lineNumber, columnNumber } = topFrame.location;

    // Already-blackboxed unmappable script — get out of it.
    if (this.unmappableScripts.has(scriptId)) return true;

    // A step that crosses out of a user frame — regardless of whether the
    // landing position maps to node_modules or has no mapping at all (as
    // happens inside pre-bundled react-dom chunks) — should pause once so
    // the user sees where they ended up instead of silently running through
    // React internals (step budget exhaustion) or resurfacing in an unrelated
    // component's render (what looked like the debugger "jumping" for
    // JSX-return stepOver).
    const isFrameTransitionFromUserCode =
      this.lastUserPauseScriptId !== null &&
      this.lastUserPauseScriptId !== scriptId;

    if (this.sourceMapResolver && this.sourceMapResolver.hasSourceMap(scriptId)) {
      const original = await this.sourceMapResolver.generatedToOriginal(
        scriptId, lineNumber, columnNumber ?? 0
      );
      if (original) {
        if (original.source.includes('/node_modules/')) {
          if (isFrameTransitionFromUserCode) return false;
          return true;
        }

        // User-configured skipFiles patterns
        if (this.shouldSkipFile(original.source)) {
          logger.debug(`Skipping file (skipFiles match): ${original.source}`);
          return true;
        }

        // User code — stop here
        return false;
      }

      // Has source map but no mapping at this position → injected preamble,
      // OR we've landed deep inside a pre-bundled library chunk whose map is
      // sparse. If we just came out of user code, treat this as the library
      // boundary and pause.
      if (isFrameTransitionFromUserCode) return false;
      return true;
    }

    // No source map at all — the ensureTopFrameSourceMap helper should have
    // either loaded one or marked the script unmappable. If we got here with
    // neither, it's a transient state; don't auto-step.
    return false;
  }

  /**
   * Check if a source file path matches any of the user-configured skipFiles patterns.
   * Patterns are precompiled to regex in launch/attachRequest via compileGlob().
   */
  private shouldSkipFile(filePath: string): boolean {
    if (this.skipFileRegexes.length === 0) return false;
    const normalized = filePath.replace(/\\/g, '/');
    for (const re of this.skipFileRegexes) {
      if (re.test(normalized)) return true;
    }
    return false;
  }


  /**
   * Detect React component info when paused.
   *
   * A naive implementation runs three strategies (class → fiber → funcName)
   * sequentially, each doing an `evaluateOnCallFrame`, then more calls to
   * fetch props/hooks — 3-5 round-trips per pause. We collapse the detection
   * into ONE evaluate that reports which strategy won, then fetch props and
   * hooks in parallel. Worst case: 1 detect + 2 parallel fetches ≈ 2 RTTs.
   */
  private async detectReactComponent(topFrame: import('../cdp/CdpTypes').CallFrame): Promise<void> {
    this.reactComponentName = null;
    this.reactComponentObjectId = null;
    this.reactHooksObjectId = null;

    if (!this.cdp) return;
    const cdp = this.cdp;

    try {
      // Single detection call: try class → fiber → funcName in-page, report winner.
      // Must use evaluateOnCallFrame (not Runtime.evaluate) — the latter with
      // `awaitPromise: true` can hang indefinitely while the debugger is
      // paused, preventing StoppedEvent from ever being sent.
      const funcName = topFrame.functionName;
      const detectResult = await cdp.evaluateOnCallFrameForValue<{ kind: 'class' | 'fiber' | 'funcName' | null; name: string | null }>(
        topFrame.callFrameId,
        `(() => {
          try {
            if (this && this.props && this.constructor && this.constructor.name) {
              return { kind: 'class', name: this.constructor.name };
            }
          } catch {}
          try {
            const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (hook && hook.renderers) {
              for (const [, renderer] of hook.renderers) {
                const fiber = renderer.getCurrentFiber ? renderer.getCurrentFiber() : null;
                if (fiber) {
                  const name = fiber.type && (fiber.type.displayName || fiber.type.name);
                  if (name || fiber.memoizedProps) {
                    return { kind: 'fiber', name: name || null };
                  }
                }
              }
            }
          } catch {}
          ${funcName && /^[A-Z]/.test(funcName)
            ? `return { kind: 'funcName', name: ${JSON.stringify(funcName)} };`
            : `return { kind: null, name: null };`}
        })()`
      );

      const kind = detectResult?.kind ?? null;
      if (!kind) return;
      this.reactComponentName = detectResult?.name ?? null;

      // Fetch the component scope + hooks in parallel. Each uses a distinct
      // evaluate so we get back objectIds (for UI exploration).
      const scopeExpr = kind === 'class'
        ? `({ props: this.props, state: this.state })`
        : kind === 'fiber'
          ? `(() => {
              const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
              if (!hook || !hook.renderers) return {};
              for (const [, renderer] of hook.renderers) {
                const fiber = renderer.getCurrentFiber ? renderer.getCurrentFiber() : null;
                if (fiber && fiber.memoizedProps) return fiber.memoizedProps;
              }
              return {};
            })()`
          : `(() => {
              try {
                const args = typeof arguments !== 'undefined' ? arguments : null;
                if (args && args[0] && typeof args[0] === 'object') return args[0];
              } catch {}
              return null;
            })()`;

      const scopePromise = cdp.evaluateOnCallFrame(topFrame.callFrameId, scopeExpr, true);
      const hooksPromise = kind === 'class'
        ? Promise.resolve(null)
        : this.extractReactHooksObject(topFrame.callFrameId);

      const [scopeObj, hooksObjectId] = await Promise.all([scopePromise, hooksPromise]);
      if (scopeObj.type === 'object' && scopeObj.subtype !== 'null' && scopeObj.objectId) {
        this.reactComponentObjectId = scopeObj.objectId;
      }
      if (hooksObjectId) this.reactHooksObjectId = hooksObjectId;
    } catch (e) {
      logger.debug(`React component detection failed: ${e}`);
    }
  }

  /**
   * Build an explorable Hooks object from the current fiber and return its
   * objectId. Returns null if hooks are unavailable or the eval fails.
   */
  private async extractReactHooksObject(callFrameId: string): Promise<string | null> {
    if (!this.cdp) return null;
    try {
      const hooksObj = await this.cdp.evaluateOnCallFrame(
        callFrameId,
        `(() => {
          const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
          if (!hook || !hook.renderers) return null;
          for (const [, renderer] of hook.renderers) {
            const fiber = renderer.getCurrentFiber ? renderer.getCurrentFiber() : null;
            if (!fiber) continue;
            const types = fiber._debugHookTypes || [];
            const obj = {};
            let state = fiber.memoizedState;
            let i = 0;
            const counts = {};
            while (state) {
              const t = types[i] || 'unknown';
              counts[t] = (counts[t] || 0);
              const label = counts[t] > 0 ? t + '[' + counts[t] + ']' : t;
              counts[t]++;
              if (t === 'useRef') obj[label] = state.memoizedState ? state.memoizedState.current : undefined;
              else if (t === 'useMemo' || t === 'useCallback') obj[label] = state.memoizedState ? state.memoizedState[0] : undefined;
              else if (t === 'useEffect' || t === 'useLayoutEffect' || t === 'useInsertionEffect') obj[label] = { deps: state.memoizedState ? state.memoizedState.deps : null };
              else obj[label] = state.memoizedState;
              state = state.next;
              i++;
            }
            return obj;
          }
          return null;
        })()`,
        true
      );
      if (hooksObj.type === 'object' && hooksObj.subtype !== 'null' && hooksObj.objectId) {
        return hooksObj.objectId;
      }
    } catch (e) {
      logger.debug(`React hooks extraction failed: ${e}`);
    }
    return null;
  }

  private onConsoleAPICalled(params: ConsoleAPICalledEvent): void {
    const category = (params.type === 'error' || params.type === 'warn') ? 'stderr' : 'stdout';

    const formatted = params.args.map((arg: RemoteObject) => {
      if (arg.type === 'string') {
        return arg.value as string;
      }
      if (arg.type === 'undefined') {
        return 'undefined';
      }
      if (arg.type === 'object' && arg.subtype === 'null') {
        return 'null';
      }
      if (arg.value !== undefined) {
        return JSON.stringify(arg.value);
      }
      if (arg.description) {
        return arg.description;
      }
      return String(arg.value);
    }).join(' ');

    const event = new OutputEvent(formatted + '\n', category);

    // Resolve source location from stack trace if available
    if (params.stackTrace && params.stackTrace.callFrames.length > 0) {
      const topFrame = params.stackTrace.callFrames[0];
      if (topFrame.url && this.sourceMapResolver) {
        const scriptId = this.knownScriptUrls.get(normalizeViteUrl(topFrame.url));
        if (scriptId) {
          this.sourceMapResolver.generatedToOriginal(
            scriptId, topFrame.lineNumber, topFrame.columnNumber
          ).then(original => {
            if (original) {
              (event.body as DebugProtocol.OutputEvent['body']).source = {
                name: original.source.replace(/^.*[\\/]/, ''),
                path: original.source,
              };
              (event.body as DebugProtocol.OutputEvent['body']).line = original.line;
              (event.body as DebugProtocol.OutputEvent['body']).column = original.column;
            }
            this.sendEvent(event);
          }).catch(() => {
            this.sendEvent(event);
          });
          return;
        }
      }
    }

    this.sendEvent(event);
  }

  private onResumed(sessionId?: string): void {
    const resumedTargetId = this.cdp?.targetIdForSession(sessionId);
    if (resumedTargetId) {
      this.mcpPausedTargets.delete(resumedTargetId);
    } else if (sessionId) {
      this.removeMcpPausedSession(sessionId);
    }
    this.reconcileVisiblePauseState();
    this.sendEvent(new ContinuedEvent(THREAD_ID, true));
  }

  /** Pick the explicitly active pause, falling back to the latest epoch. */
  private selectMcpPausedTarget(): McpPausedTargetState | undefined {
    const activeTargetId = this.cdp?.activeTargetId;
    if (activeTargetId) {
      const active = this.mcpPausedTargets.get(activeTargetId);
      if (active) return active;
    }

    let latest: McpPausedTargetState | undefined;
    for (const state of this.mcpPausedTargets.values()) {
      if (!latest || state.pauseEpoch > latest.pauseEpoch) latest = state;
    }
    return latest;
  }

  private removeMcpPausedSession(sessionId: string): void {
    for (const [targetId, state] of this.mcpPausedTargets) {
      if (state.sessionId === sessionId) this.mcpPausedTargets.delete(targetId);
    }
    this.reconcileVisiblePauseState();
  }

  /**
   * Keep the legacy single-thread DAP buffers usable when one of several
   * paused tabs resumes. MCP state remains independently target-scoped.
   */
  private reconcileVisiblePauseState(): void {
    const selected = this.selectMcpPausedTarget();
    this.paused = !!selected;
    this.pauseReason = selected?.reason ?? null;
    this.lastPausedEvent = selected?.pausedEvent ?? null;
    this.lastPauseTargetId = selected?.targetId ?? null;
    this.resolvedFrames = selected?.resolvedFrames ?? [];
    if (selected?.callStackManager) this.callStackManager = selected.callStackManager;
    this.scopeManager?.clear();
    this.variableManager?.clear();
  }

  private onDisconnected(): void {
    this.viteTargetCreation = null;
    this.paused = false;
    this.pauseReason = null;
    this.lastPausedEvent = null;
    this.lastPauseTargetId = null;
    this.mcpPausedTargets.clear();
    this.requestedPauseTargets.clear();
    this.resolvedFrames = [];
    this.activeChromePort = null;
    this.sendEvent(new TerminatedEvent());
  }

  /**
   * Periodically retry failed source map loads.
   * Vite transforms modules on-demand, so the source map might not be available
   * immediately when Chrome first parses the script. Retrying after a delay
   * catches these cases.
   */
  private scheduleSourceMapRetry(): void {
    if (this.sourceMapRetryTimer) return;
    this.sourceMapRetryTimer = setTimeout(async () => {
      this.sourceMapRetryTimer = null;
      if (!this.sourceMapResolver?.hasFailedScripts()) return;
      if (!this.breakpointManager?.hasPendingBreakpoints()) return;

      logger.debug('Retrying failed source map loads...');
      await this.sourceMapResolver.retryFailed();

      // If there are still failures and pending breakpoints, schedule another retry
      if (this.sourceMapResolver.hasFailedScripts() && this.breakpointManager.hasPendingBreakpoints()) {
        this.scheduleSourceMapRetry();
      }
    }, 3000);
  }

  private async cleanup(): Promise<void> {
    this.viteTargetCreation = null;
    if (this.sourceMapRetryTimer) {
      clearTimeout(this.sourceMapRetryTimer);
      this.sourceMapRetryTimer = null;
    }
    if (this.hmrBatchTimer) {
      clearTimeout(this.hmrBatchTimer);
      this.hmrBatchTimer = null;
      this.pendingHmrScriptIds.length = 0;
    }
    this.sourceMapResolver?.clear();
    this.breakpointManager?.clear();
    this.networkBreakpointManager?.clear();
    this.networkBreakpointManager = null;
    this.callStackManager?.clear();
    this.scopeManager?.clear();
    this.variableManager?.clear();
    this.unmappableScripts.clear();
    this.compiledScripts.clear();
    this.proactivelyImportedUrls.clear();
    this.hmrScriptUrlsBySession.clear();

    if (this.cdp) {
      await this.cdp.disconnect();
      this.cdp = null;
    }
    this.activeChromePort = null;
    this.paused = false;
    this.pauseReason = null;
    this.lastPausedEvent = null;
    this.lastPauseTargetId = null;
    this.mcpPausedTargets.clear();
    this.requestedPauseTargets.clear();
    this.resolvedFrames = [];

    // Debug Chrome is a separate instance — we don't kill it on disconnect
    // so the user can keep using it for subsequent debug sessions
  }
}
