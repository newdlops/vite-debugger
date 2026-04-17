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
} from '../cdp/ChromeDiscovery';
import { detectFirstViteServer, ViteServerInfo } from '../vite/ViteServerDetector';
import { ViteUrlMapper } from '../vite/ViteUrlMapper';
import { SourceMapResolver, normalizeViteUrl } from '../sourcemap/SourceMapResolver';
import { fileExistsCache } from '../util/FileExists';
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
  chromePort?: number;
  webRoot?: string;
  sourceMapPathOverrides?: Record<string, string>;
  skipFiles?: string[];
}

interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
  viteUrl?: string;
  chromePort?: number;
  webRoot?: string;
  sourceMapPathOverrides?: Record<string, string>;
  skipFiles?: string[];
}

export class ViteDebugSession extends LoggingDebugSession {
  private cdp: CdpClient | null = null;
  private viteServer: ViteServerInfo | null = null;
  private urlMapper: ViteUrlMapper | null = null;
  private sourceMapResolver: SourceMapResolver | null = null;
  private breakpointManager: BreakpointManager | null = null;
  private callStackManager: CallStackManager | null = null;
  private scopeManager: ScopeManager | null = null;
  private variableManager: VariableManager | null = null;
  private evalHandler: EvalHandler | null = null;
  private networkBreakpointManager: NetworkBreakpointManager | null = null;

  private resolvedFrames: ResolvedCallFrame[] = [];
  private knownScriptUrls = new Map<string, string>();  // url -> latest scriptId
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
  private stepInTargetLocations = new Map<number, BreakLocation>();
  private tempBreakpointId: string | null = null;
  private sourceMapRetryTimer: NodeJS.Timeout | null = null;
  /** Precompiled regexes for user-configured skipFiles globs */
  private skipFileRegexes: RegExp[] = [];
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
      const chromePort = args.chromePort || 9222;
      this.skipFileRegexes = (args.skipFiles ?? []).map(compileGlob);

      // Step 1: Detect Vite server
      this.viteServer = await detectFirstViteServer(args.viteUrl);
      if (!this.viteServer) {
        this.sendErrorResponse(response, 1001, 'No running Vite dev server found. Start Vite first with `npm run dev`.');
        return;
      }
      logger.info(`Vite server found: ${this.viteServer.url}`);
      this.sendEvent(new OutputEvent(`Vite server: ${this.viteServer.url}\n`, 'console'));

      // Step 2: Find Chrome with debug port
      const activeChromePort = await this.ensureChromeDebugPort(chromePort);

      // Step 3: Connect
      await this.connectAndSetup(activeChromePort, webRoot);

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
      const chromePort = args.chromePort || 9222;
      this.skipFileRegexes = (args.skipFiles ?? []).map(compileGlob);

