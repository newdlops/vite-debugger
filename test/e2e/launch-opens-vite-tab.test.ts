import { afterEach, describe, expect, it } from 'vitest';
import { DebugProtocol } from '@vscode/debugprotocol';
import { E2ESession, startE2ESession } from '../helpers/session';

interface McpDapRequest extends DebugProtocol.Request {
  command: 'viteDebugger.mcp';
  arguments: { method: 'status' };
}

interface McpStatus {
  connected: boolean;
  viteUrl: string | null;
  targets: Array<{
    targetId: string;
    type: string;
    url: string;
  }>;
}

interface McpStatusResponse extends DebugProtocol.Response {
  body?: McpStatus;
}

describe('ViteDebugSession — launch target creation', () => {
  let session: E2ESession | undefined;

  async function initialize(current: E2ESession): Promise<void> {
    await current.dap.request<
      DebugProtocol.InitializeRequest,
      DebugProtocol.InitializeResponse
    >('initialize', {
      adapterID: 'vite',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
    });
  }

  async function attach(current: E2ESession): Promise<void> {
    const initialized = current.dap.waitForEvent('initialized', 30_000);
    await current.dap.request<
      DebugProtocol.AttachRequest,
      DebugProtocol.AttachResponse
    >('attach', {
      viteUrl: current.vite.url,
      chromePort: current.chrome.port,
      webRoot: current.webRoot,
    }, 30_000);
    await initialized;
  }

  async function launch(current: E2ESession): Promise<void> {
    const initialized = current.dap.waitForEvent('initialized', 30_000);
    await current.dap.request<
      DebugProtocol.LaunchRequest,
      DebugProtocol.LaunchResponse
    >('launch', {
      viteUrl: current.vite.url,
      chromePort: current.chrome.port,
      webRoot: current.webRoot,
    }, 30_000);
    await initialized;
  }

  async function status(current: E2ESession): Promise<McpStatus> {
    const response = await current.dap.request<McpDapRequest, McpStatusResponse>(
      'viteDebugger.mcp',
      { method: 'status' },
    );
    if (!response.body) throw new Error('MCP status returned no body');
    return response.body;
  }

  afterEach(async () => {
    await session?.dispose();
    session = undefined;
  });

  it('attach preserves an about:blank browser without creating a Vite page', async () => {
    session = await startE2ESession();
    await initialize(session);
    await attach(session);

    const attached = await status(session);
    expect(attached.connected).toBe(true);
    expect(attached.targets).toEqual([]);

    // Complete Vite's dependency crawl before fixture teardown. The assertion
    // above is intentionally made first: attach itself must not open this page.
    await session.browser.navigate(session.vite.url);
    await session.browser.waitForSelector('[data-testid="inc"]');
  }, 60_000);

  it('reuses an existing Vite page instead of opening a duplicate', async () => {
    session = await startE2ESession();
    await session.browser.navigate(session.vite.url);
    await session.browser.waitForSelector('[data-testid="inc"]');

    await initialize(session);
    await launch(session);

    const launched = await status(session);
    expect(launched.connected).toBe(true);
    expect(launched.targets).toHaveLength(1);
    expect(new URL(launched.targets[0].url).origin)
      .toBe(new URL(session.vite.url).origin);
  }, 60_000);

  it('opens and manages the Vite page without test-side browser navigation', async () => {
    session = await startE2ESession();
    await initialize(session);
    await launch(session);

    const launched = await status(session);
    expect(launched.connected).toBe(true);
    expect(launched.targets).toHaveLength(1);

    const target = launched.targets[0];
    expect(target.type).toBe('page');
    expect(new URL(target.url).origin).toBe(new URL(session.vite.url).origin);
    expect(new URL(target.url).pathname).toBe('/');
  }, 60_000);
});
