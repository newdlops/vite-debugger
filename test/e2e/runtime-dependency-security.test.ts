import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const root = path.resolve(__dirname, '../..');
const utilities = require('playwright-core/lib/utilsBundle');
const runtime = require(path.join(root, 'dist/runtime-dependencies.js')) as {
  Client: typeof Client;
  Server: typeof Server;
  ListToolsRequestSchema: typeof ListToolsRequestSchema;
  ipAddress: {
    Address4: new (address: string) => unknown;
    Address6: new (address: string) => { isLinkLocal(): boolean };
  };
};

describe('patched packaged runtime dependencies', () => {
  it('shares the patched SDK with all Playwright utility transports', () => {
    for (const name of [
      'Client', 'Server', 'SSEClientTransport', 'SSEServerTransport',
      'StdioClientTransport', 'StdioServerTransport',
      'StreamableHTTPClientTransport', 'StreamableHTTPServerTransport',
    ]) {
      expect(utilities[name]).toBe((runtime as unknown as Record<string, unknown>)[name]);
    }
    const record = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/playwright-core/lib/vite-debugger-vendor.json'), 'utf8'));
    const contents = fs.readFileSync(path.join(root, 'node_modules/playwright-core/lib/utilsBundle.js'));
    expect(crypto.createHash('sha256').update(contents).digest('hex')).toBe(record.bundleSha256);
    expect(Object.keys(utilities).sort()).toEqual(record.exports);
  });

  it('completes an MCP handshake and tool request through the rebuilt Playwright classes', async () => {
    const client = new utilities.Client({ name: 'vendor-client', version: '1.0.0' }, { capabilities: {} }) as Client;
    const server = new utilities.Server({ name: 'vendor-server', version: '1.0.0' }, { capabilities: { tools: {} } }) as Server;
    server.setRequestHandler(utilities.ListToolsRequestSchema, async () => ({
      tools: [{ name: 'vendor_probe', description: 'Patched runtime probe', inputSchema: { type: 'object' } }],
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toEqual(['vendor_probe']);
      expect(client.getServerVersion()?.name).toBe('vendor-server');
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it('rejects ambiguous IPv4 octets and classifies the complete IPv6 link-local range', () => {
    expect(() => new runtime.ipAddress.Address4('010.0.0.1')).toThrow();
    expect(new runtime.ipAddress.Address6('febf::1').isLinkLocal()).toBe(true);
    expect(new runtime.ipAddress.Address6('fec0::1').isLinkLocal()).toBe(false);
  });

  it('refuses to rewrite an unrecognized upstream bundle', () => {
    const { rewriteSource } = require(path.join(root, 'scripts/prepare-runtime.cjs'));
    expect(() => rewriteSource('module.exports = {};')).toThrow(/Unrecognized Playwright/);
  });
});
