import * as crypto from 'crypto';
import * as dns from 'dns';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from '../util/Logger';
import { isLoopbackHost, normalizeHost } from '../util/LocalHosts';
import { canonicalizeWorkspaceRoot, SessionRegistry } from './SessionRegistry';

const BRIDGE_SCHEMA_VERSION = 1;
const HEARTBEAT_INTERVAL_MS = 10_000;
const STALE_MANIFEST_MS = 60_000;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_DEBUG_CONFIGURATION = 'Debug Vite App';
const MAX_DEBUG_CONFIGURATION_NAME = 200;
const MAX_VITE_URL_CHARS = 2_048;
const LOCAL_DNS_TIMEOUT_MS = 1_000;
const MAX_DEBUG_START_OPERATIONS = 100;
const DEBUG_START_OPERATION_TTL_MS = 5 * 60_000;
const MAX_DEBUG_START_ERROR_CHARS = 2_000;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface BridgeManifest {
  schemaVersion: number;
  windowId: string;
  pid: number;
  host: '127.0.0.1';
  port: number;
  token: string;
  roots: string[];
  heartbeat: number;
}

interface RpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

interface DebugConfigurationDescription {
  name: string;
  request: 'launch' | 'attach';
  preLaunchTask: boolean;
  configuration: vscode.DebugConfiguration;
}

interface PendingDebugStart {
  operationId: string;
  configurationName: string;
  viteUrl?: string;
  pageUrl?: string;
  result: Record<string, unknown>;
}

interface PendingDebugStartPreparation {
  requestedName?: string;
  viteUrl?: string;
  pageUrl?: string;
  promise: Promise<unknown>;
}

interface DebugStartOperation {
  readonly operationId: string;
  readonly workspaceKey: string;
  readonly configurationName: string;
  readonly viteUrl?: string;
  readonly pageUrl?: string;
  readonly result: Record<string, unknown>;
  state: 'starting' | 'accepted' | 'declined' | 'failed' | 'terminated';
  message?: string;
  updatedAt: number;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function resolveAllWithTimeout(hostname: string): Promise<dns.LookupAddress[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      dns.promises.lookup(hostname, { all: true, verbatim: true }),
      new Promise<dns.LookupAddress[]>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS lookup timed out')), LOCAL_DNS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function getBridgeRuntimeDirectory(): string {
  return path.join(os.tmpdir(), 'vite-debugger-mcp');
}

/**
 * A window-local, authenticated JSON-RPC bridge.  The external MCP stdio
 * process discovers it through a private manifest and never needs to guess a
 * shared CDP/debugger port.
 */
export class BridgeServer implements vscode.Disposable {
  readonly windowId = crypto.randomUUID();

  private readonly host = '127.0.0.1' as const;
  private readonly token = crypto.randomBytes(32).toString('hex');
  private readonly runtimeDirectory = getBridgeRuntimeDirectory();
  private readonly manifestPath = path.join(this.runtimeDirectory, `${this.windowId}.json`);
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private roots: string[];
  private port: number | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private readonly pendingDebugStartPreparations = new Map<string, PendingDebugStartPreparation>();
  private readonly pendingDebugStarts = new Map<string, PendingDebugStart>();
  private readonly debugStartOperations = new Map<string, DebugStartOperation>();
  private disposed = false;
  private started = false;

  constructor(
    private readonly registry: SessionRegistry,
    workspaceRoots: readonly string[],
  ) {
    this.roots = this.canonicalRoots(workspaceRoots);
    this.server = net.createServer((socket) => this.handleConnection(socket));
    this.server.maxConnections = 32;
    this.server.on('error', (error) => {
      logger.error(`MCP bridge server error: ${error.message}`);
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.disposed) throw new Error('MCP bridge has already been disposed');

    this.prepareRuntimeDirectory();
    this.removeStaleManifests();

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(0, this.host);
    });

