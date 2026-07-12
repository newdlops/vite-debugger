import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from '../util/Logger';
import { canonicalizeWorkspaceRoot, SessionRegistry } from './SessionRegistry';

const BRIDGE_SCHEMA_VERSION = 1;
const HEARTBEAT_INTERVAL_MS = 10_000;
const STALE_MANIFEST_MS = 60_000;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
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
