import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSync } from 'esbuild';

// Exercise the real configuration merge in a disposable process: a regressed
// parser must fail this test without freezing Vitest or the extension host.
// GHSA-7w5x-hrqm-74c2 and GHSA-r4xh-jqrq-34v2.
const probe = `
const { AgentConfigurationError, mergeCodexConfiguration } = require(process.argv[1]);
const mode = process.argv[2];
const launch = { launcherPath: '/tmp/mcp.cjs', workspacePath: '/tmp/project' };
if (mode === 'dense') {
  const source = Array.from({ length: 128000 }, (_, i) => 'key_' + i + ' = 1\\n').join('');
  const result = mergeCodexConfiguration(source, launch);
  if (!result.content.startsWith(source) || !result.content.includes('[mcp_servers.vite_debugger]')) {
    throw new Error('Unrelated settings were not preserved');
  }
  process.stdout.write(JSON.stringify({ change: result.change, preserved: true }));
} else {
  const source = mode === 'array'
    ? 'settings = [1 # trailing comment'
    : 'settings = { key = 1 # trailing comment';
  try {
    mergeCodexConfiguration(source, launch);
    throw new Error('Malformed TOML was accepted');
  } catch (error) {
    if (!(error instanceof AgentConfigurationError) || !error.message.includes('not valid TOML')) throw error;
    process.stdout.write(JSON.stringify({ rejected: true }));
  }
}
`;

describe('agent configuration parser security', () => {
  let directory: string;
  let bundle: string;

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-debugger-config-security-'));
    bundle = path.join(directory, 'configuration.cjs');
    buildSync({
      entryPoints: [path.resolve(__dirname, '../../src/mcp/AgentConfiguration.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    });
  });

  afterAll(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  function runProbe(mode: string): unknown {
    const result = spawnSync(process.execPath, ['-e', probe, bundle, mode], {
      encoding: 'utf8',
      timeout: 5000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
    });
    expect(result.error, `Parser probe failed: ${result.error?.message}`).toBeUndefined();
    expect(result.signal, 'Parser exceeded the bounded execution time').toBeNull();
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  it.each(['array', 'inline-table'])('rejects an unfinished %s ending in an EOF comment', (mode) => {
    expect(runProbe(mode)).toEqual({ rejected: true });
  });

  it('preserves 128,000 dot-free settings within a bounded merge', () => {
    expect(runProbe('dense')).toEqual({ change: 'updated', preserved: true });
  });
});