    const address = this.server.address();
    if (!address || typeof address === 'string') {
      this.server.close();
      throw new Error('MCP bridge did not receive a TCP port');
    }

    this.port = address.port;
    this.started = true;
    this.writeManifest();
    this.heartbeatTimer = setInterval(() => this.writeManifest(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
    logger.info(`MCP bridge listening for ${this.roots.length} workspace root(s)`);
  }

  updateWorkspaceRoots(workspaceRoots: readonly string[]): void {
    this.roots = this.canonicalRoots(workspaceRoots);
    if (this.started) this.writeManifest();
  }

  recordDebugSessionTermination(session: vscode.DebugSession): void {
    if (session.type !== 'vite') return;
    const rawOperationId = session.configuration?._viteDebuggerMcpStartId;
    if (typeof rawOperationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(rawOperationId)) return;
    const operation = this.debugStartOperations.get(rawOperationId);
    if (!operation || (operation.state !== 'starting' && operation.state !== 'accepted')) return;
    operation.state = 'terminated';
    operation.message = `Vite debug session ${operation.configurationName} terminated before it became ready`;
    operation.updatedAt = Date.now();
    this.releasePendingDebugStart(operation);
  }

  recordDebugSessionFailure(session: vscode.DebugSession, reason: string): void {
    if (session.type !== 'vite') return;
    const rawOperationId = session.configuration?._viteDebuggerMcpStartId;
    if (typeof rawOperationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(rawOperationId)) return;
    const operation = this.debugStartOperations.get(rawOperationId);
    if (!operation || (operation.state !== 'starting' && operation.state !== 'accepted')) return;
    operation.state = 'failed';
    operation.message = this.debugStartError(operation.configurationName, reason);
    operation.updatedAt = Date.now();
    this.releasePendingDebugStart(operation);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.pendingDebugStartPreparations.clear();
    this.pendingDebugStarts.clear();
    this.debugStartOperations.clear();
    if (this.server.listening) this.server.close();

    try {
      fs.unlinkSync(this.manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`Could not remove MCP bridge manifest: ${(error as Error).message}`);
      }
    }
  }

  private canonicalRoots(workspaceRoots: readonly string[]): string[] {
    const unique = new Map<string, string>();
    for (const root of workspaceRoots) {
      const canonical = canonicalizeWorkspaceRoot(root);
      const key = process.platform === 'win32'
        ? canonical.toLocaleLowerCase('en-US')
        : canonical;
      unique.set(key, canonical);
    }
    return Array.from(unique.values()).sort();
  }

  private prepareRuntimeDirectory(): void {
    fs.mkdirSync(this.runtimeDirectory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.runtimeDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Unsafe MCP bridge runtime path: ${this.runtimeDirectory}`);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error(`MCP bridge runtime directory is owned by another user`);
    }
    fs.chmodSync(this.runtimeDirectory, 0o700);
  }

  private removeStaleManifests(): void {
    const now = Date.now();
    for (const name of fs.readdirSync(this.runtimeDirectory)) {
      if (!name.endsWith('.json')) continue;
      const candidatePath = path.join(this.runtimeDirectory, name);
      if (candidatePath === this.manifestPath) continue;

      let remove = false;
      try {
        const raw = fs.readFileSync(candidatePath, 'utf8');
        const manifest = JSON.parse(raw) as Partial<BridgeManifest>;
        const heartbeat = typeof manifest.heartbeat === 'number' ? manifest.heartbeat : 0;
        const pid = typeof manifest.pid === 'number' ? manifest.pid : -1;
        remove = now - heartbeat > STALE_MANIFEST_MS || !this.isProcessAlive(pid);
      } catch {
        try {
          remove = now - fs.statSync(candidatePath).mtimeMs > STALE_MANIFEST_MS;
        } catch {
          remove = false;
        }
      }

      if (remove) {
        try {
          fs.unlinkSync(candidatePath);
        } catch {
          // Another window may have cleaned it up concurrently.
        }
      }
    }
  }

  private isProcessAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private writeManifest(): void {
    if (this.disposed || this.port === undefined) return;

    const manifest: BridgeManifest = {
      schemaVersion: BRIDGE_SCHEMA_VERSION,
      windowId: this.windowId,
      pid: process.pid,
      host: this.host,
      port: this.port,
      token: this.token,
      roots: this.roots,
      heartbeat: Date.now(),
    };
    const temporaryPath = path.join(
      this.runtimeDirectory,
      `.${this.windowId}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    );

    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      fs.renameSync(temporaryPath, this.manifestPath);
      fs.chmodSync(this.manifestPath, 0o600);
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch { /* nothing to clean up */ }
      logger.warn(`Could not write MCP bridge manifest: ${(error as Error).message}`);
    }
  }

