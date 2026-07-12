import { promises as fs } from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const MANIFEST_DIRECTORY = path.join(os.tmpdir(), 'vite-debugger-mcp');
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_HEARTBEAT_AGE_MS = 90_000;

export interface BridgeManifest {
  schemaVersion: number;
  windowId: string;
  pid: number;
  port: number;
  token: string;
  roots: string[];
  heartbeat: number | string;
}

export interface BridgeSessionMetadata {
  sessionId: string;
  [key: string]: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer: NodeJS.Timeout;
}

interface DiscoveredBridge {
  manifest: BridgeManifest;
  workspaceRoot: string;
}

export class BridgeRpcError extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = 'BridgeRpcError';
    this.code = code;
    this.data = data;
  }
}

/**
 * Authenticated newline-delimited JSON-RPC client for the bridge owned by one
 * VS Code window. Nothing from this class is written to stdout because stdout
 * is reserved for MCP's stdio transport.
 */
export class BridgeClient {
  readonly workspace: string;

  private manifest: BridgeManifest | undefined;
  private matchedWorkspaceRoot: string | undefined;
  private socket: net.Socket | undefined;
  private connecting: Promise<void> | undefined;
  private readBuffer = '';
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  private constructor(workspace: string) {
    this.workspace = workspace;
  }

  static async forWorkspace(workspace: string): Promise<BridgeClient> {
    const canonicalWorkspace = await canonicalPath(workspace);
    // Keep bridge discovery lazy. This lets the MCP server finish its stdio
    // handshake even when an agent starts before VS Code has activated the
    // extension; the next tool call can discover the newly-created bridge.
    return new BridgeClient(canonicalWorkspace);
  }

  /** Exact manifest root matched during discovery (not a nested process cwd). */
  get workspaceRoot(): string {
    if (!this.matchedWorkspaceRoot) {
      throw new Error('Vite Debugger bridge workspace root is not resolved');
    }
    return this.matchedWorkspaceRoot;
  }