      // Detect Vite server
      this.viteServer = await detectFirstViteServer(args.viteUrl);
      if (!this.viteServer) {
        this.sendErrorResponse(response, 1001, 'No running Vite dev server found.');
        return;
      }
      logger.info(`Vite server found: ${this.viteServer.url}`);

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
    await launchDebugChrome(this.viteServer!.url, chromePort);
    return chromePort;
  }

  private async connectAndSetup(chromePort: number, webRoot: string): Promise<void> {
    // Initialize components
    const viteRoot = this.viteServer!.root;
    this.urlMapper = new ViteUrlMapper(this.viteServer!.url, webRoot, viteRoot);
    this.sourceMapResolver = new SourceMapResolver(webRoot, viteRoot);

    // Connect to Chrome
    this.cdp = await CdpClient.connect(chromePort, this.viteServer!.url);

    // Initialize managers (depends on cdp)
    this.breakpointManager = new BreakpointManager(this.cdp, this.sourceMapResolver, this.viteServer!.url);
    this.callStackManager = new CallStackManager(this.sourceMapResolver, this.urlMapper);
    this.scopeManager = new ScopeManager();
    this.variableManager = new VariableManager(this.cdp);
    this.evalHandler = new EvalHandler(this.cdp, this.variableManager);

    // Initialize network breakpoint manager
    this.networkBreakpointManager = new NetworkBreakpointManager(this.cdp);
    this.networkBreakpointManager.onMatch((_rule, _request) => {
      // Pause JS execution when a network breakpoint matches
      this.cdp?.pause();
    });

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

    // Set up CDP event handlers
    this.cdp.on('scriptParsed', (params: ScriptParsedEvent) => this.onScriptParsed(params));
    this.cdp.on('paused', (params: PausedEvent) => this.onPaused(params));
    this.cdp.on('resumed', () => this.onResumed());
    this.cdp.on('disconnected', () => this.onDisconnected());
    this.cdp.on('consoleAPICalled', (params: ConsoleAPICalledEvent) => this.onConsoleAPICalled(params));
    this.cdp.on('requestPaused', (params: FetchRequestPausedEvent) => this.networkBreakpointManager?.handleRequest(params));

    // Set exception breakpoint state
    await this.cdp.setPauseOnExceptions(this.exceptionBreakMode);

    // Schedule retry for failed source maps (Vite might not be ready for all modules immediately)
    this.scheduleSourceMapRetry();

    this.sendEvent(new OutputEvent('Connected to Chrome DevTools\n', 'console'));
  }

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    _args: DebugProtocol.ConfigurationDoneArguments
  ): void {
    this.sendResponse(response);
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
      await this.cdp.pause();
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

    const sources: DebugProtocol.Source[] = await Promise.all(entries.map(async ([url, scriptId]) => {
      const filePath = this.urlMapper?.viteUrlToFilePath(url);
      const source: DebugProtocol.Source = { name: url.split('/').pop() ?? url };

      if (filePath && await fileExistsCache.existsAsync(filePath)) {
        source.path = filePath;
      } else {
        const ref = this.nextSourceRef++;
        this.sourceRefToScriptId.set(ref, scriptId);
        source.sourceReference = ref;
      }

      if (url.includes('/node_modules/')) {
        source.presentationHint = 'deemphasize';
      }
      return source;
    }));

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
    args: { expression?: string; cacheKey?: string } | undefined,
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
    super.customRequest(command, response, args as never);
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

  private async onScriptParsed(params: ScriptParsedEvent): Promise<void> {
    if (!params.url || !params.sourceMapURL) return;

    // Normalize for HMR detection — Vite's ?v=/?t= change on every reload.
    const normalizedUrl = normalizeViteUrl(params.url);
    const previousScriptId = this.knownScriptUrls.get(normalizedUrl);
    const isHmrReload = previousScriptId !== undefined && previousScriptId !== params.scriptId;
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
          this.sendEvent(new BreakpointEvent('changed', {
            id: bp.dapId,
            verified: true,
            line: bp.line,
          } as DebugProtocol.Breakpoint));
        }
      }
    }

    // Notify VSCode's Loaded Sources panel
    const loadedSource: DebugProtocol.Source = { name: params.url.split('/').pop() ?? params.url };
    const filePath = this.urlMapper?.viteUrlToFilePath(params.url);
    if (filePath && await fileExistsCache.existsAsync(filePath)) {
      loadedSource.path = filePath;
    } else {
      const ref = this.nextSourceRef++;
      this.sourceRefToScriptId.set(ref, params.scriptId);
      loadedSource.sourceReference = ref;
    }
    this.sendEvent(new LoadedSourceEvent(isHmrReload ? 'changed' : 'new', loadedSource));
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

    if (affectedSourcePaths.size === 0) return;

    const { resolved, unresolved } = await this.breakpointManager.handleHmrReload(affectedSourcePaths);
    for (const bp of resolved) {
      this.sendEvent(new BreakpointEvent('changed', {
        id: bp.dapId,
        verified: true,
        line: bp.line,
      } as DebugProtocol.Breakpoint));
    }
    for (const bp of unresolved) {
      this.sendEvent(new BreakpointEvent('changed', {
        id: bp.dapId,
        verified: false,
        line: bp.line,
        message: 'Breakpoint not resolved after HMR — source map position changed',
      } as DebugProtocol.Breakpoint));
    }
    if (resolved.length > 0 || unresolved.length > 0) {
      logger.info(`HMR reload: ${scriptIds.length} scripts, ${resolved.length} breakpoints re-set, ${unresolved.length} unresolved`);
    }
  }

  private async onPaused(params: PausedEvent): Promise<void> {
    const pauseTopScriptId = params.callFrames[0]?.location.scriptId ?? '?';
    logger.debug(`onPaused entered: reason=${params.reason} frames=${params.callFrames.length} topScript=${pauseTopScriptId} hitBps=${params.hitBreakpoints?.length ?? 0}`);

    // Clean up any temporary breakpoint from stepInTargets
    if (this.tempBreakpointId && this.cdp) {
      try { await this.cdp.removeBreakpoint(this.tempBreakpointId); } catch {}
      this.tempBreakpointId = null;
    }

    // Smart stepping: if we landed in non-user code, automatically step over
    // to reach user code. Works for both stepping and breakpoints hitting
    // injected wrapper code (e.g., @react-refresh _s() calls).
    const isException = params.reason === 'exception' || params.reason === 'promiseRejection';
    const isManualPause = params.reason === 'debugCommand';

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

        // If we've been smart-stepping too long, we're stuck in library code
        // (e.g., React's workLoopSync, _jsxDEV calls).
        if (this.smartStepCount > ViteDebugSession.MAX_SMART_STEPS) {
          logger.debug('Smart step limit reached, resuming to next breakpoint');
          this.smartStepCount = 0;
          this.lastStepAction = null;
          await this.cdp.resume();
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
          await this.cdp.stepInto();
        } else if (this.lastStepAction === 'stepOut') {
          await this.cdp.stepOut();
        } else {
          await this.cdp.stepOver();
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
    if (this.callStackManager) {
      logger.debug(`onPaused: awaiting resolveCallFrames (${params.callFrames.length} frames)`);
      const rcfStart = Date.now();
      try {
        this.resolvedFrames = await this.callStackManager.resolveCallFrames(
          params.callFrames, registerSourceRef
        );
        logger.debug(`onPaused: resolveCallFrames done in ${Date.now() - rcfStart}ms (${this.resolvedFrames.length} resolved)`);
      } catch (e) {
        logger.warn(`resolveCallFrames failed after ${Date.now() - rcfStart}ms, stopping with empty stack: ${e}`);
        this.resolvedFrames = [];
      }

      // Enhance top frame with React component info. Bounded — Runtime.evaluate
      // can hang while the debugger is paused (awaitPromise + microtask
      // starvation), and React info is a nice-to-have. A stall here must not
      // block StoppedEvent or VS Code's debug UI will never activate.
      if (this.resolvedFrames.length > 0 && this.cdp) {
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

    const top = this.resolvedFrames[0]?.dapFrame;
    logger.debug(
      `Sending StoppedEvent: reason=${reason} threadId=${THREAD_ID} frames=${this.resolvedFrames.length} ` +
      `top=${top ? `${top.source?.path ?? top.source?.name ?? '?'}:${top.line}` : 'none'}`
    );
    this.sendEvent(new StoppedEvent(reason, THREAD_ID));
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
   *   2. No source map AND script already marked unmappable → skip (getting out of it).
   *   3. Source map resolves to user code → stop (unless skipFiles matches).
   *   4. Source map resolves to node_modules → skip by default, BUT respect
   *      a prior `stepInto` so the user can descend into library code.
   *   5. Source map exists but this position has no mapping → Vite-injected
   *      preamble (e.g. `_s()`, `$RefreshSig$`). Skip.
   */
  private async shouldSmartStep(params: PausedEvent, isExplicitBreakpoint: boolean = false): Promise<boolean> {
    if (isExplicitBreakpoint) return false;
    if (params.callFrames.length === 0) return false;

    const topFrame = params.callFrames[0];
    const { scriptId, lineNumber, columnNumber } = topFrame.location;

    // Already-blackboxed unmappable script — get out of it.
    if (this.unmappableScripts.has(scriptId)) return true;

    if (this.sourceMapResolver && this.sourceMapResolver.hasSourceMap(scriptId)) {
      const original = await this.sourceMapResolver.generatedToOriginal(
        scriptId, lineNumber, columnNumber ?? 0
      );
      if (original) {
        if (original.source.includes('/node_modules/')) {
          // Always skip library code. The step command used to skip adapts
          // to the user's intent: stepInto keeps descending (so a user
          // callback invoked from inside a library — React reconciler
          // calling a Component, a useMemo factory, etc. — is still
          // reached), while stepOver/stepOut stay at the caller-level.
          // The previous "respect stepInto by stopping in node_modules"
          // left users stranded in React internals whenever they tried to
          // step into a JSX element or a hook.
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

      // Has source map but no mapping at this position → injected preamble
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

  private onResumed(): void {
    this.sendEvent(new ContinuedEvent(THREAD_ID, true));
  }

  private onDisconnected(): void {
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

    if (this.cdp) {
      await this.cdp.disconnect();
      this.cdp = null;
    }

    // Debug Chrome is a separate instance — we don't kill it on disconnect
    // so the user can keep using it for subsequent debug sessions
  }
}
