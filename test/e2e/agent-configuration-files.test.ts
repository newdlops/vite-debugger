import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  mergeClaudeConfiguration,
  mergeCodexConfiguration,
} from '../../src/mcp/AgentConfiguration';
import {
  prepareStableMcpLauncher,
  readConfiguration,
  writeConfigurationTransaction,
} from '../../src/mcp/AgentConfigurationFiles';

describe('agent MCP configuration files', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'vite-debugger-agent-config-'));
  });

  afterEach(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('creates Codex and Claude configurations together and supports a no-op rerun', async () => {
    const launch = {
      launcherPath: '/tmp/vite debugger/mcp.cjs',
      workspacePath,
    };
    const codexPath = path.join(workspacePath, '.codex', 'config.toml');
    const claudePath = path.join(workspacePath, '.mcp.json');
    const codexOriginal = await readConfiguration(codexPath);
    const claudeOriginal = await readConfiguration(claudePath);
    const codex = mergeCodexConfiguration(codexOriginal.content, launch);
    const claude = mergeClaudeConfiguration(claudeOriginal.content, launch);

    await writeConfigurationTransaction([
      { workspacePath, filePath: codexPath, original: codexOriginal, content: codex.content },
      { workspacePath, filePath: claudePath, original: claudeOriginal, content: claude.content },
    ]);

    expect((await fs.readFile(codexPath, 'utf8'))).toBe(codex.content);
    expect((await fs.readFile(claudePath, 'utf8'))).toBe(claude.content);
    expect((await fs.stat(codexPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(claudePath)).mode & 0o777).toBe(0o600);

    const codexAgain = mergeCodexConfiguration((await readConfiguration(codexPath)).content, launch);
    const claudeAgain = mergeClaudeConfiguration((await readConfiguration(claudePath)).content, launch);
    expect(codexAgain.change).toBe('unchanged');
    expect(claudeAgain.change).toBe('unchanged');
    await writeConfigurationTransaction([]);
  });

  it('detects an external save after staging without overwriting it', async () => {
    const filePath = path.join(workspacePath, '.mcp.json');
    await fs.writeFile(filePath, '{"before":true}\n', 'utf8');
    const original = await readConfiguration(filePath);
    let checks = 0;

    await expect(writeConfigurationTransaction([
      { workspacePath, filePath, original, content: '{"configured":true}\n' },
    ], {
      assertDocumentSaved: async () => {
        checks += 1;
        if (checks === 2) await fs.writeFile(filePath, '{"external":true}\n', 'utf8');
      },
    })).rejects.toThrow(/changed while MCP setup was running/);

    expect(await fs.readFile(filePath, 'utf8')).toBe('{"external":true}\n');
    expect((await fs.readdir(workspacePath)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('rolls back the first client if the second changes during commit', async () => {
    const codexPath = path.join(workspacePath, 'codex.toml');
    const claudePath = path.join(workspacePath, 'claude.json');
    await fs.writeFile(codexPath, 'codex-original\n', 'utf8');
    await fs.writeFile(claudePath, 'claude-original\n', 'utf8');
    const codexOriginal = await readConfiguration(codexPath);
    const claudeOriginal = await readConfiguration(claudePath);
    let claudeChecks = 0;

    await expect(writeConfigurationTransaction([
      { workspacePath, filePath: codexPath, original: codexOriginal, content: 'codex-new\n' },
      { workspacePath, filePath: claudePath, original: claudeOriginal, content: 'claude-new\n' },
    ], {
      assertDocumentSaved: async (filePath) => {
        if (filePath !== claudePath) return;
        claudeChecks += 1;
        if (claudeChecks === 3) await fs.writeFile(claudePath, 'claude-external\n', 'utf8');
      },
    })).rejects.toThrow(/changed while MCP setup was running/);

    expect(await fs.readFile(codexPath, 'utf8')).toBe('codex-original\n');
    expect(await fs.readFile(claudePath, 'utf8')).toBe('claude-external\n');
  });

  it.skipIf(process.platform === 'win32')('refuses symbolic-link targets and parents', async () => {
    const outside = path.join(workspacePath, 'outside');
    const target = path.join(outside, 'target.json');
    await fs.mkdir(outside);
    await fs.writeFile(target, '{}\n', 'utf8');

    const linkedFile = path.join(workspacePath, '.mcp.json');
    await fs.symlink(target, linkedFile);
    await expect(readConfiguration(linkedFile)).rejects.toThrow(/symbolic link/);

    const linkedParent = path.join(workspacePath, '.codex');
    await fs.symlink(outside, linkedParent);
    const filePath = path.join(linkedParent, 'config.toml');
    await expect(writeConfigurationTransaction([{
      workspacePath,
      filePath,
      original: { content: undefined, mode: undefined },
      content: '[mcp_servers.vite_debugger]\n',
    }])).rejects.toThrow(/symbolic link/);
  });

  it('keeps the newest valid stable launcher and repairs a removed target', async () => {
    const storagePath = path.join(workspacePath, 'global-storage');
    const server1 = path.join(workspacePath, 'server-1.js');
    const server2 = path.join(workspacePath, 'server-2.js');
    const server3 = path.join(workspacePath, 'server-3.js');
    const bridgeDirectoryPath = path.join(workspacePath, 'bridge-runtime');
    await Promise.all([
      fs.writeFile(server1, 'module.exports = {};\n'),
      fs.writeFile(server2, 'module.exports = {};\n'),
      fs.writeFile(server3, 'module.exports = {};\n'),
    ]);

    const launcherPath = await prepareStableMcpLauncher({
      storagePath,
      bundledServerPath: server1,
      version: '0.1.7007',
      bridgeDirectoryPath,
    });
    const firstLauncher = await fs.readFile(launcherPath, 'utf8');
    expect(firstLauncher).toContain(JSON.stringify(server1));
    expect(firstLauncher).toContain(JSON.stringify(bridgeDirectoryPath));
    expect(firstLauncher).toContain("args.push('--bridge-dir'");

    await Promise.all([
      prepareStableMcpLauncher({ storagePath, bundledServerPath: server2, version: '0.1.7008' }),
      prepareStableMcpLauncher({ storagePath, bundledServerPath: server3, version: '0.1.7009' }),
    ]);
    expect(await fs.readFile(launcherPath, 'utf8')).toContain(JSON.stringify(server3));

    await prepareStableMcpLauncher({ storagePath, bundledServerPath: server1, version: '0.1.7007' });
    expect(await fs.readFile(launcherPath, 'utf8')).toContain(JSON.stringify(server3));

    await fs.unlink(server3);
    await prepareStableMcpLauncher({ storagePath, bundledServerPath: server1, version: '0.1.7007' });
    expect(await fs.readFile(launcherPath, 'utf8')).toContain(JSON.stringify(server1));
    await expect(fs.access(`${launcherPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
