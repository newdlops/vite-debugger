import { describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import {
  AgentConfigurationError,
  AgentMcpLaunch,
  mergeClaudeConfiguration,
  mergeCodexConfiguration,
} from '../../src/mcp/AgentConfiguration';

const launch: AgentMcpLaunch = {
  launcherPath: '/Users/example/Library/Application Support/vite "debugger"/mcp.cjs',
  workspacePath: '/Users/example/프로젝트/vite app',
};

describe('Codex MCP project configuration', () => {
  it('creates a managed project-scoped server block', () => {
    const result = mergeCodexConfiguration(undefined, launch);

    expect(result.change).toBe('created');
    expect(result.content).toContain('# BEGIN VITE DEBUGGER MCP');
    expect(result.content).toContain('[mcp_servers.vite_debugger]');
    expect(result.content).toContain(JSON.stringify(launch.launcherPath));
    expect(result.content).toContain(`cwd = ${JSON.stringify(launch.workspacePath)}`);
    expect(result.content).toContain(`"--workspace", ${JSON.stringify(launch.workspacePath)}`);
    expect(result.content.endsWith('\n')).toBe(true);
  });

  it('encodes TOML control characters in valid basic strings', () => {
    const controlLaunch = {
      launcherPath: '/tmp/vite\u007fdebugger/mcp.cjs',
      workspacePath: 'C:\\Users\\example\\vite app',
    };
    const result = mergeCodexConfiguration(undefined, controlLaunch);

    expect(result.content).toContain('\\u007f');
    expect(result.content).not.toContain('\u007fdebugger');
  });

  it('migrates the legacy section while preserving unrelated TOML and CRLF', () => {
    const existing = [
      '# keep this comment',
      '[mcp_servers.other]',
      'command = "other"',
      '',
      '[mcp_servers.vite_debugger]',
      'command = "old-node"',
      'args = ["old.cjs"]',
      '',
      '[projects."/tmp/example"]',
      'trust_level = "trusted"',
      '',
    ].join('\r\n');

    const result = mergeCodexConfiguration(existing, launch);

    expect(result.change).toBe('updated');
    expect(result.content).toContain('# keep this comment\r\n[mcp_servers.other]');
    expect(result.content).toContain('[projects."/tmp/example"]\r\ntrust_level = "trusted"');
    expect(result.content).not.toContain('old-node');
    expect(result.content.match(/\[mcp_servers\.vite_debugger\]/g)).toHaveLength(1);
    expect(result.content.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('preserves trailing comments while migrating a legacy section', () => {
    const existing = [
      '[mcp_servers.vite_debugger]',
      'command = "old"',
      '',
      '# Important project trust note',
      '[projects.example]',
      'trust_level = "trusted"',
      '',
      '# Keep this EOF note',
      '',
    ].join('\n');

    const result = mergeCodexConfiguration(existing, launch);

    expect(result.content).toContain('# Important project trust note\n[projects.example]');
    expect(result.content).toContain('# Keep this EOF note');
    expect(result.content).not.toContain('command = "old"');
  });

  it('updates only its managed block and is idempotent', () => {
    const first = mergeCodexConfiguration('[mcp_servers.other]\ncommand = "other"\n', launch);
    const nextLaunch = { ...launch, workspacePath: '/tmp/next project' };
    const second = mergeCodexConfiguration(first.content, nextLaunch);
    const third = mergeCodexConfiguration(second.content, nextLaunch);

    expect(second.change).toBe('updated');
    expect(second.content).toContain('command = "other"');
    expect(second.content).toContain(JSON.stringify(nextLaunch.workspacePath));
    expect(second.content).not.toContain(JSON.stringify(launch.workspacePath));
    expect(third.change).toBe('unchanged');
    expect(third.content).toBe(second.content);
  });

  it('rejects incomplete, duplicate, and ambiguous entries', () => {
    expect(() => mergeCodexConfiguration(
      '# BEGIN VITE DEBUGGER MCP (managed by the Vite Debugger extension)\n',
      launch,
    )).toThrow(AgentConfigurationError);

    expect(() => mergeCodexConfiguration(
      '[mcp_servers.vite_debugger]\ncommand = "one"\n\n' +
      '[mcp_servers."vite-debugger"]\ncommand = "two"\n',
      launch,
    )).toThrow(/defines both|More than one/);

    expect(() => mergeCodexConfiguration(
      '[mcp_servers]\nvite_debugger = { command = "node" }\n',
      launch,
    )).toThrow(/unsupported inline or dotted TOML form/);

    expect(() => mergeCodexConfiguration(
      'mcp_servers = { vite_debugger = { command = "node" } }\n',
      launch,
    )).toThrow(/unsupported inline or dotted TOML form/);
  });

  it('supports quoted table keys and refuses layouts it cannot update safely', () => {
    const quoted = mergeCodexConfiguration(
      '["mcp_servers"."vite_debugger"]\ncommand = "old"\n',
      launch,
    );
    expect(quoted.content).toContain('[mcp_servers.vite_debugger]');
    expect(quoted.content).not.toContain('command = "old"');

    expect(() => mergeCodexConfiguration(
      '[mcp_servers]\nvite_debugger.command = "old"\n',
      launch,
    )).toThrow(/unsupported inline or dotted TOML form/);

    const quotedBoundary = [
      '[mcp_servers.vite_debugger]',
      'command = "old"',
      '[projects."foo]bar"]',
      'trust_level = "trusted"',
      '',
    ].join('\n');
    expect(() => mergeCodexConfiguration(quotedBoundary, launch)).toThrow(
      /cannot be updated safely/,
    );

    const markerInString = [
      'message = """',
      '# BEGIN VITE DEBUGGER MCP (managed by the Vite Debugger extension)',
      '[mcp_servers.vite_debugger]',
      '# END VITE DEBUGGER MCP',
      '"""',
      '',
    ].join('\n');
    expect(() => mergeCodexConfiguration(markerInString, launch)).toThrow(
      /not valid TOML|cannot be updated safely|did not contain exactly one/,
    );
  });
});

describe('Claude Code MCP project configuration', () => {
  it('creates a project-scoped stdio server definition', () => {
    const result = mergeClaudeConfiguration(undefined, launch);
    const value = JSON.parse(result.content);

    expect(result.change).toBe('created');
    expect(value.mcpServers['vite-debugger']).toEqual({
      type: 'stdio',
      command: 'node',
      args: [launch.launcherPath, '--workspace', launch.workspacePath],
    });
  });

  it('preserves comments, trailing commas, other servers, formatting, and CRLF', () => {
    const existing = [
      '{',
      '  // keep this project server',
      '  "mcpServers": {',
      '    "other": {',
      '      "command": "other",',
      '    },',
      '  },',
      '  "projectSetting": true,',
      '}',
      '',
    ].join('\r\n');

    const result = mergeClaudeConfiguration(existing, launch);
    const value = parse(result.content);

    expect(result.change).toBe('updated');
    expect(result.content).toContain('// keep this project server');
    expect(result.content).toContain('"command": "other"');
    expect(result.content).toContain('"projectSetting": true');
    expect(result.content.replace(/\r\n/g, '')).not.toContain('\n');
    expect(value.mcpServers.other.command).toBe('other');
    expect(value.mcpServers['vite-debugger'].args).toEqual([
      launch.launcherPath,
      '--workspace',
      launch.workspacePath,
    ]);
  });

  it('updates only the Vite Debugger entry and is idempotent', () => {
    const existing = JSON.stringify({
      mcpServers: {
        other: { command: 'other' },
        'vite-debugger': { command: 'old' },
      },
    }, null, 4);
    const first = mergeClaudeConfiguration(existing, launch);
    const second = mergeClaudeConfiguration(first.content, launch);

    expect(parse(first.content).mcpServers.other).toEqual({ command: 'other' });
    expect(parse(first.content).mcpServers['vite-debugger'].command).toBe('node');
    expect(second.change).toBe('unchanged');
    expect(second.content).toBe(first.content);
  });

  it('preserves a UTF-8 byte order mark', () => {
    const existing = '\uFEFF{"mcpServers": {}}\n';
    const result = mergeClaudeConfiguration(existing, launch);

    expect(result.content.startsWith('\uFEFF')).toBe(true);
    expect(parse(result.content.slice(1)).mcpServers['vite-debugger'].command).toBe('node');
  });

  it('rejects malformed or structurally unsafe configuration', () => {
    expect(() => mergeClaudeConfiguration('{ invalid', launch)).toThrow(/not valid JSON\/JSONC/);
    expect(() => mergeClaudeConfiguration('[]', launch)).toThrow(/JSON object at its root/);
    expect(() => mergeClaudeConfiguration('{"mcpServers": []}', launch)).toThrow(
      /mcpServers property.*JSON object/,
    );

    expect(() => mergeClaudeConfiguration(
      '{"mcpServers": {}, "mcp\\u0053ervers": {}}',
      launch,
    )).toThrow(/more than one mcpServers property/);

    expect(() => mergeClaudeConfiguration(
      '{"mcpServers": {"vite-debugger": {}, "vite\\u002ddebugger": {}}}',
      launch,
    )).toThrow(/more than one vite-debugger entry/);
  });
});
