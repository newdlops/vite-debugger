import { promises as fs } from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export type McpDiagnosticStatus = 'pass' | 'warn' | 'fail';

export type McpConfigurationState = 'configured' | 'missing' | 'stale' | 'invalid';

export interface McpConfigurationDiagnosticInput {
  /** Stable identifier used in the structured report, for example `codex`. */
  id: string;
  label: string;
  filePath: string;
  state: McpConfigurationState;
  /** A caller-supplied explanation. Configuration contents must not be passed here. */
  message?: string;
}

export interface McpDiagnosticCheck {
  id: string;
  title: string;
  status: McpDiagnosticStatus;
  message: string;
}

export interface McpDiagnosticSummary {
  status: McpDiagnosticStatus;
  pass: number;
  warn: number;
  fail: number;
}

export interface McpDiagnosticStderr {
  text: string;
  truncated: boolean;
  capturedBytes: number;
}

export interface McpDiagnosticReport {
  workspacePath: string;
  launcherPath: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: McpDiagnosticSummary;
  checks: McpDiagnosticCheck[];
  server?: {
    name?: string;
    version?: string;
  };
  tools: string[];
  /** Parsed, bounded debug_status payload when the tool returned JSON text. */
  debugStatus?: Record<string, unknown>;
  stderr?: McpDiagnosticStderr;
  markdown: string;
}

export interface DiagnoseMcpOptions {
  launcherPath: string;
  workspacePath: string;
  /** Defaults to `node`, matching the generated Codex and Claude configurations. */
  nodeCommand?: string;
  /** Tools that must be advertised. Extra tools are accepted. */
  requiredTools?: readonly string[];
  /** Read-only configuration findings prepared by the extension command. */
  configurations?: readonly McpConfigurationDiagnosticInput[];
  /** Overall subprocess handshake, listTools, and debug_status deadline. */
  timeoutMs?: number;
  /** Maximum stderr bytes retained in the report. */
  maxStderrBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_STDERR_BYTES = 8 * 1024;
const MAX_TIMEOUT_MS = 60_000;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_STATUS_TEXT_CHARS = 300_000;
const CLOSE_TIMEOUT_MS = 2_500;

class McpDiagnosticTimeoutError extends Error {
  constructor(label: string) {
    super(`Timed out while ${label}`);
    this.name = 'McpDiagnosticTimeoutError';
  }
}

class StderrCapture {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private wasTruncated = false;

  constructor(private readonly limit: number) {}

  append(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = this.limit - this.bytes;
    if (remaining <= 0) {
      if (chunk.length > 0) this.wasTruncated = true;
      return;
    }

    const retained = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
    this.chunks.push(Buffer.from(retained));
    this.bytes += retained.length;
    if (retained.length < chunk.length) this.wasTruncated = true;
  }

  result(): McpDiagnosticStderr | undefined {
    if (this.bytes === 0 && !this.wasTruncated) return undefined;
    return {
      text: redactDiagnosticText(Buffer.concat(this.chunks).toString('utf8').trim()),
      truncated: this.wasTruncated,
      capturedBytes: this.bytes,
    };
  }
}

/**
 * Exercise the exact process shape written into agent configuration:
 *
 *   node <stable-launcher> --workspace <project>
 *
 * The probe is deliberately read-only. It performs the MCP handshake,
 * lists tools, and calls only debug_status. Every child-process path is
 * argument-based (never shell-expanded), stderr is bounded, and cleanup runs
 * even when initialization or a request times out.
 */
export async function diagnoseMcp(options: DiagnoseMcpOptions): Promise<McpDiagnosticReport> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const checks: McpDiagnosticCheck[] = [];
  const tools: string[] = [];
  let debugStatus: Record<string, unknown> | undefined;
  let server: McpDiagnosticReport['server'];
  let stderr: McpDiagnosticStderr | undefined;

  const workspacePath = path.resolve(options.workspacePath);
  const launcherPath = path.resolve(options.launcherPath);
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
  const maxStderrBytes = boundedInteger(
    options.maxStderrBytes,
    DEFAULT_MAX_STDERR_BYTES,
    1,
    MAX_STDERR_BYTES,
  );

  const workspaceReady = await diagnoseWorkspace(workspacePath, checks);
  const launcherReady = await diagnoseLauncher(launcherPath, checks);
  addConfigurationChecks(options.configurations ?? [], checks);