  static workspaceFromArgv(argv: readonly string[], cwd = process.cwd()): string {
    let workspace: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index];
      if (argument === '--workspace') {
        workspace = argv[index + 1];
        if (!workspace) {
          throw new Error('--workspace requires a directory path');
        }
        index += 1;
      } else if (argument.startsWith('--workspace=')) {
        workspace = argument.slice('--workspace='.length);
        if (!workspace) {
          throw new Error('--workspace requires a directory path');
        }
      }
    }
    return path.resolve(cwd, workspace ?? '.');
  }

  async listSessions<T = unknown>(): Promise<T> {
    return this.request<T>('listSessions', {});
  }

  async sessionRequest<T = unknown>(
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return this.request<T>('sessionRequest', { sessionId, method, params });
  }

  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.connecting = undefined;
    this.failPending(new Error('Vite Debugger bridge connection closed'));
    if (socket && !socket.destroyed) {
      socket.destroy();
    }
  }

  private async request<T>(
    method: string,
    params: Record<string, unknown>,
    mayRetry = true,
  ): Promise<T> {
    try {
      await this.ensureConnected();
      return await this.send<T>(method, params);
    } catch (error) {
      if (!mayRetry || error instanceof BridgeRpcError) {
        throw error;
      }

      // Extension Host reloads rotate both port and token. Rediscover once on
      // transport failure so a long-running MCP process follows that rotation.
      this.resetTransport(toError(error));
      const discovered = await discoverManifest(this.workspace);
      this.manifest = discovered.manifest;
      this.matchedWorkspaceRoot = discovered.workspaceRoot;
      return this.request<T>(method, params, false);
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.socket.readyState === 'open') {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    let manifest = this.manifest;
    if (!manifest) {
      const discovered = await discoverManifest(this.workspace);
      manifest = discovered.manifest;
      this.manifest = manifest;
      this.matchedWorkspaceRoot = discovered.workspaceRoot;
    }
    const socket = net.createConnection({ host: '127.0.0.1', port: manifest.port });
    socket.setEncoding('utf8');
    socket.setNoDelay(true);

    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        socket.off('error', onInitialError);
        resolve();
      };
      const onInitialError = (error: Error) => {
        socket.off('connect', onConnect);
        socket.destroy();
        reject(error);
      };
      socket.once('connect', onConnect);
      socket.once('error', onInitialError);
    });

    this.readBuffer = '';
    this.socket = socket;
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (error) => this.onTransportEnded(error));
    socket.on('close', () => this.onTransportEnded(new Error('Vite Debugger bridge disconnected')));
  }

  private send<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const socket = this.socket;
    const manifest = this.manifest;
    if (!socket || socket.destroyed || !manifest) {
      return Promise.reject(new Error('Vite Debugger bridge is not connected'));
    }

    const id = this.nextRequestId++;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: { ...params, workspaceRoot: this.workspaceRoot, token: manifest.token },
    });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Vite Debugger bridge request timed out: ${method}`));
      }, DEFAULT_REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      socket.write(`${payload}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  private onData(chunk: string): void {
    this.readBuffer += chunk;
    if (Buffer.byteLength(this.readBuffer, 'utf8') > MAX_MESSAGE_BYTES) {
      this.resetTransport(new Error('Vite Debugger bridge response exceeded size limit'));
      return;
    }

    for (;;) {
      const newline = this.readBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.readBuffer.slice(0, newline).trim();
      this.readBuffer = this.readBuffer.slice(newline + 1);
      if (!line) continue;

      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch {
        this.resetTransport(new Error('Vite Debugger bridge sent invalid JSON'));
        return;
      }

      if (response.jsonrpc !== '2.0' || typeof response.id !== 'number') {
        continue;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);

      if (response.error) {
        pending.reject(new BridgeRpcError(
          response.error.message ?? 'Vite Debugger bridge request failed',
          response.error.code,
          response.error.data,
        ));
      } else {
        pending.resolve(response.result);
      }
    }
  }

  private onTransportEnded(error: Error): void {
    if (!this.socket) return;
    this.resetTransport(error);
  }

  private resetTransport(error: Error): void {
    const socket = this.socket;
    this.socket = undefined;
    this.connecting = undefined;
    this.readBuffer = '';
    if (socket && !socket.destroyed) socket.destroy();
    this.failPending(error);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function discoverManifest(workspace: string): Promise<DiscoveredBridge> {
  let names: string[];
  try {
    names = await fs.readdir(MANIFEST_DIRECTORY);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(
        `No Vite Debugger MCP bridge is running for ${workspace}. ` +
        'Open this project in VS Code and activate the Vite Debugger extension.',
      );
    }
    throw error;
  }

  const candidates: Array<{ manifest: BridgeManifest; workspaceRoot: string; score: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const manifestPath = path.join(MANIFEST_DIRECTORY, name);
    try {
      const stat = await fs.lstat(manifestPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) continue;
      const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown;
      const manifest = parseManifest(parsed);
      if (!manifest || !heartbeatIsFresh(manifest.heartbeat) || !processIsAlive(manifest.pid)) continue;

      let bestScore = -1;
      let bestRoot: string | undefined;
      for (const root of manifest.roots) {
        const canonicalRoot = await canonicalPath(root);
        if (workspace === canonicalRoot) {
          const score = 1_000_000 + canonicalRoot.length;
          if (score > bestScore) {
            bestScore = score;
            bestRoot = canonicalRoot;
          }
        } else if (pathContains(canonicalRoot, workspace)) {
          const score = canonicalRoot.length;
          if (score > bestScore) {
            bestScore = score;
            bestRoot = canonicalRoot;
          }
        }
      }
      if (bestScore >= 0 && bestRoot) {
        candidates.push({ manifest, workspaceRoot: bestRoot, score: bestScore });
      }
    } catch {
      // A bridge may rotate a manifest between readdir and read. Invalid or
      // partially-written files are ignored and will be considered next call.
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `No live Vite Debugger MCP bridge matches workspace ${workspace}. ` +
      'Start or reload the extension in the VS Code window for this project.',
    );
  }

  const topScore = Math.max(...candidates.map((candidate) => candidate.score));
  const best = candidates.filter((candidate) => candidate.score === topScore);
  if (best.length !== 1) {
    throw new Error(
      `Multiple VS Code windows expose Vite Debugger for ${workspace}. ` +
      `Close duplicate windows or pass a workspace unique to one window. ` +
      `Window IDs: ${best.map(({ manifest }) => manifest.windowId).join(', ')}`,
    );
  }
  return { manifest: best[0].manifest, workspaceRoot: best[0].workspaceRoot };
}

function parseManifest(value: unknown): BridgeManifest | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== 1) return undefined;
  if (typeof value.windowId !== 'string' || !value.windowId) return undefined;
  if (!Number.isInteger(value.pid) || (value.pid as number) <= 0) return undefined;
  if (!Number.isInteger(value.port) || (value.port as number) <= 0 || (value.port as number) > 65535) {
    return undefined;
  }
  if (typeof value.token !== 'string' || value.token.length < 16) return undefined;
  if (!Array.isArray(value.roots) || value.roots.length === 0 ||
      !value.roots.every((root) => typeof root === 'string' && path.isAbsolute(root))) {
    return undefined;
  }
  if (typeof value.heartbeat !== 'number' && typeof value.heartbeat !== 'string') return undefined;
  return value as unknown as BridgeManifest;
}

async function canonicalPath(value: string): Promise<string> {
  const absolute = path.resolve(value);
  try {
    return path.normalize(await fs.realpath(absolute));
  } catch {
    return path.normalize(absolute);
  }
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === 'EPERM';
  }
}

function heartbeatIsFresh(value: number | string): boolean {
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(timestamp) && Date.now() - timestamp <= MAX_HEARTBEAT_AGE_MS;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