  private handleConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    socket.setNoDelay(true);

    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
        this.sendError(socket, null, -32600, 'Request exceeds bridge size limit');
        socket.destroy();
        return;
      }

      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) void this.handleLine(socket, line);
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.sendError(socket, null, -32700, 'Parse error');
      return;
    }

    if (!isRecord(parsed) || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
      this.sendError(socket, this.requestId(parsed), -32600, 'Invalid Request');
      return;
    }

    const request = parsed as unknown as JsonRpcRequest;
    const hasId = Object.prototype.hasOwnProperty.call(request, 'id');
    const id = request.id ?? null;
    try {
      const result = await this.dispatch(request);
      if (hasId) this.send(socket, { jsonrpc: '2.0', id, result: result ?? null });
    } catch (error) {
      if (!hasId) return;
      const rpcError = error instanceof RpcError
        ? { code: error.code, message: error.message, data: error.data }
        : { code: -32603, message: error instanceof Error ? error.message : 'Internal error' };
      this.sendError(socket, id, rpcError.code, rpcError.message, rpcError.data);
    }
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    if (!isRecord(request.params)) throw new RpcError(-32602, 'params must be an object');
    if (!this.matchesToken(request.params.token)) throw new RpcError(-32001, 'Unauthorized');

    const workspaceRoot = this.readWorkspaceRoot(request.params.workspaceRoot);

    switch (request.method) {
      case 'listSessions':
        return { sessions: this.registry.list(workspaceRoot) };

      case 'startDebugging': {
        if (!workspaceRoot) {
          throw new RpcError(-32602, 'workspaceRoot is required to start debugging');
        }
        const configurationName = this.readConfigurationName(request.params.configurationName);
        const viteUrl = await this.readLocalViteUrl(request.params.viteUrl);
        const pageUrl = await this.readLocalPageUrl(request.params.pageUrl);
        const operationId = request.params.operationId === undefined
          ? undefined
          : this.readDebugStartOperationId(request.params.operationId);
        return this.startDebugging(workspaceRoot, configurationName, operationId, viteUrl, pageUrl);
      }

      case 'debugStartStatus': {
        if (!workspaceRoot) {
          throw new RpcError(-32602, 'workspaceRoot is required to inspect a debug start');
        }
        const operationId = this.readDebugStartOperationId(request.params.operationId);
        return this.debugStartStatus(workspaceRoot, operationId);
      }

      case 'cancelDebugStart': {
        if (!workspaceRoot) {
          throw new RpcError(-32602, 'workspaceRoot is required to cancel a debug start');
        }
        const operationId = this.readDebugStartOperationId(request.params.operationId);
        return this.cancelDebugStart(workspaceRoot, operationId);
      }

      case 'sessionRequest': {
        if (typeof request.params.sessionId !== 'string' || request.params.sessionId.length === 0) {
          throw new RpcError(-32602, 'sessionId must be a non-empty string');
        }
        if (typeof request.params.method !== 'string' || request.params.method.length === 0) {
          throw new RpcError(-32602, 'method must be a non-empty string');
        }
        const session = this.registry.get(request.params.sessionId, workspaceRoot);
        if (!session) throw new RpcError(-32004, 'Debug session not found');

        return session.customRequest('viteDebugger.mcp', {
          method: request.params.method,
          params: request.params.params ?? {},
        });
      }

      default:
        throw new RpcError(-32601, `Method not found: ${request.method}`);
    }
  }

  private readConfigurationName(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
      throw new RpcError(-32602, 'configurationName must be a string');
    }
    const name = value.trim();
    if (name.length === 0 || name.length > MAX_DEBUG_CONFIGURATION_NAME || /[\x00-\x1f\x7f]/.test(name)) {
      throw new RpcError(
        -32602,
        `configurationName must contain 1-${MAX_DEBUG_CONFIGURATION_NAME} printable characters`,
      );
    }
    return name;
  }

  private readDebugStartOperationId(value: unknown): string {
    if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) {
      throw new RpcError(-32602, 'operationId must be a UUID');
    }
    return value;
  }

  private async readLocalViteUrl(value: unknown): Promise<string | undefined> {
    return this.readLocalHttpUrl(value, 'viteUrl', true);
  }

  private async readLocalPageUrl(value: unknown): Promise<string | undefined> {
    return this.readLocalHttpUrl(value, 'pageUrl', false);
  }

  private async readLocalHttpUrl(
    value: unknown,
    fieldName: 'viteUrl' | 'pageUrl',
    originOnly: boolean,
  ): Promise<string | undefined> {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VITE_URL_CHARS ||
        /[\x00-\x20\x7f]/.test(value)) {
      throw new RpcError(-32602, `${fieldName} must contain 1-${MAX_VITE_URL_CHARS} URL characters`);
    }

    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new RpcError(-32602, `${fieldName} must be a valid absolute URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new RpcError(-32602, `${fieldName} must use http or https`);
    }
    if (
      parsed.username ||
      parsed.password ||
      (originOnly && parsed.pathname !== '/') ||
      parsed.search ||
      parsed.hash
    ) {
      throw new RpcError(
        -32602,
        originOnly
          ? `${fieldName} must be an origin URL without credentials, path, query, or fragment`
          : `${fieldName} must not contain credentials, query, or fragment`,
      );
    }

    // WHATWG URL keeps brackets around IPv6 hostnames in some Node releases;
    // normalize before net/DNS checks while preserving the original URL.
    const hostname = normalizeHost(parsed.hostname);
    const literalFamily = net.isIP(hostname);
    if (literalFamily !== 0) {
      if (!isLoopbackHost(hostname)) {
        throw new RpcError(-32602, `${fieldName} must resolve exclusively to this machine`);
      }
    } else {
      let addresses: dns.LookupAddress[];
      try {
        addresses = await resolveAllWithTimeout(hostname);
      } catch {
        throw new RpcError(-32602, `${fieldName} hostname could not be resolved locally`);
      }
      if (addresses.length === 0 || addresses.some(({ address }) => !isLoopbackHost(address))) {
        throw new RpcError(-32602, `${fieldName} must resolve exclusively to this machine`);
      }
    }
    return originOnly ? parsed.origin : parsed.href;
  }

  private debugStartStatus(workspaceRoot: string, operationId: string): Record<string, unknown> {
    this.pruneDebugStartOperations();
    const operation = this.debugStartOperations.get(operationId);
    if (!operation || operation.workspaceKey !== this.workspaceKey(workspaceRoot)) {
      return { operationId, state: 'unknown' };
    }
    return {
      operationId,
      state: operation.state,
      configurationName: operation.configurationName,
      ...(operation.message ? { message: operation.message } : {}),
    };
  }

  /**
   * Stop only an adapter session that has already registered with the exact
   * MCP correlation id. A preLaunchTask can legitimately run for a long time
   * before any session exists; in that state cancellation is deliberately a
   * no-op and the pending start remains single-flight.
   */
  private cancelDebugStart(workspaceRoot: string, operationId: string): Record<string, unknown> {
    this.pruneDebugStartOperations();
    const workspaceKey = this.workspaceKey(workspaceRoot);
    const operation = this.debugStartOperations.get(operationId);
    if (!operation || operation.workspaceKey !== workspaceKey) {
      return { operationId, cancelled: false, state: 'unknown' };
    }
    if (operation.state !== 'starting' && operation.state !== 'accepted') {
      return { operationId, cancelled: false, state: operation.state };
    }

    const sessions = this.registry.takeByStartOperationId(operationId, workspaceRoot);
    if (sessions.length === 0) {
      return {
        operationId,
        cancelled: false,
        state: operation.state,
        reason: 'noCorrelatedSession',
      };
    }

    operation.state = 'terminated';
    operation.message =
      `Stopped Vite debug configuration ${operation.configurationName} after adapter readiness timed out`;
    operation.updatedAt = Date.now();
    this.releasePendingDebugStart(operation);

    for (const session of sessions) {
      void Promise.resolve()
        .then(() => vscode.debug.stopDebugging(session))
        .catch((error) => {
          logger.debug(`Could not stop timed-out Vite debug session ${session.id}: ${String(error)}`);
        });
    }
    return {
      operationId,
      cancelled: true,
      state: operation.state,
      stoppedSessionCount: sessions.length,
      message: operation.message,
    };
  }

  private async startDebugging(
    workspaceRoot: string,
    requestedName: string | undefined,
    requestedOperationId: string | undefined,
    requestedViteUrl: string | undefined,
    requestedPageUrl: string | undefined,
  ): Promise<unknown> {
    const key = this.workspaceKey(workspaceRoot);
    this.pruneDebugStartOperations();
    if (requestedOperationId) {
      const previous = this.debugStartOperations.get(requestedOperationId);
      if (previous) {
        if (previous.workspaceKey !== key) {
          throw new RpcError(-32025, 'Debug start operation belongs to a different workspace');
        }
        if (requestedName && requestedName !== previous.configurationName) {
          throw new RpcError(-32025, 'Debug start operation was already used for another configuration');
        }
        if (requestedViteUrl !== previous.viteUrl) {
          throw new RpcError(-32025, 'Debug start operation was already used with another Vite URL');
        }
        if (requestedPageUrl !== previous.pageUrl) {
          throw new RpcError(-32025, 'Debug start operation was already used with another application page URL');
        }
        return previous.result;
      }
    }
    const pending = this.pendingDebugStarts.get(key);
    if (pending) {
      if ((!requestedName || requestedName === pending.configurationName) &&
          requestedViteUrl === pending.viteUrl &&
          requestedPageUrl === pending.pageUrl) {
        return pending.result;
      }
      throw new RpcError(
        -32024,
        `A Vite debug start is already in progress for ${pending.configurationName}`,
      );
    }

    const preparing = this.pendingDebugStartPreparations.get(key);
    if (preparing) {
      if ((!requestedName || requestedName === preparing.requestedName) &&
          requestedViteUrl === preparing.viteUrl &&
          requestedPageUrl === preparing.pageUrl) {
        return preparing.promise;
      }
      throw new RpcError(-32024, 'Another Vite debug start is being prepared for this workspace');
    }

    const promise = this.startDebuggingOnce(
      workspaceRoot,
      requestedName,
      key,
      requestedOperationId,
      requestedViteUrl,
      requestedPageUrl,
    );
    const preparation: PendingDebugStartPreparation = {
      requestedName,
      viteUrl: requestedViteUrl,
      pageUrl: requestedPageUrl,
      promise,
    };
    this.pendingDebugStartPreparations.set(key, preparation);
    try {
      return await promise;
    } finally {
      if (this.pendingDebugStartPreparations.get(key) === preparation) {
        this.pendingDebugStartPreparations.delete(key);
      }
    }
  }

  private async startDebuggingOnce(
    workspaceRoot: string,
    requestedName: string | undefined,
    pendingKey: string,
    requestedOperationId: string | undefined,
    requestedViteUrl: string | undefined,
    requestedPageUrl: string | undefined,
  ): Promise<unknown> {
    if (!vscode.workspace.isTrusted) {
      throw new RpcError(-32020, 'Trust this VS Code workspace before starting a debug configuration');
    }

    const existing = this.registry.list(workspaceRoot);
    if (existing.length > 0) {
      return {
        accepted: false,
        reused: true,
        configurationName: requestedName,
        ...(existing.length === 1 && existing[0].request
          ? { request: existing[0].request }
          : {}),
        sessions: existing,
      };
    }

    const folder = this.workspaceFolderForRoot(workspaceRoot);
    if (!folder) {
      throw new RpcError(-32021, 'The requested workspace folder is no longer open in this VS Code window');
    }

    const configurations = this.viteDebugConfigurations(folder);
    const configured = this.selectViteDebugConfiguration(configurations, requestedName);
    let source: 'workspace' | 'generated';
    let request: 'launch' | 'attach';
    let configurationName: string;
    let launch: vscode.DebugConfiguration;
    let preLaunchTask = false;
    let effectivePageUrl = requestedPageUrl;
    const operationId = requestedOperationId ?? crypto.randomUUID();

    if (configured) {
      source = 'workspace';
      request = configured.request;
      configurationName = configured.name;
      if (!effectivePageUrl && configured.configuration.pageUrl !== undefined) {
        try {
          effectivePageUrl = await this.readLocalPageUrl(configured.configuration.pageUrl);
        } catch (error) {
          throw new RpcError(
            -32026,
            `Vite debug configuration ${configurationName} has an unsafe pageUrl: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      const rawChromePort = configured.configuration.chromePort;
      const chromePortExplicit = Object.prototype.hasOwnProperty.call(
        configured.configuration,
        'chromePort',
      ) && Number.isInteger(rawChromePort) &&
        (rawChromePort as number) > 0 && (rawChromePort as number) <= 65_535;
      launch = {
        ...configured.configuration,
        _viteDebuggerMcpStartId: operationId,
        _viteDebuggerMcpRequireWorkspaceMatch: true,
        _viteDebuggerMcpChromePortExplicit: chromePortExplicit,
        ...(requestedViteUrl ? { viteUrl: requestedViteUrl } : {}),
        ...(effectivePageUrl ? { pageUrl: effectivePageUrl } : {}),
      };
      preLaunchTask = configured.preLaunchTask;
    } else {
      // The generated fallback never executes a task or command. It is useful
      // when an agent already started Vite in its shell and only the VS Code
      // debug-session/UI boundary was missing.
      source = 'generated';
      request = 'launch';
      configurationName = DEFAULT_DEBUG_CONFIGURATION;
      launch = {
        type: 'vite',
        request,
        name: configurationName,
        webRoot: folder.uri.fsPath,
        _viteDebuggerMcpStartId: operationId,
        _viteDebuggerMcpRequireWorkspaceMatch: true,
        _viteDebuggerMcpChromePortExplicit: false,
        ...(requestedViteUrl ? { viteUrl: requestedViteUrl } : {}),
        ...(effectivePageUrl ? { pageUrl: effectivePageUrl } : {}),
      };
    }

    let completion: Promise<boolean>;
    try {
      completion = Promise.resolve(vscode.debug.startDebugging(folder, launch, {
        noDebug: false,
        suppressSaveBeforeStart: true,
      }));
    } catch (error) {
      throw new RpcError(
        -32023,
        `Could not start Vite debug configuration ${configurationName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const result: Record<string, unknown> = {
      accepted: true,
      reused: false,
      state: 'starting',
      configurationName,
      source,
      request,
      preLaunchTask,
      operationId,
      ...(requestedViteUrl ? { viteUrl: requestedViteUrl } : {}),
      ...(effectivePageUrl ? { pageUrl: effectivePageUrl } : {}),
    };
    const operation: DebugStartOperation = {
      operationId,
      workspaceKey: pendingKey,
      configurationName,
      viteUrl: requestedViteUrl,
      pageUrl: requestedPageUrl,
      result,
      state: 'starting',
      updatedAt: Date.now(),
    };
    this.debugStartOperations.set(operationId, operation);
    this.pruneDebugStartOperations();
    const pending: PendingDebugStart = {
      operationId,
      configurationName,
      viteUrl: requestedViteUrl,
      pageUrl: requestedPageUrl,
      result,
    };
    this.pendingDebugStarts.set(pendingKey, pending);
    void completion.then((started) => {
      if (operation.state === 'terminated' || operation.state === 'failed') return;
      operation.state = started ? 'accepted' : 'declined';
      operation.updatedAt = Date.now();
      if (!started) {
        operation.message = `VS Code declined Vite debug configuration ${configurationName}`;
        logger.warn(operation.message);
        this.releasePendingDebugStart(operation);
        this.cleanupFailedDebugStart(operationId, workspaceRoot);
      }
    }).catch((error) => {
      if (operation.state === 'terminated' || operation.state === 'failed') return;
      operation.state = 'failed';
      operation.updatedAt = Date.now();
      operation.message = this.debugStartError(configurationName, error);
      logger.warn(operation.message);
      this.releasePendingDebugStart(operation);
      this.cleanupFailedDebugStart(operationId, workspaceRoot);
    }).finally(() => {
      if (this.pendingDebugStarts.get(pendingKey) === pending) {
        this.pendingDebugStarts.delete(pendingKey);
      }
    });
    return result;
  }

  private cleanupFailedDebugStart(operationId: string, workspaceRoot: string): void {
    const sessions = this.registry.takeByStartOperationId(operationId, workspaceRoot);
    for (const session of sessions) {
      void Promise.resolve(vscode.debug.stopDebugging(session)).catch((error) => {
        logger.debug(`Could not stop rejected Vite debug session ${session.id}: ${String(error)}`);
      });
    }
  }

  private releasePendingDebugStart(operation: DebugStartOperation): void {
    const pending = this.pendingDebugStarts.get(operation.workspaceKey);
    if (pending?.operationId === operation.operationId) {
      this.pendingDebugStarts.delete(operation.workspaceKey);
    }
  }

  private workspaceKey(workspaceRoot: string): string {
    return process.platform === 'win32'
      ? workspaceRoot.toLocaleLowerCase('en-US')
      : workspaceRoot;
  }

  private debugStartError(configurationName: string, error: unknown): string {
    const detail = (error instanceof Error ? error.message : String(error))
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');
    const message = `Could not start Vite debug configuration ${configurationName}: ${detail}`;
    return message.length <= MAX_DEBUG_START_ERROR_CHARS
      ? message
      : `${message.slice(0, MAX_DEBUG_START_ERROR_CHARS - 1)}…`;
  }

  private pruneDebugStartOperations(now = Date.now()): void {
    for (const [operationId, operation] of this.debugStartOperations) {
      if (operation.state !== 'starting' && now - operation.updatedAt > DEBUG_START_OPERATION_TTL_MS) {
        this.debugStartOperations.delete(operationId);
      }
    }
    while (this.debugStartOperations.size > MAX_DEBUG_START_OPERATIONS) {
      const oldestCompleted = Array.from(this.debugStartOperations.entries())
        .find(([, operation]) => operation.state !== 'starting')?.[0];
      if (!oldestCompleted) break;
      this.debugStartOperations.delete(oldestCompleted);
    }
  }

  private selectViteDebugConfiguration(
    configurations: readonly DebugConfigurationDescription[],
    requestedName: string | undefined,
  ): DebugConfigurationDescription | undefined {
    if (requestedName) {
      const matches = configurations.filter((candidate) => candidate.name === requestedName);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        throw new RpcError(-32022, `Vite debug configuration name is ambiguous: ${requestedName}`);
      }
      throw new RpcError(
        -32022,
        `Vite debug configuration not found: ${requestedName}`,
        { availableConfigurations: configurations.map((candidate) => candidate.name) },
      );
    }

    const preferred = configurations.filter((candidate) => candidate.name === DEFAULT_DEBUG_CONFIGURATION);
    if (preferred.length === 1) return preferred[0];
    if (preferred.length > 1) {
      throw new RpcError(-32022, `Vite debug configuration name is ambiguous: ${DEFAULT_DEBUG_CONFIGURATION}`);
    }
    if (configurations.length === 1) return configurations[0];
    if (configurations.length > 1) {
      throw new RpcError(
        -32022,
        'Multiple Vite debug configurations are available; pass configurationName explicitly',
        { availableConfigurations: configurations.map((candidate) => candidate.name) },
      );
    }
    return undefined;
  }

  private workspaceFolderForRoot(workspaceRoot: string): vscode.WorkspaceFolder | undefined {
    const expected = process.platform === 'win32'
      ? workspaceRoot.toLocaleLowerCase('en-US')
      : workspaceRoot;
    return vscode.workspace.workspaceFolders?.find((folder) => {
      if (folder.uri.scheme !== 'file' && folder.uri.scheme !== 'vscode-remote') return false;
      const canonical = canonicalizeWorkspaceRoot(folder.uri.fsPath);
      const actual = process.platform === 'win32'
        ? canonical.toLocaleLowerCase('en-US')
        : canonical;
      return actual === expected;
    });
  }

  private viteDebugConfigurations(folder: vscode.WorkspaceFolder): DebugConfigurationDescription[] {
    const raw = vscode.workspace.getConfiguration('launch', folder.uri).get<unknown>('configurations');
    if (!Array.isArray(raw)) return [];
    const configurations: DebugConfigurationDescription[] = [];
    for (const value of raw) {
      if (!isRecord(value) || value.type !== 'vite') continue;
      if (typeof value.name !== 'string') continue;
      const name = value.name.trim();
      if (name.length === 0 || name.length > MAX_DEBUG_CONFIGURATION_NAME || /[\x00-\x1f\x7f]/.test(name)) {
        continue;
      }
      if (value.request !== 'launch' && value.request !== 'attach') continue;
      configurations.push({
        name,
        request: value.request,
        preLaunchTask: typeof value.preLaunchTask === 'string' && value.preLaunchTask.length > 0,
        configuration: { ...value, name } as vscode.DebugConfiguration,
      });
    }
    return configurations;
  }

  private readWorkspaceRoot(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0) {
      throw new RpcError(-32602, 'workspaceRoot must be a non-empty string');
    }
    const canonical = canonicalizeWorkspaceRoot(value);
    const key = process.platform === 'win32'
      ? canonical.toLocaleLowerCase('en-US')
      : canonical;
    const served = this.roots.some((root) => (
      process.platform === 'win32' ? root.toLocaleLowerCase('en-US') : root
    ) === key);
    if (!served) throw new RpcError(-32602, 'workspaceRoot is not served by this VS Code window');
    return canonical;
  }

  private matchesToken(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const expected = Buffer.from(this.token, 'utf8');
    const actual = Buffer.from(value, 'utf8');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  private requestId(parsed: unknown): JsonRpcId {
    if (!isRecord(parsed)) return null;
    const id = parsed.id;
    return typeof id === 'string' || typeof id === 'number' || id === null ? id : null;
  }

  private sendError(
    socket: net.Socket,
    id: JsonRpcId,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    const error: RpcErrorShape = { code, message };
    if (data !== undefined) error.data = data;
    this.send(socket, { jsonrpc: '2.0', id, error });
  }

  private send(socket: net.Socket, payload: unknown): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
  }
}
