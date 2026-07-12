import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { BridgeClient } from '../../src/mcp/BridgeClient';

describe('MCP bridge command arguments', () => {
  it('resolves explicit workspace and bridge roots relative to the sidecar cwd', () => {
    const cwd = path.resolve('/tmp', 'vite-debugger-sidecar');
    expect(BridgeClient.workspaceFromArgv(['--workspace', '../project'], cwd))
      .toBe(path.resolve(cwd, '../project'));
    expect(BridgeClient.bridgeDirectoryFromArgv(['--bridge-dir=../runtime'], cwd))
      .toBe(path.resolve(cwd, '../runtime'));
  });

  it('rejects missing workspace and bridge directory values', () => {
    expect(() => BridgeClient.workspaceFromArgv(['--workspace']))
      .toThrow(/requires a directory path/);
    expect(() => BridgeClient.bridgeDirectoryFromArgv(['--bridge-dir']))
      .toThrow(/requires a directory path/);
  });
});
