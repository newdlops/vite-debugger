import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface RegisteredSession {
  readonly sessionId: string;
  readonly name: string;
  readonly type: string;
  readonly workspaceRoot?: string;
  readonly startedAt: number;
}

interface SessionEntry extends RegisteredSession {
  readonly session: vscode.DebugSession;
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
    const workspaceRoot = session.workspaceFolder?.uri.scheme === 'file'
      ? canonicalizeWorkspaceRoot(session.workspaceFolder.uri.fsPath)
      : undefined;

    this.sessions.set(session.id, {
      session,
      sessionId: session.id,
      name: session.name,
      type: session.type,
      workspaceRoot,
      startedAt: previous?.startedAt ?? Date.now(),
    });
  }

  unregister(sessionOrId: vscode.DebugSession | string): void {
    const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id;
    this.sessions.delete(id);
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
