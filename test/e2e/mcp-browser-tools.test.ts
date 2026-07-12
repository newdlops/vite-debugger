import { promises as fs } from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DebugProtocol } from '@vscode/debugprotocol';
import type { Browser, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BridgeClient } from '../../src/mcp/BridgeClient';
import { createMcpServer } from '../../src/mcp/server';
import { E2ESession, startAttachedSession } from '../helpers/session';

interface McpDapRequest extends DebugProtocol.Request {
  command: 'viteDebugger.mcp';
  arguments: {
    method: string;
    params?: unknown;
  };
}

interface McpDapResponse<T> extends DebugProtocol.Response {
  body?: T;
}

type JsonObject = Record<string, unknown>;

/**
 * Covers the production browser-tool path that the lower-level Playwright E2E
 * deliberately does not exercise:
 *
 *   SDK Client -> MCP server/tools -> Playwright CDP connection
 *                              `-> custom DAP debugger API
 *
 * The DOM controls are injected at runtime so line-sensitive breakpoint
 * fixtures remain unchanged.
 */
describe('MCP browser tools through the real server and shared debug Chrome', () => {
  const sessionId = 'mcp-browser-tools-session';
  const tracePaths: string[] = [];
  let session: E2ESession;
  let playwrightBrowser: Browser;
  let page: Page;
  let server: ReturnType<typeof createMcpServer>;
  let client: Client;
  let unmanagedPage: Page | undefined;

  async function dapMcp<T>(method: string, params?: unknown): Promise<T> {
    const response = await session.dap.request<McpDapRequest, McpDapResponse<T>>(
      'viteDebugger.mcp',
      { method, params },
      20_000,
    );
    if (response.body === undefined) {
      throw new Error(`MCP custom request '${method}' returned no response body`);
    }
    return response.body;
  }

  async function callRaw(name: string, args: JsonObject): Promise<CallToolResult> {
    return await client.callTool({ name, arguments: args }) as CallToolResult;
  }

  function resultText(result: CallToolResult): string {
    const content = result.content.find((item) => item.type === 'text');
    return content?.type === 'text' ? content.text : '';
  }

  async function call<T extends JsonObject>(name: string, args: JsonObject): Promise<T> {
    const result = await callRaw(name, args);
    if (result.isError) {
      throw new Error(`${name} failed: ${resultText(result)}`);
    }
    return JSON.parse(resultText(result)) as T;
  }

  beforeAll(async () => {
    session = await startAttachedSession();

    playwrightBrowser = await chromium.connectOverCDP(
      `http://127.0.0.1:${session.chrome.port}`,
      { timeout: 10_000 },
    );
    const expectedOrigin = new URL(session.vite.url).origin;
    const pages = playwrightBrowser.contexts().flatMap((context) => context.pages());
    const discovered = pages.find((candidate) => {
      try {
        return new URL(candidate.url()).origin === expectedOrigin;
      } catch {
        return false;
      }
    });
    if (!discovered) {
      throw new Error(
        `Playwright did not discover the fixture page; available pages: ` +
        `${pages.map((candidate) => candidate.url()).join(', ') || '(none)'}`,
      );
    }
    page = discovered;
    await page.getByRole('heading', { name: 'Fixture app' }).waitFor();

    await page.evaluate(() => {
      const previous = document.querySelector('#mcp-browser-tools-fixture');
      previous?.remove();

      const fixture = document.createElement('section');
      fixture.id = 'mcp-browser-tools-fixture';
      fixture.innerHTML = `
        <button data-testid="mcp-hover">hover target</button>
        <output data-testid="mcp-hover-output">idle</output>
        <label>
          MCP color
          <select data-testid="mcp-select">
            <option value="red">Red</option>
            <option value="green">Green</option>
          </select>
        </label>
        <output data-testid="mcp-select-output">red</output>
        <label>
          <input type="checkbox" data-testid="mcp-check" /> MCP enabled
        </label>
        <output data-testid="mcp-check-output">false</output>
        <label>
          MCP upload
          <input type="file" data-testid="mcp-upload" multiple />
        </label>
        <output data-testid="mcp-upload-output">none</output>
      `;
      document.body.appendChild(fixture);

      const hover = fixture.querySelector<HTMLButtonElement>('[data-testid="mcp-hover"]')!;
      const hoverOutput = fixture.querySelector<HTMLOutputElement>('[data-testid="mcp-hover-output"]')!;
      hover.addEventListener('mouseenter', () => { hoverOutput.value = 'hovered'; });

      const select = fixture.querySelector<HTMLSelectElement>('[data-testid="mcp-select"]')!;
      const selectOutput = fixture.querySelector<HTMLOutputElement>('[data-testid="mcp-select-output"]')!;
      select.addEventListener('change', () => { selectOutput.value = select.value; });

      const check = fixture.querySelector<HTMLInputElement>('[data-testid="mcp-check"]')!;
      const checkOutput = fixture.querySelector<HTMLOutputElement>('[data-testid="mcp-check-output"]')!;
      check.addEventListener('change', () => { checkOutput.value = String(check.checked); });

      const upload = fixture.querySelector<HTMLInputElement>('[data-testid="mcp-upload"]')!;
      const uploadOutput = fixture.querySelector<HTMLOutputElement>('[data-testid="mcp-upload-output"]')!;
      upload.addEventListener('change', () => {
        uploadOutput.value = [...(upload.files ?? [])].map((file) => file.name).join(',') || 'none';
      });
    });

    const bridge = {
      workspace: session.webRoot,
      async listSessions(): Promise<unknown> {
        return {
          sessions: [{
            sessionId,
            name: 'MCP browser tools fixture',
            type: 'vite',
            workspaceRoot: session.webRoot,
            startedAt: Date.now(),
          }],
        };
      },
      async sessionRequest(
        requestedSessionId: string,
        method: string,
        params: JsonObject,
      ): Promise<unknown> {
        if (requestedSessionId !== sessionId) {
          throw new Error(`Unexpected session id: ${requestedSessionId}`);
        }
        return dapMcp(method, params);
      },
      close(): void {},
    } as unknown as BridgeClient;

    server = createMcpServer(bridge);
    client = new Client({ name: 'mcp-browser-tools-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }, 120_000);

  afterAll(async () => {
    await unmanagedPage?.close().catch(() => undefined);
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await playwrightBrowser?.close().catch(() => undefined);
    await session?.dispose();
    await Promise.all(tracePaths.map((filePath) => fs.unlink(filePath).catch(() => undefined)));
  });

  it('waits for DOM, URL, console, and network response conditions', async () => {
    await page.evaluate(() => {
      setTimeout(() => {
        const ready = document.createElement('div');
        ready.dataset.testid = 'mcp-wait-ready';
        ready.textContent = 'ready from timer';
        document.body.appendChild(ready);
      }, 100);
    });
    const element = await call<JsonObject>('browser_wait_for', {
      condition: {
        kind: 'element',
        locator: { testId: 'mcp-wait-ready' },
        state: 'visible',
      },
      timeoutMs: 5_000,
    });
    expect(element).toMatchObject({
      outcome: 'completed',
      result: { kind: 'element', state: 'visible' },
    });

    const route = `/mcp-wait-${Date.now()}`;
    await page.evaluate((nextRoute) => {
      setTimeout(() => history.pushState({}, '', nextRoute), 100);
    }, route);
    const url = await call<JsonObject>('browser_wait_for', {
      condition: { kind: 'url', value: route, match: 'contains' },
      timeoutMs: 5_000,
    });
    expect(url).toMatchObject({ outcome: 'completed', result: { kind: 'url' } });
    expect((url.result as JsonObject).url).toContain(route);
    await page.evaluate(() => history.replaceState({}, '', '/'));

    const consoleToken = `mcp-console-${Date.now()}`;
    await page.evaluate((token) => {
      setTimeout(() => console.info(token), 100);
    }, consoleToken);
    const consoleResult = await call<JsonObject>('browser_wait_for', {
      condition: {
        kind: 'console',
        textContains: consoleToken,
        type: 'info',
        includeExisting: false,
      },
      timeoutMs: 5_000,
    });
    expect(consoleResult).toMatchObject({
      outcome: 'completed',
      result: {
        kind: 'console',
        source: 'event',
        message: { type: 'info', text: consoleToken },
      },
    });

    const networkToken = `mcp-network-${Date.now()}`;
    await page.evaluate((token) => {
      setTimeout(() => {
        void fetch(`/src/math.ts?${token}`).catch(() => undefined);
      }, 100);
    }, networkToken);
    const response = await call<JsonObject>('browser_wait_for', {
      condition: {
        kind: 'response',
        urlContains: '/src/math.ts',
        method: 'GET',
        status: 200,
        includeExisting: false,
      },
      timeoutMs: 5_000,
    });
    expect(response).toMatchObject({
      outcome: 'completed',
      result: {
        kind: 'response',
        source: 'event',
        response: { method: 'GET', status: 200 },
      },
    });
    expect(((response.result as JsonObject).response as JsonObject).url).toContain('/src/math.ts');
  }, 30_000);

  it('drives hover, select, check, and workspace-scoped upload controls', async () => {
    const hovered = await call<JsonObject>('browser_hover', { testId: 'mcp-hover' });
    expect(hovered).toMatchObject({ outcome: 'completed' });
    expect(await page.getByTestId('mcp-hover-output').textContent()).toBe('hovered');

    const selected = await call<JsonObject>('browser_select', {
      testId: 'mcp-select',
      values: ['green'],
    });
    expect(selected).toMatchObject({ outcome: 'completed', result: ['green'] });
    expect(await page.getByTestId('mcp-select-output').textContent()).toBe('green');

    const checked = await call<JsonObject>('browser_check', {
      testId: 'mcp-check',
      checked: true,
    });
    expect(checked).toMatchObject({ outcome: 'completed' });
    expect(await page.getByTestId('mcp-check-output').textContent()).toBe('true');

    const unchecked = await call<JsonObject>('browser_check', {
      testId: 'mcp-check',
      checked: false,
    });
    expect(unchecked).toMatchObject({ outcome: 'completed' });
    expect(await page.getByTestId('mcp-check-output').textContent()).toBe('false');

    const packagePath = path.join(session.webRoot, 'package.json');
    const packageBytes = (await fs.stat(packagePath)).size;
    const uploaded = await call<JsonObject>('browser_upload', {
      testId: 'mcp-upload',
      files: ['package.json'],
    });
    expect(uploaded).toMatchObject({
      outcome: 'completed',
      files: [{ relativePath: 'package.json', bytes: packageBytes }],
    });
    expect(await page.getByTestId('mcp-upload-output').textContent()).toBe('package.json');

    const cleared = await call<JsonObject>('browser_upload', {
      testId: 'mcp-upload',
      files: [],
    });
    expect(cleared).toMatchObject({ outcome: 'completed', files: [] });
    expect(await page.getByTestId('mcp-upload-output').textContent()).toBe('none');

    const outsideWorkspace = await callRaw('browser_upload', {
      testId: 'mcp-upload',
      files: [__filename],
    });
    expect(outsideWorkspace.isError).toBe(true);
    expect(resultText(outsideWorkspace)).toContain('outside the configured workspace');

    const directoryUpload = await callRaw('browser_upload', {
      testId: 'mcp-upload',
      files: ['.'],
    });
    expect(directoryUpload.isError).toBe(true);
    expect(resultText(directoryUpload)).toContain('not a regular file');
  }, 30_000);

  it('records a bounded local trace and reports its lifecycle', async () => {
    const initial = await call<JsonObject>('browser_trace', { action: 'status' });
    expect(initial).toMatchObject({ trace: { active: false } });

    const started = await call<JsonObject>('browser_trace', {
      action: 'start',
      screenshots: true,
      snapshots: true,
      sources: false,
    });
    expect(started).toMatchObject({ trace: { active: true } });

    const duplicate = await callRaw('browser_trace', { action: 'start' });
    expect(duplicate.isError).toBe(true);
    expect(resultText(duplicate)).toContain('already active');

    await call<JsonObject>('browser_hover', { testId: 'mcp-hover' });
    const active = await call<JsonObject>('browser_trace', { action: 'status' });
    expect(active).toMatchObject({ trace: { active: true } });

    const stopped = await call<JsonObject>('browser_trace', { action: 'stop' });
    const trace = stopped.trace as JsonObject;
    expect(trace).toMatchObject({ active: false, environment: process.platform });
    expect(typeof trace.path).toBe('string');
    expect(trace.bytes).toEqual(expect.any(Number));
    expect(trace.bytes as number).toBeGreaterThan(0);
    const tracePath = trace.path as string;
    tracePaths.push(tracePath);
    expect(path.extname(tracePath)).toBe('.zip');
    const handle = await fs.open(tracePath, 'r');
    try {
      const signature = Buffer.alloc(2);
      await handle.read(signature, 0, signature.length, 0);
      expect(signature.toString('ascii')).toBe('PK');
    } finally {
      await handle.close();
    }
    if (process.platform !== 'win32') {
      expect((await fs.stat(tracePath)).mode & 0o777).toBe(0o600);
    }

    const stoppedAgain = await callRaw('browser_trace', { action: 'stop' });
    expect(stoppedAgain.isError).toBe(true);
    expect(resultText(stoppedAgain)).toContain('No browser trace is active');
  }, 30_000);

  it('rejects trace capture when the context contains an unmanaged page', async () => {
    unmanagedPage = await page.context().newPage();
    await unmanagedPage.goto('about:blank');

    const blocked = await callRaw('browser_trace', { action: 'start' });
    expect(blocked.isError).toBe(true);
    expect(resultText(blocked)).toContain('outside this managed Vite app');

    await unmanagedPage.close();
    unmanagedPage = undefined;

    await call<JsonObject>('browser_trace', { action: 'start' });
    unmanagedPage = await page.context().newPage();
    const invalid = await call<JsonObject>('browser_trace', { action: 'status' });
    expect(invalid).toMatchObject({
      trace: {
        active: true,
        valid: false,
        invalidReason: expect.stringMatching(/opened a new page|unexpected page/),
      },
    });
    const discarded = await callRaw('browser_trace', { action: 'stop' });
    expect(discarded.isError).toBe(true);
    expect(resultText(discarded)).toContain('discarded for privacy');

    await unmanagedPage.close();
    unmanagedPage = undefined;
    const status = await call<JsonObject>('browser_trace', { action: 'status' });
    expect(status).toMatchObject({ trace: { active: false } });
  }, 30_000);
});
