import { EventEmitter } from 'events';
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

export class CdpClient extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;

  private constructor() {
    super();
  }

  /**
   * Open a CDP session and wire up the bridge from raw CDP events to this
   * EventEmitter, but DO NOT enable any domain. Domain enable triggers
   * replay (e.g. Debugger.enable replays every already-parsed script via
   * Debugger.scriptParsed) — those replay events fan out through this
   * EventEmitter, so the caller MUST attach its `.on('scriptParsed', …)` /
   * `.on('paused', …)` / etc. listeners before calling `enableDomains()`.
   * Otherwise the replay fires into a no-listener emitter and is silently
   * dropped, which manifests as "re-attach against an already-loaded page
   * shows no scripts and breakpoints never bind without a manual reload."
   */
  static async connect(port: number, targetUrl?: string): Promise<CdpClient> {
    const cdpClient = new CdpClient();

    // Find the target tab matching the URL if given
    let target: { id: string } | undefined;
    if (targetUrl) {
      const targets = await CDP.List({ port });
      target = targets.find((t: { url: string }) =>
        t.url.startsWith(targetUrl) || t.url.includes(new URL(targetUrl).host)
      );
      if (!target) {
        logger.warn(`No Chrome tab found for ${targetUrl}, connecting to first available`);
      }
    }

    const options: { port: number; target?: string } = { port };
    if (target) {
      options.target = target.id;
    }

    const client = await CDP(options);
    cdpClient.client = client;

    // Bridge CDP events to this EventEmitter. Registering the bridge here
    // (before any domain is enabled) is necessary but not sufficient — see
    // the class-level comment on `connect()`: the *consumer's* `.on(…)`
    // listeners must also be in place before `enableDomains()` runs, since
    // domain enable triggers immediate event replay that fan-outs through
    // this same emitter.
    client.Debugger.scriptParsed((params: ScriptParsedEvent) => {
      cdpClient.emit('scriptParsed', params);
    });

    client.Debugger.paused((params: PausedEvent) => {
      cdpClient.emit('paused', params);
    });

    client.Debugger.resumed(() => {
      cdpClient.emit('resumed');
    });

    client.Runtime.exceptionThrown((params: { exceptionDetails: ExceptionDetails }) => {
      cdpClient.emit('exceptionThrown', params.exceptionDetails);
    });

    client.Runtime.consoleAPICalled((params: ConsoleAPICalledEvent) => {
      cdpClient.emit('consoleAPICalled', params);
    });

    client.Fetch.requestPaused((params: FetchRequestPausedEvent) => {
      cdpClient.emit('requestPaused', params);
    });

    client.on('disconnect', () => {
      cdpClient.emit('disconnected');
    });

    logger.info(`CDP connected to port ${port}${target ? ` (target: ${target.id})` : ''}`);
    return cdpClient;
  }

  /**
   * Enable the CDP domains we use. Must be called after the consumer has
   * attached its event listeners — `Debugger.enable` immediately replays
   * every already-parsed script, and those replay events go through this
   * EventEmitter to the consumer's `.on('scriptParsed', …)`. Without that
   * listener in place, re-attach to an existing page sees no scripts and
   * breakpoints never bind until something causes a fresh parse.
   */
  async enableDomains(): Promise<void> {
    await Promise.all([
      this.client!.Debugger.enable({}),
      this.client!.Runtime.enable(),
      this.client!.Page.enable(),
      this.client!.Fetch.enable({ patterns: [{ requestStage: 'Request' }] }),
    ]);
  }

  // --- Debugger Domain ---

  async setBreakpointByUrl(
    lineNumber: number,
    options: { url?: string; urlRegex?: string; columnNumber?: number; condition?: string } = {}
  ): Promise<CdpBreakpointLocation> {
    const result = await this.client!.Debugger.setBreakpointByUrl({
      lineNumber,
      url: options.url,
      urlRegex: options.urlRegex,
      columnNumber: options.columnNumber,
      condition: options.condition,
    });
    // Surface whether Chrome actually bound the bp to a real script. If
    // `locations` is empty the regex didn't match anything currently loaded,
    // so the bp won't fire until a future scriptParsed (e.g., HMR or
    // navigation) brings in a matching script. This is the diagnostic for
    // "bp set but never hits without refresh" reports.
    if (result.locations.length === 0) {
      logger.warn(
        `setBreakpointByUrl returned 0 bound locations: line=${lineNumber} ` +
        `col=${options.columnNumber} urlRegex=${options.urlRegex} — bp will ` +
        `wait for a matching script to be parsed`
      );
    } else {
      logger.debug(
        `setBreakpointByUrl bound to ${result.locations.length} location(s): ` +
        result.locations.map((l: { scriptId: string; lineNumber: number; columnNumber?: number }) =>
          `${l.scriptId}:${l.lineNumber}:${l.columnNumber ?? 0}`
        ).join(', ')
      );
    }
    return {
      breakpointId: result.breakpointId,
      locations: result.locations.map((loc: { scriptId: string; lineNumber: number; columnNumber?: number }) => ({
        scriptId: loc.scriptId,
        lineNumber: loc.lineNumber,
        columnNumber: loc.columnNumber ?? 0,
      })),
    };
  }

  async removeBreakpoint(breakpointId: string): Promise<void> {
    await this.client!.Debugger.removeBreakpoint({ breakpointId });
  }

  async resume(): Promise<void> {
    await this.client!.Debugger.resume({});
  }

  async stepOver(): Promise<void> {
    await this.client!.Debugger.stepOver({});
  }

  async stepInto(): Promise<void> {
    await this.client!.Debugger.stepInto({});
  }

  async stepOut(): Promise<void> {
    await this.client!.Debugger.stepOut();
  }

  async pause(): Promise<void> {
    await this.client!.Debugger.pause();
  }

  async getScriptSource(scriptId: string): Promise<string> {
    const result = await this.client!.Debugger.getScriptSource({ scriptId });
    return result.scriptSource;
  }

  async evaluateOnCallFrame(callFrameId: string, expression: string, silent: boolean = false): Promise<RemoteObject> {
    const result = await this.client!.Debugger.evaluateOnCallFrame({
      callFrameId,
      expression,
      silent,
      returnByValue: false,
      generatePreview: true,
    });
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
    const result = await this.client!.Debugger.evaluateOnCallFrame({
      callFrameId,
      expression,
      silent: true,
      returnByValue: true,
      generatePreview: false,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Evaluation failed');
    }
    return result.result?.value as T | undefined;
  }

  async setBlackboxPatterns(patterns: string[]): Promise<void> {
    await this.client!.Debugger.setBlackboxPatterns({ patterns });
  }

  async setBlackboxedRanges(
    scriptId: string,
    positions: Array<{ lineNumber: number; columnNumber: number }>
  ): Promise<void> {
    await this.client!.Debugger.setBlackboxedRanges({ scriptId, positions });
  }

  async getPossibleBreakpoints(
    start: { scriptId: string; lineNumber: number; columnNumber?: number },
    end: { scriptId: string; lineNumber: number; columnNumber?: number }
  ): Promise<BreakLocation[]> {
    const result = await this.client!.Debugger.getPossibleBreakpoints({
      start,
      end,
      restrictToFunction: false,
    });
    return result.locations;
  }

  async setBreakpoint(
    location: { scriptId: string; lineNumber: number; columnNumber?: number }
  ): Promise<{ breakpointId: string; actualLocation: { scriptId: string; lineNumber: number; columnNumber: number } }> {
    const result = await this.client!.Debugger.setBreakpoint({ location });
    return {
      breakpointId: result.breakpointId,
      actualLocation: result.actualLocation,
    };
  }

  async setBreakpointsActive(active: boolean): Promise<void> {
    await this.client!.Debugger.setBreakpointsActive({ active });
  }

  async setPauseOnExceptions(state: 'none' | 'uncaught' | 'all'): Promise<void> {
    await this.client!.Debugger.setPauseOnExceptions({ state });
  }

  // --- Runtime Domain ---

  async getProperties(objectId: string, ownProperties: boolean = true): Promise<PropertyDescriptor[]> {
    const result = await this.client!.Runtime.getProperties({
      objectId,
      ownProperties,
      generatePreview: true,
    });
    return result.result;
  }

  async evaluate(expression: string, silent: boolean = false): Promise<RemoteObject> {
    const result = await this.client!.Runtime.evaluate({
      expression,
      silent,
      returnByValue: false,
      generatePreview: true,
    });
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
    const result = await this.client!.Runtime.evaluate({
      expression,
      silent: true,
      returnByValue: true,
      awaitPromise: true,
    });
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
   * V8 invalidates the scriptId if the page navigates; call sites must catch
   * errors and re-compile as a fallback.
   */
  async compileScript(expression: string): Promise<string> {
    const result = await this.client!.Runtime.compileScript({
      expression,
      sourceURL: '',
      persistScript: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'compileScript failed');
    }
    return result.scriptId;
  }

  async runCompiledScript<T = unknown>(scriptId: string): Promise<T | undefined> {
    const result = await this.client!.Runtime.runScript({
      scriptId,
      returnByValue: true,
      awaitPromise: true,
      silent: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'runScript failed');
    }
    return result.result?.value as T | undefined;
  }

  async callFunctionOn(objectId: string, functionDeclaration: string, args?: CallArgument[]): Promise<RemoteObject> {
    const result = await this.client!.Runtime.callFunctionOn({
      objectId,
      functionDeclaration,
      arguments: args,
      returnByValue: false,
      generatePreview: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Call failed');
    }
    return result.result;
  }

  // --- Page Domain ---

  async reload(ignoreCache: boolean = false): Promise<void> {
    await this.client!.Page.reload({ ignoreCache });
  }

  // --- Fetch Domain ---

  async continueFetchRequest(requestId: string): Promise<void> {
    await this.client!.Fetch.continueRequest({ requestId });
  }

  async failFetchRequest(requestId: string, reason: string = 'Failed'): Promise<void> {
    await this.client!.Fetch.failRequest({ requestId, reason });
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