  if (workspaceReady && launcherReady) {
    const capture = new StderrCapture(maxStderrBytes);
    const deadline = Date.now() + timeoutMs;
    const transport = new StdioClientTransport({
      command: options.nodeCommand ?? 'node',
      args: [launcherPath, '--workspace', workspacePath],
      cwd: workspacePath,
      stderr: 'pipe',
    });
    const stderrStream = transport.stderr;
    const onStderr = (chunk: Buffer | string) => capture.append(chunk);
    stderrStream?.on('data', onStderr);

    const client = new Client({
      name: 'vite-debugger-mcp-diagnostics',
      version: '1.0.0',
    });
    let connected = false;

    try {
      await beforeDeadline(client.connect(transport), deadline, 'starting the MCP stdio server');
      connected = true;
      const implementation = client.getServerVersion();
      server = implementation
        ? { name: implementation.name, version: implementation.version }
        : undefined;
      checks.push({
        id: 'stdio.handshake',
        title: 'MCP stdio handshake',
        status: 'pass',
        message: implementation
          ? `Connected to ${implementation.name}@${implementation.version}.`
          : 'MCP initialization completed.',
      });

      const listed = await beforeDeadline(client.listTools(), deadline, 'listing MCP tools');
      tools.push(...listed.tools
        .map((tool) => tool.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
        .sort());

      const requiredTools = [...new Set(options.requiredTools ?? ['debug_status'])];
      const missingTools = requiredTools.filter((name) => !tools.includes(name));
      checks.push(missingTools.length === 0
        ? {
          id: 'stdio.tools',
          title: 'MCP tools',
          status: 'pass',
          message: `Advertised ${tools.length} tool(s); all ${requiredTools.length} required tool(s) are present.`,
        }
        : {
          id: 'stdio.tools',
          title: 'MCP tools',
          status: 'fail',
          message: `Missing required tool(s): ${missingTools.join(', ')}.`,
        });

      if (tools.includes('debug_status')) {
        const statusResult = await beforeDeadline(
          client.callTool({ name: 'debug_status', arguments: {} }),
          deadline,
          'calling debug_status',
        );
        const classified = classifyDebugStatus(statusResult);
        debugStatus = classified.payload;
        checks.push(classified.check);
      } else {
        checks.push({
          id: 'debug.status',
          title: 'Debugger bridge',
          status: 'fail',
          message: 'debug_status is not advertised, so the VS Code bridge could not be tested.',
        });
      }
    } catch (error) {
      checks.push({
        id: connected ? 'stdio.request' : 'stdio.handshake',
        title: connected ? 'MCP request path' : 'MCP stdio handshake',
        status: 'fail',
        message: boundedMessage(error),
      });
    } finally {
      await closeWithLimit(client, transport);
      stderrStream?.off('data', onStderr);
      stderr = capture.result();
      if (stderr?.text) {
        checks.push({
          id: 'stdio.stderr',
          title: 'MCP stderr',
          status: 'warn',
          message: stderr.truncated
            ? `The MCP process wrote stderr; only the first ${stderr.capturedBytes} bytes were retained.`
            : `The MCP process wrote ${stderr.capturedBytes} byte(s) to stderr.`,
        });
      }
    }
  } else {
    checks.push({
      id: 'stdio.handshake',
      title: 'MCP stdio handshake',
      status: 'fail',
      message: 'Skipped because the workspace or stable launcher is not usable.',
    });
  }

  const finishedAtMs = Date.now();
  const summary = summarize(checks);
  const reportWithoutMarkdown: Omit<McpDiagnosticReport, 'markdown'> = {
    workspacePath,
    launcherPath,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    summary,
    checks,
    server,
    tools,
    debugStatus,
    stderr,
  };

  return {
    ...reportWithoutMarkdown,
    markdown: renderMcpDiagnosticMarkdown(reportWithoutMarkdown),
  };
}

export function renderMcpDiagnosticMarkdown(
  report: Omit<McpDiagnosticReport, 'markdown'>,
): string {
  const lines = [
    '# Vite Debugger MCP Diagnostics',
    '',
    `- Overall: **${report.summary.status.toUpperCase()}**`,
    `- Workspace: \`${escapeInlineCode(report.workspacePath)}\``,
    `- Launcher: \`${escapeInlineCode(report.launcherPath)}\``,
    `- Duration: ${report.durationMs} ms`,
    '',
    '| Check | Result | Details |',
    '| --- | --- | --- |',
    ...report.checks.map((check) => (
      `| ${escapeTable(check.title)} | **${check.status.toUpperCase()}** | ${escapeTable(check.message)} |`
    )),
  ];

  if (report.tools.length > 0) {
    lines.push('', '## Advertised tools', '');
    for (const tool of report.tools) lines.push(`- \`${escapeInlineCode(tool)}\``);
  }

  if (report.stderr?.text) {
    lines.push('', '## Bounded stderr', '');
    for (const line of report.stderr.text.split(/\r?\n/)) {
      lines.push(`> ${line.replace(/^>/, '\\>')}`);
    }
    if (report.stderr.truncated) lines.push('', '_stderr was truncated._');
  }

  return `${lines.join('\n')}\n`;
}

async function diagnoseWorkspace(
  workspacePath: string,
  checks: McpDiagnosticCheck[],
): Promise<boolean> {
  try {
    const stat = await fs.stat(workspacePath);
    if (!stat.isDirectory()) throw new Error('Workspace path is not a directory.');
    checks.push({
      id: 'workspace',
      title: 'Workspace',
      status: 'pass',
      message: 'The local workspace directory is accessible.',
    });
    return true;
  } catch (error) {
    checks.push({
      id: 'workspace',
      title: 'Workspace',
      status: 'fail',
      message: boundedMessage(error),
    });
    return false;
  }
}

async function diagnoseLauncher(
  launcherPath: string,
  checks: McpDiagnosticCheck[],
): Promise<boolean> {
  try {
    const stat = await fs.lstat(launcherPath);
    if (stat.isSymbolicLink()) throw new Error('Stable MCP launcher is a symbolic link.');
    if (!stat.isFile()) throw new Error('Stable MCP launcher is not a regular file.');
    checks.push({
      id: 'launcher',
      title: 'Stable launcher',
      status: 'pass',
      message: 'The stable MCP launcher exists and is a regular file.',
    });
    return true;
  } catch (error) {
    checks.push({
      id: 'launcher',
      title: 'Stable launcher',
      status: 'fail',
      message: boundedMessage(error),
    });
    return false;
  }
}

function addConfigurationChecks(
  configurations: readonly McpConfigurationDiagnosticInput[],
  checks: McpDiagnosticCheck[],
): void {
  for (const configuration of configurations) {
    const defaults: Record<McpConfigurationState, { status: McpDiagnosticStatus; message: string }> = {
      configured: { status: 'pass', message: 'Configuration matches the current stable launcher.' },
      missing: { status: 'warn', message: 'Configuration file is not present.' },
      stale: { status: 'fail', message: 'Configuration exists but does not match the current launcher.' },
      invalid: { status: 'fail', message: 'Configuration could not be parsed or validated.' },
    };
    const selected = defaults[configuration.state];
    checks.push({
      id: `configuration.${configuration.id}`,
      title: `${configuration.label} configuration`,
      status: selected.status,
      message: configuration.message
        ? `${configuration.message} (${configuration.filePath})`
        : `${selected.message} (${configuration.filePath})`,
    });
  }
}

function classifyDebugStatus(result: unknown): {
  check: McpDiagnosticCheck;
  payload?: Record<string, unknown>;
} {
  const record = isRecord(result) ? result : {};
  const text = extractTextContent(record.content);
  const payload = parseBoundedRecord(text);

  if (record.isError === true) {
    const noSession = /no active vite debug session/i.test(text);
    return {
      check: {
        id: 'debug.status',
        title: 'Debugger bridge',
        status: noSession ? 'warn' : 'fail',
        message: noSession
          ? 'The MCP server reached VS Code, but no Vite debug session is active.'
          : boundedText(text || 'debug_status returned an MCP tool error.', 1_000),
      },
      payload,
    };
  }

  if (!payload) {
    return {
      check: {
        id: 'debug.status',
        title: 'Debugger bridge',
        status: 'warn',
        message: 'debug_status succeeded but did not return a JSON object.',
      },
    };
  }

  if (payload.selectionRequired === true) {
    const sessions = Array.isArray(payload.sessions) ? payload.sessions.length : undefined;
    return {
      check: {
        id: 'debug.status',
        title: 'Debugger bridge',
        status: 'warn',
        message: sessions === undefined
          ? 'The bridge is reachable; an explicit debug session selection is required.'
          : `The bridge is reachable; choose one of ${sessions} active debug sessions.`,
      },
      payload,
    };
  }

  if (payload.connected === false) {
    return {
      check: {
        id: 'debug.status',
        title: 'Debugger bridge',
        status: 'warn',
        message: 'The Vite debug session exists but its Chrome debugger is not connected.',
      },
      payload,
    };
  }

  return {
    check: {
      id: 'debug.status',
      title: 'Debugger bridge',
      status: 'pass',
      message: 'debug_status completed through the project-scoped VS Code bridge.',
    },
    payload,
  };
}

function extractTextContent(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .flatMap((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string'
      ? [item.text]
      : [])
    .join('\n')
    .slice(0, MAX_STATUS_TEXT_CHARS);
}

function parseBoundedRecord(value: string): Record<string, unknown> | undefined {
  if (!value || value.length > MAX_STATUS_TEXT_CHARS) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function summarize(checks: readonly McpDiagnosticCheck[]): McpDiagnosticSummary {
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const check of checks) summary[check.status] += 1;
  return {
    status: summary.fail > 0 ? 'fail' : summary.warn > 0 ? 'warn' : 'pass',
    ...summary,
  };
}

async function beforeDeadline<T>(promise: Promise<T>, deadline: number, label: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new McpDiagnosticTimeoutError(label);

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new McpDiagnosticTimeoutError(label)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeWithLimit(client: Client, transport: StdioClientTransport): Promise<void> {
  const close = async () => {
    try {
      await client.close();
    } catch {
      await transport.close().catch(() => undefined);
    }
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      close(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // If Client.close itself stalled, make one final best-effort transport close.
    void transport.close().catch(() => undefined);
  }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundedText(redactDiagnosticText(message), 1_000);
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(
      /("(?:token|authorization|cookie|password|secret|api[-_]?key)"\s*:\s*")([^"]*)(")/gi,
      '$1[REDACTED]$3',
    )
    .replace(
      /((?:token|authorization|cookie|password|secret|api[-_]?key)\s*[=:]\s*)([^\s,;]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]');
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, '\\`').replace(/[\r\n]+/g, ' ');
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
