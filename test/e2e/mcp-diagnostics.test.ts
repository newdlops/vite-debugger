import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  diagnoseMcp,
  type McpConfigurationDiagnosticInput,
} from '../../src/mcp/McpDiagnostics';

interface FakeLauncherOptions {
  tools?: string[];
  status?: Record<string, unknown>;
  statusError?: string;
  stderr?: string;
  hang?: boolean;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(options: FakeLauncherOptions = {}): Promise<{
  workspacePath: string;
  launcherPath: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vite-debugger-mcp-diagnostics-'));
  temporaryDirectories.push(root);
  const workspacePath = path.join(root, 'workspace');
  const launcherPath = path.join(root, 'vite-debugger-mcp.cjs');
  await fs.mkdir(workspacePath);

  const tools = options.tools ?? ['debug_status', 'debug_snapshot'];
  const status = options.status ?? {
    workspace: workspacePath,
    sessionId: 'vite-session-1',
    connected: true,
    chromePort: 9222,
    targets: [{ targetId: 'target-1', paused: false }],
  };

  const source = `
'use strict';
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const expectedWorkspace = ${JSON.stringify(workspacePath)};
const toolNames = ${JSON.stringify(tools)};
const status = ${JSON.stringify(status)};
const statusError = ${JSON.stringify(options.statusError ?? null)};
const canonical = (value) => {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
};
if (canonical(process.cwd()) !== canonical(expectedWorkspace) || process.argv[2] !== '--workspace' ||
    canonical(process.argv[3] || '') !== canonical(expectedWorkspace)) {
  process.stderr.write('launcher arguments or cwd did not match the project');
  process.exit(2);
}
${options.stderr ? `process.stderr.write(${JSON.stringify(options.stderr)});` : ''}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (${options.hang === true ? 'true' : 'false'}) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
  let result;
  if (message.method === 'initialize') {
    result = {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-vite-debugger', version: '9.8.7' },
      instructions: 'fake diagnostic fixture',
    };
  } else if (message.method === 'tools/list') {
    result = {
      tools: toolNames.map((name) => ({
        name,
        description: name,
        inputSchema: { type: 'object', properties: {} },
      })),
    };
  } else if (message.method === 'tools/call' && message.params.name === 'debug_status') {
    result = statusError
      ? { isError: true, content: [{ type: 'text', text: statusError }] }
      : { content: [{ type: 'text', text: JSON.stringify(status) }] };
  } else {
    result = { isError: true, content: [{ type: 'text', text: 'unknown request' }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`;
  await fs.writeFile(launcherPath, source, { encoding: 'utf8', mode: 0o600 });
  return { workspacePath, launcherPath };
}

describe('MCP diagnostics', () => {
  it('runs the stable launcher through stdio and returns a structured passing report', async () => {
    const { workspacePath, launcherPath } = await fixture();
    const configurations: McpConfigurationDiagnosticInput[] = [{
      id: 'codex',
      label: 'Codex',
      filePath: path.join(workspacePath, '.codex', 'config.toml'),
      state: 'configured',
    }];

    const report = await diagnoseMcp({
      workspacePath,
      launcherPath,
      nodeCommand: process.execPath,
      requiredTools: ['debug_status', 'debug_snapshot'],
      configurations,
      timeoutMs: 5_000,
    });

    expect(report.summary).toMatchObject({ status: 'pass', warn: 0, fail: 0 });
    expect(report.server).toEqual({ name: 'fake-vite-debugger', version: '9.8.7' });
    expect(report.tools).toEqual(['debug_snapshot', 'debug_status']);
    expect(report.debugStatus).toMatchObject({
      workspace: workspacePath,
      connected: true,
      chromePort: 9222,
    });
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'stdio.handshake', status: 'pass' }),
      expect.objectContaining({ id: 'stdio.tools', status: 'pass' }),
      expect.objectContaining({ id: 'debug.status', status: 'pass' }),
      expect.objectContaining({ id: 'configuration.codex', status: 'pass' }),
    ]));
    expect(report.stderr).toBeUndefined();
    expect(report.markdown).toContain('Overall: **PASS**');
    expect(report.markdown).toContain('`debug_status`');
  });

  it('treats a reachable bridge without a debug session as a warning and bounds stderr', async () => {
    const { workspacePath, launcherPath } = await fixture({
      statusError: 'No active Vite debug session exists in this VS Code window.',
      stderr: `token=super-secret-value {"authorization":"json-secret"}\n${'x'.repeat(1_000)}`,
    });

    const report = await diagnoseMcp({
      workspacePath,
      launcherPath,
      nodeCommand: process.execPath,
      configurations: [{
        id: 'claude',
        label: 'Claude Code',
        filePath: path.join(workspacePath, '.mcp.json'),
        state: 'missing',
      }],
      timeoutMs: 5_000,
      maxStderrBytes: 64,
    });

    expect(report.summary.status).toBe('warn');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'debug.status', status: 'warn' }),
      expect.objectContaining({ id: 'stdio.stderr', status: 'warn' }),
      expect.objectContaining({ id: 'configuration.claude', status: 'warn' }),
    ]));
    expect(report.stderr).toMatchObject({ truncated: true, capturedBytes: 64 });
    expect(report.stderr?.text).toContain('token=[REDACTED]');
    expect(report.stderr?.text).not.toContain('super-secret-value');
    expect(report.stderr?.text).not.toContain('json-secret');
    expect(report.markdown).toContain('stderr was truncated');
  });

  it('warns when Chrome is connected without a managed Vite page', async () => {
    const { workspacePath, launcherPath } = await fixture({
      status: {
        workspace: 'fixture-workspace',
        sessionId: 'vite-session-1',
        connected: true,
        chromePort: 9222,
        targets: [],
      },
    });

    const report = await diagnoseMcp({
      workspacePath,
      launcherPath,
      nodeCommand: process.execPath,
      timeoutMs: 5_000,
    });

    expect(report.summary.status).toBe('warn');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'debug.status',
        status: 'warn',
        message: expect.stringMatching(/launch session should open.*attach session.*browser_navigate/i),
      }),
    ]));
    expect(report.debugStatus).toMatchObject({ connected: true, targets: [] });
    expect(report.markdown).toContain('Overall: **WARN**');
  });

  it('fails when a required tool is missing while preserving the successful bridge result', async () => {
    const { workspacePath, launcherPath } = await fixture({ tools: ['debug_status'] });
    const report = await diagnoseMcp({
      workspacePath,
      launcherPath,
      nodeCommand: process.execPath,
      requiredTools: ['debug_status', 'browser_snapshot'],
      timeoutMs: 5_000,
    });

    expect(report.summary.status).toBe('fail');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'stdio.tools', status: 'fail' }),
      expect.objectContaining({ id: 'debug.status', status: 'pass' }),
    ]));
  });

  it('enforces an overall request deadline and still terminates the child transport', async () => {
    const { workspacePath, launcherPath } = await fixture({ hang: true });
    const started = Date.now();
    const report = await diagnoseMcp({
      workspacePath,
      launcherPath,
      nodeCommand: process.execPath,
      timeoutMs: 250,
    });

    expect(report.summary.status).toBe('fail');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'stdio.handshake',
        status: 'fail',
        message: expect.stringMatching(/timed out/i),
      }),
    ]));
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('does not spawn a process when the stable launcher is missing', async () => {
    const { workspacePath, launcherPath } = await fixture();
    await fs.unlink(launcherPath);

    const report = await diagnoseMcp({
      workspacePath,
      launcherPath,
      nodeCommand: path.join(workspacePath, 'definitely-not-a-node-binary'),
      timeoutMs: 500,
    });

    expect(report.summary.status).toBe('fail');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'launcher', status: 'fail' }),
      expect.objectContaining({ id: 'stdio.handshake', status: 'fail' }),
    ]));
  });
});
