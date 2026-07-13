import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeClient } from '../../src/mcp/BridgeClient';
import { createMcpServer } from '../../src/mcp/server';

const playwrightMocks = vi.hoisted(() => ({
  connectOverCDP: vi.fn(),
}));

vi.mock('playwright-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('playwright-core')>();
  return {
    ...original,
    chromium: {
      ...original.chromium,
      connectOverCDP: playwrightMocks.connectOverCDP,
    },
  };
});

type JsonObject = Record<string, unknown>;

interface Harness {
  client: Client;
  close(): Promise<void>;
}

const harnesses: Harness[] = [];

function resultText(result: CallToolResult): string {
  const content = result.content.find((item) => item.type === 'text');
  return content?.type === 'text' ? content.text : '';
}

function createFakeBrowserPage() {
  let currentUrl = 'http://localhost:8004/app';
  const goto = vi.fn(async (destination: string) => {
    currentUrl = destination;
    return null;
  });
  const cdp = {
    send: vi.fn(async () => ({
      targetInfo: {
        targetId: 'page-8004',
        title: 'Captain app',
        url: currentUrl,
      },
    })),
    detach: vi.fn(async () => undefined),
  };
  const tracing = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const context = {
    pages: () => [page],
    newCDPSession: vi.fn(async () => cdp),
    tracing,
    on: vi.fn(),
    off: vi.fn(),
  };
  const page = {
    context: () => context,
    goto,
    isClosed: () => false,
    url: () => currentUrl,
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  };
  const browser = {
    isConnected: () => true,
    contexts: () => [context],
    once: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  return { browser, goto };
}

async function createHarness(): Promise<Harness> {
  const status = {
    connected: true,
    paused: false,
    viteUrl: 'http://localhost:3004/',
    pageUrl: 'http://localhost:8004/app',
    chromePort: 9222,
    targets: [{
      targetId: 'page-8004',
      type: 'page',
      title: 'Captain app',
      url: 'http://localhost:8004/app',
      active: true,
      paused: false,
    }],
  };
  const bridge = {
    workspace: '/fixture/project',
    async listSessions(): Promise<unknown> {
      return {
        sessions: [{
          sessionId: 'page-url-session',
          name: 'Debug Vite App',
          type: 'vite',
          workspaceRoot: '/fixture/project',
          startedAt: 1,
        }],
      };
    },
    async sessionRequest(_sessionId: string, method: string): Promise<unknown> {
      if (method === 'status') return status;
      throw new Error(`Unexpected fake bridge method: ${method}`);
    },
    close(): void {},
  } as unknown as BridgeClient;

  const server = createMcpServer(bridge);
  const client = new Client({ name: 'mcp-page-url-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const harness: Harness = {
    client,
    async close(): Promise<void> {
      await client.close();
      await server.close();
    },
  };
  harnesses.push(harness);
  return harness;
}

beforeEach(() => {
  playwrightMocks.connectOverCDP.mockReset();
});

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

describe('MCP browser page URL separation', () => {
  it('selects and navigates the browser app origin instead of the Vite module origin', async () => {
    const fake = createFakeBrowserPage();
    playwrightMocks.connectOverCDP.mockResolvedValue(fake.browser);
    const { client } = await createHarness();

    const tabs = await client.callTool({
      name: 'browser_tabs',
      arguments: {},
    }) as CallToolResult;
    expect(tabs.isError).not.toBe(true);
    expect(JSON.parse(resultText(tabs))).toMatchObject({
      viteUrl: 'http://localhost:3004/',
      pageUrl: 'http://localhost:8004/app',
      pages: [{
        targetId: 'page-8004',
        url: 'http://localhost:8004/app',
        matchesViteApp: true,
      }],
    });

    const allowed = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'http://localhost:8004/settings' },
    }) as CallToolResult;
    expect(allowed.isError).not.toBe(true);
    expect(fake.goto).toHaveBeenCalledWith(
      'http://localhost:8004/settings',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );

    const trace = await client.callTool({
      name: 'browser_trace',
      arguments: { action: 'start' },
    }) as CallToolResult;
    expect(trace.isError).not.toBe(true);
    expect(JSON.parse(resultText(trace))).toMatchObject({
      trace: { active: true, valid: true, targetIds: ['page-8004'] },
    });

    const viteOrigin = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'http://localhost:3004/@vite/client' },
    }) as CallToolResult;
    expect(viteOrigin.isError).toBe(true);
    expect(resultText(viteOrigin)).toContain('does not match browser app origin http://localhost:8004');
    expect(fake.goto).toHaveBeenCalledTimes(1);
  });
});
