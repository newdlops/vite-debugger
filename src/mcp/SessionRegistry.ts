import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface RegisteredSession {
  readonly sessionId: string;
  readonly name: string;
  readonly type: string;
  readonly request?: 'launch' | 'attach';
  readonly workspaceRoot?: string;
  readonly startOperationId?: string;
  readonly startedAt: number;
}

interface SessionEntry extends RegisteredSession {
  readonly session: vscode.DebugSession;
}

function isHostFileWorkspace(folder: vscode.WorkspaceFolder): boolean {
  return (folder.uri.scheme === 'file' || folder.uri.scheme === 'vscode-remote') &&
    path.isAbsolute(folder.uri.fsPath);
}

/**
 * Resolve workspace paths once at the bridge boundary.  Both the manifest
 * lookup performed by the stdio process and session filtering use this same
 * representation, so a symlinked cwd cannot accidentally select a different
 * VS Code window.
 */
export function canonicalizeWorkspaceRoot(root: string): string {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    // The workspace may have been removed while VS Code is shutting down.
    return path.normalize(resolved);
  }
}

function rootKey(root: string): string {
  const canonical = canonicalizeWorkspaceRoot(root);
  return process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical;
}

/** Keeps the VS Code-side DebugSession objects used by the MCP bridge. */
export class SessionRegistry implements vscode.Disposable {
  private readonly sessions = new Map<string, SessionEntry>();

  register(session: vscode.DebugSession): void {
    if (session.type !== 'vite') return;

    const previous = this.sessions.get(session.id);
    const workspaceRoot = session.workspaceFolder && isHostFileWorkspace(session.workspaceFolder)
      ? canonicalizeWorkspaceRoot(session.workspaceFolder.uri.fsPath)
      : undefined;
    const rawStartOperationId = session.configuration?._viteDebuggerMcpStartId;
    const configuredStartOperationId = typeof rawStartOperationId === 'string' &&
      /^[0-9a-f-]{36}$/i.test(rawStartOperationId)
      ? rawStartOperationId
      : undefined;
    const configuredRequest = session.configuration?.request === 'launch' ||
      session.configuration?.request === 'attach'
      ? session.configuration.request
      : undefined;

    this.sessions.set(session.id, {
      session,
      sessionId: session.id,
      name: session.name,
      type: session.type,
      request: configuredRequest ?? previous?.request,
      workspaceRoot: workspaceRoot ?? previous?.workspaceRoot,
      startOperationId: configuredStartOperationId ?? previous?.startOperationId,
      startedAt: previous?.startedAt ?? Date.now(),
    });
  }

  unregister(sessionOrId: vscode.DebugSession | string): void {
    const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id;
    this.sessions.delete(id);
  }

  /**
   * Remove and return sessions created for one MCP start operation. A debug
   * adapter can reject launch before VS Code emits onDidTerminate, so the
   * bridge must be able to evict that otherwise-unusable session explicitly.
   */
  takeByStartOperationId(operationId: string, workspaceRoot?: string): vscode.DebugSession[] {
    const requestedRoot = workspaceRoot === undefined ? undefined : rootKey(workspaceRoot);
    const matches: vscode.DebugSession[] = [];
    for (const [sessionId, entry] of this.sessions) {
      if (entry.startOperationId !== operationId) continue;
      if (requestedRoot !== undefined && (
        entry.workspaceRoot === undefined || rootKey(entry.workspaceRoot) !== requestedRoot
      )) {
        continue;
      }
      this.sessions.delete(sessionId);
      matches.push(entry.session);
    }
    return matches;
  }

  list(workspaceRoot?: string): RegisteredSession[] {
    const requestedRoot = workspaceRoot === undefined ? undefined : rootKey(workspaceRoot);

    return Array.from(this.sessions.values())
      .filter((entry) => requestedRoot === undefined || (
        entry.workspaceRoot !== undefined && rootKey(entry.workspaceRoot) === requestedRoot
      ))
      .map(({ session: _session, ...description }) => description)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  get(sessionId: string, workspaceRoot?: string): vscode.DebugSession | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    if (workspaceRoot === undefined) return entry.session;
    if (!entry.workspaceRoot) return undefined;
    return rootKey(entry.workspaceRoot) === rootKey(workspaceRoot) ? entry.session : undefined;
  }

  dispose(): void {
    this.sessions.clear();
  }
}
