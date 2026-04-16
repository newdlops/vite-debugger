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
import { SourceMapResolver } from '../sourcemap/SourceMapResolver';
import { BreakpointManager } from '../breakpoints/BreakpointManager';
import { CallStackManager, ResolvedCallFrame, SourceRefRegistrar } from '../inspection/CallStackManager';
import { ScopeManager } from '../inspection/ScopeManager';
import { VariableManager } from '../inspection/VariableManager';
import { EvalHandler } from '../inspection/EvalHandler';
import { logger } from '../util/Logger';

const THREAD_ID = 1;
const REACT_SCOPE_REF_BASE = 900000;
const REACT_HOOKS_REF_BASE = 910000;

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
  private lastLoggedScriptCount = 0;
  private static readonly MAX_SMART_STEPS = 20;
  private lastStepAction: 'stepOver' | 'stepInto' | 'stepOut' | null = null;
  private stepInTargetLocations = new Map<number, BreakLocation>();
  private tempBreakpointId: string | null = null;
  private sourceMapRetryTimer: NodeJS.Timeout | null = null;
  /** Glob patterns for files the user wants to skip during stepping */
  private skipFilePatterns: string[] = [];

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
      this.skipFilePatterns = args.skipFiles ?? [];

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
      this.skipFilePatterns = args.skipFiles ?? [];

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

    // Blackbox library/framework code so step-into skips through React
    // internals and lands on the next user component.
    // Chrome natively handles this: when stepping into blackboxed code,
    // it continues until it reaches non-blackboxed (user) code.
    await this.cdp.setBlackboxPatterns([
      '/node_modules/',        // All library code (React, react-dom, etc.)
      '/@vite/',               // Vite client internals
      '/@react-refresh',       // React refresh runtime
      '__vite_',               // Vite HMR helpers
      '@vite-plugin-checker',  // Vite plugins
    ]);
    logger.info('Blackbox patterns set for library code');

    // Wire up source map loaded callback — resolve pending breakpoints when a
    // source map is loaded (covers both initial load and retried loads)
    this.sourceMapResolver.onSourceMapLoaded = (scriptId: string) => {
      if (!this.breakpointManager || !this.breakpointManager.hasPendingBreakpoints()) return;
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

      const targets: DebugProtocol.StepInTarget[] = [];
      let targetId = 1;

      // Clear previous step-in target locations
      this.stepInTargetLocations.clear();

      const locsToUse = callLocations.length > 0 ? callLocations : locations;

      for (const loc of locsToUse) {
        // Try to resolve to original source position
        const original = await this.sourceMapResolver.generatedToOriginal(
          scriptId, loc.lineNumber, loc.columnNumber ?? 0
        );

        let label: string;
        if (original) {
          label = callLocations.length > 0
            ? `Call at ${original.source.split('/').pop()}:${original.line}:${original.column + 1}`
            : `${original.source.split('/').pop()}:${original.line}:${original.column + 1}`;
        } else {
          label = callLocations.length > 0
            ? `Call at line ${loc.lineNumber + 1}:${(loc.columnNumber ?? 0) + 1}`
            : `line ${loc.lineNumber + 1}:${(loc.columnNumber ?? 0) + 1}`;
        }

        this.stepInTargetLocations.set(targetId, loc);

        targets.push({
          id: targetId++,
          label,
          line: original?.line,
          column: original ? original.column + 1 : undefined,
        });
      }

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
            const fs = require('fs');
            const content = fs.readFileSync(primarySource, 'utf-8');
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

  protected loadedSourcesRequest(
    response: DebugProtocol.LoadedSourcesResponse,
    _args: DebugProtocol.LoadedSourcesArguments
  ): void {
    const sources: DebugProtocol.Source[] = [];

    for (const [url, scriptId] of this.knownScriptUrls) {
      // Skip internal Vite URLs
      if (url.includes('/@vite/') || url.includes('/@react-refresh') || url.includes('__vite_')) continue;

      const filePath = this.urlMapper?.viteUrlToFilePath(url);
      const name = url.split('/').pop() ?? url;

      const source: DebugProtocol.Source = { name };

      // Check if file exists on disk
      if (filePath) {
        try {
          const stat = require('fs').statSync(filePath);
          if (stat.isFile()) {
            source.path = filePath;
          }
        } catch {}
      }

      // If not on disk, provide sourceReference
      if (!source.path) {
        const ref = this.nextSourceRef++;
        this.sourceRefToScriptId.set(ref, scriptId);
        source.sourceReference = ref;
      }

      // Deemphasize node_modules
      if (url.includes('/node_modules/')) {
        source.presentationHint = 'deemphasize';
      }

      sources.push(source);
    }

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

  // --- CDP Event Handlers ---

  private async onScriptParsed(params: ScriptParsedEvent): Promise<void> {
    if (!params.url || !params.sourceMapURL) return;

    // Track URL <-> scriptId mappings
    const previousScriptId = this.knownScriptUrls.get(params.url);
    const isHmrReload = previousScriptId !== undefined && previousScriptId !== params.scriptId;
    this.knownScriptUrls.set(params.url, params.scriptId);
    this.scriptIdToUrl.set(params.scriptId, params.url);

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
        const resolved = await this.breakpointManager.handleHmrReload(params.url);
        for (const bp of resolved) {
          this.sendEvent(new BreakpointEvent('changed', {
            id: bp.dapId,
            verified: true,
            line: bp.line,
          } as DebugProtocol.Breakpoint));
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
    if (filePath) {
      try {
        const stat = require('fs').statSync(filePath);
        if (stat.isFile()) {
          loadedSource.path = filePath;
        }
      } catch {}
    }
    if (!loadedSource.path) {
      const ref = this.nextSourceRef++;
      this.sourceRefToScriptId.set(ref, params.scriptId);
      loadedSource.sourceReference = ref;
    }
    this.sendEvent(new LoadedSourceEvent(isHmrReload ? 'changed' : 'new', loadedSource));
  }

  private async onPaused(params: PausedEvent): Promise<void> {
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

        const topLoc = params.callFrames[0]?.location;
        logger.debug(`Smart step #${this.smartStepCount}: skipping injected code (script ${topLoc?.scriptId}, line ${(topLoc?.lineNumber ?? 0) + 1})`);
        await this.cdp.stepOver();
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
      this.resolvedFrames = await this.callStackManager.resolveCallFrames(
        params.callFrames, registerSourceRef
      );

      // Enhance top frame with React component info
      if (this.resolvedFrames.length > 0 && this.cdp) {
        await this.detectReactComponent(params.callFrames[0]);
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

    this.sendEvent(new StoppedEvent(reason, THREAD_ID));
  }

  /**
   * Determine if the current pause location is non-user code that should be skipped.
   *
   * Note: node_modules and Vite internal URLs are handled by Chrome's blackbox
   * mechanism (setBlackboxPatterns). Smart stepping only handles Vite-injected
   * code WITHIN user files (e.g., _s(), $RefreshSig$, HMR wrappers) — these
   * are in the same script URL as user code so they can't be blackboxed.
   *
   * The check:
   *   1. If the position resolves via source map → check skipFiles patterns, then user code (stop)
   *   2. If it doesn't resolve but the script's primary source exists on disk
   *      → still user code with sparse mapping (stop)
   *   3. If it doesn't resolve and no local source → injected code (skip)
   */
  private async shouldSmartStep(params: PausedEvent, isExplicitBreakpoint: boolean = false): Promise<boolean> {
    if (params.callFrames.length === 0) return false;

    const topFrame = params.callFrames[0];
    const { scriptId, lineNumber, columnNumber } = topFrame.location;

    // Only smart-step for scripts that HAVE a source map registered.
    // Scripts without source maps (pure library code) are handled by blackboxing.
    if (this.sourceMapResolver && this.sourceMapResolver.hasSourceMap(scriptId)) {
      // generatedToOriginal now searches backwards through generated lines,
      // so it resolves even for lines without exact mappings.
      const original = await this.sourceMapResolver.generatedToOriginal(
        scriptId, lineNumber, columnNumber ?? 0
      );
      if (original) {
        // Skip node_modules
        if (original.source.includes('/node_modules/')) return true;

        // Skip files matching user-configured skipFiles patterns
        // (but NOT when an explicit breakpoint was hit — user placed it intentionally)
        if (!isExplicitBreakpoint && this.shouldSkipFile(original.source)) {
          logger.debug(`Skipping file (skipFiles match): ${original.source}`);
          return true;
        }

        // User code — stop here
        return false;
      }

      // No mapping found at all (even with backwards search) →
      // Vite-injected code (_s(), $RefreshSig$, etc.)
      return true;
    }

    // No source map = probably should have been blackboxed, but wasn't.
    return false;
  }

  /**
   * Check if a source file path matches any of the user-configured skipFiles patterns.
   * Supports glob-like patterns: "*" matches any segment, "**" matches multiple segments.
   */
  private shouldSkipFile(filePath: string): boolean {
    if (this.skipFilePatterns.length === 0) return false;

    const normalized = filePath.replace(/\\/g, '/');
    for (const pattern of this.skipFilePatterns) {
      if (this.globMatch(normalized, pattern)) return true;
    }
    return false;
  }

  private globMatch(filePath: string, pattern: string): boolean {
    // Simple glob matching: convert glob to regex
    // Support: *, **, ?
    const regexStr = pattern
      .replace(/\\/g, '/')
      .replace(/[.+^${}()|[\]]/g, '\\$&')  // Escape regex special chars (except * and ?)
      .replace(/\*\*/g, '\u0000')            // Placeholder for **
      .replace(/\*/g, '[^/]*')               // * matches within a segment
      .replace(/\u0000/g, '.*')              // ** matches across segments
      .replace(/\?/g, '[^/]');               // ? matches single char

    return new RegExp(regexStr).test(filePath);
  }


  /**
   * Detect React component info when paused.
   * For function components: look at the call stack for React render frames,
   * then evaluate to get the component's props/state.
   * For class components: check `this.props` and `this.state`.
   */
  private async detectReactComponent(topFrame: import('../cdp/CdpTypes').CallFrame): Promise<void> {
    this.reactComponentName = null;
    this.reactComponentObjectId = null;
    this.reactHooksObjectId = null;

    if (!this.cdp) return;

    try {
      // Strategy 1: Class component — check if `this` has props/state
      const classResult = await this.cdp.evaluateOnCallFrame(
        topFrame.callFrameId,
        `(() => {
          if (this && this.props && this.constructor && this.constructor.name) {
            return { type: 'class', name: this.constructor.name };
          }
          return null;
        })()`,
        true
      );

      if (classResult.type === 'object' && classResult.subtype !== 'null' && classResult.preview?.properties) {
        const typeProp = classResult.preview.properties.find((p: { name: string }) => p.name === 'type');
        const nameProp = classResult.preview.properties.find((p: { name: string }) => p.name === 'name');
        if (typeProp?.value === 'class' && nameProp?.value) {
          this.reactComponentName = nameProp.value;
          // Get `this` as an object we can explore (props, state, etc.)
          const thisObj = await this.cdp.evaluateOnCallFrame(
            topFrame.callFrameId,
            `({ props: this.props, state: this.state })`,
            true
          );
          if (thisObj.objectId) {
            this.reactComponentObjectId = thisObj.objectId;
          }
          return;
        }
      }

      // Strategy 2: Function component — use React DevTools hook to find current fiber
      const fiberResult = await this.cdp.evaluateOnCallFrame(
        topFrame.callFrameId,
        `(() => {
          const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
          if (!hook || !hook.renderers) return null;
          for (const [, renderer] of hook.renderers) {
            const fiber = renderer.getCurrentFiber ? renderer.getCurrentFiber() : null;
            if (fiber) {
              const name = fiber.type?.displayName || fiber.type?.name || null;
              const props = fiber.memoizedProps;
              const state = fiber.memoizedState;
              if (name || props) {
                return { name, hasProps: !!props, hasState: !!state };
              }
            }
          }
          return null;
        })()`,
        true
      );

      if (fiberResult.type === 'object' && fiberResult.subtype !== 'null' && fiberResult.preview?.properties) {
        const nameProp = fiberResult.preview.properties.find((p: { name: string }) => p.name === 'name');
        if (nameProp?.value && nameProp.value !== 'null') {
          this.reactComponentName = nameProp.value;
          // Fetch props as explorable object
          const propsObj = await this.cdp.evaluateOnCallFrame(
            topFrame.callFrameId,
            `(() => {
              const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
              if (!hook || !hook.renderers) return {};
              for (const [, renderer] of hook.renderers) {
                const fiber = renderer.getCurrentFiber ? renderer.getCurrentFiber() : null;
                if (fiber && fiber.memoizedProps) {
                  return fiber.memoizedProps;
                }
              }
              return {};
            })()`,
            true
          );
          if (propsObj.objectId) {
            this.reactComponentObjectId = propsObj.objectId;
          }

          // Fetch hooks as a named object (without returnByValue so we get objectIds)
          await this.extractReactHooks(topFrame.callFrameId);
          return;
        }
      }

      // Strategy 3: Infer from function name — many function components
      // are named (const MyComponent = () => ...) and V8 infers the name
      const funcName = topFrame.functionName;
      if (funcName && /^[A-Z]/.test(funcName)) {
        this.reactComponentName = funcName;
        // Try to get first argument (props) for function components
        const propsObj = await this.cdp.evaluateOnCallFrame(
          topFrame.callFrameId,
          `(() => {
            try {
              const args = typeof arguments !== 'undefined' ? arguments : null;
              if (args && args[0] && typeof args[0] === 'object') {
                return args[0];
              }
            } catch {}
            return null;
          })()`,
          true
        );
        if (propsObj.type === 'object' && propsObj.subtype !== 'null' && propsObj.objectId) {
          this.reactComponentObjectId = propsObj.objectId;
        }

        // Also try to extract hooks even when detected via function name
        await this.extractReactHooks(topFrame.callFrameId);
      }
    } catch (e) {
      // Non-critical — just skip React detection
      logger.debug(`React component detection failed: ${e}`);
    }
  }

  /**
   * Extract individual React hook values from the current fiber and store them
   * as an explorable object in the Hooks scope.
   */
  private async extractReactHooks(callFrameId: string): Promise<void> {
    if (!this.cdp) return;

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
        this.reactHooksObjectId = hooksObj.objectId;
      }
    } catch (e) {
      logger.debug(`React hooks extraction failed: ${e}`);
    }
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
        const scriptId = this.knownScriptUrls.get(topFrame.url);
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
    this.sourceMapResolver?.clear();
    this.breakpointManager?.clear();
    this.networkBreakpointManager?.clear();
    this.networkBreakpointManager = null;
    this.callStackManager?.clear();
    this.scopeManager?.clear();
    this.variableManager?.clear();

    if (this.cdp) {
      await this.cdp.disconnect();
      this.cdp = null;
    }

    // Debug Chrome is a separate instance — we don't kill it on disconnect
    // so the user can keep using it for subsequent debug sessions
  }
}
