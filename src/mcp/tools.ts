import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  chromium,
  type Browser,
  type ConsoleMessage,
  type Frame,
  type Locator,
  type Page,
  type Request,
  type Response,
} from 'playwright-core';
import { z } from 'zod';
import { BridgeClient, type BridgeSessionMetadata } from './BridgeClient';

const MAX_EVENT_HISTORY = 500;
const MAX_MANAGED_TARGETS = 100;
const MAX_SNAPSHOT_CHARS = 300_000;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
const MAX_URL_CHARS = 4_096;
const MAX_TITLE_CHARS = 500;
const MAX_CONSOLE_TEXT_CHARS = 10_000;
const MAX_ERROR_TEXT_CHARS = 2_000;
const MAX_INPUT_VALUE_CHARS = 100_000;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

type UnknownRecord = Record<string, unknown>;

interface SelectedSession {
  sessionId: string;
  metadata: BridgeSessionMetadata;
  status: UnknownRecord;
}

interface TargetDescription {
  targetId: string;
  type?: string;
  url?: string;
  title?: string;
  active?: boolean;
  paused?: boolean;
}

interface PageDescription {
  page: Page;
  targetId: string;
  url: string;
  title?: string;
}

interface ConsoleEntry {
  timestamp: string;
  type: string;
  text: string;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
  pageUrl: string;
}

interface NetworkEntry {
  timestamp: string;
  phase: 'request' | 'response' | 'failed';
  requestId: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  failure?: string | null;
}

interface PageState {
  capturedSince: string;
  viteUrl: string;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  dispose: () => void;
}

export interface McpToolsRegistration {
  dispose(): Promise<void>;
}

const sessionShape = {
  sessionId: z.string().min(1).max(200).optional().describe(
    'Vite debug session id. Required when this VS Code window has more than one Vite session.',
  ),
};

const pageShape = {
  ...sessionShape,
  targetId: z.string().min(1).max(200).optional().describe(
    'Chrome target id. Required when more than one page matches the Vite application.',
  ),
};

const locatorShape = {
  ref: z.string().min(1).max(200).optional().describe(
    'Accessibility ref such as e12 from the latest browser_snapshot. Preferred when available.',
  ),
  selector: z.string().min(1).max(4_096).optional().describe('CSS or Playwright selector.'),
  role: z.string().min(1).max(100).optional().describe('ARIA role, for example button or textbox.'),
  name: z.string().max(1_000).optional().describe('Accessible name used with role.'),
  text: z.string().min(1).max(2_000).optional().describe('Visible text to locate.'),
  label: z.string().min(1).max(1_000).optional().describe('Associated label text to locate.'),
  testId: z.string().min(1).max(500).optional().describe('data-testid value to locate.'),
  exact: z.boolean().optional().default(false),
  index: z.number().int().nonnegative().optional().describe('Zero-based match index.'),
};

export function registerMcpTools(server: McpServer, bridge: BridgeClient): McpToolsRegistration {
  const browser = new BrowserController();

  server.registerTool('debug_status', {
    title: 'Vite debugger status',
    description:
      'Lists Vite debug sessions in this VS Code project window and returns detailed state for the selected session. ' +
      'Call this first. If selectionRequired is true, repeat with sessionId.',
    inputSchema: sessionShape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => safely(async () => {
    const sessions = await listSessions(bridge);
    if (!args.sessionId && sessions.length > 1) {
      return jsonResult({
        selectionRequired: true,
        workspace: bridge.workspace,
        sessions,
      });
    }
    const selected = await selectSession(bridge, args.sessionId, sessions);
    return jsonResult({
      workspace: bridge.workspace,
      sessionId: selected.sessionId,
      metadata: selected.metadata,
      ...publicDebugStatus(selected.status),
    });
  }));

  server.registerTool('debug_snapshot', {
    title: 'Current debugger snapshot',
    description:
      'Returns the current pause reason, call stack, scopes and bounded variable previews from the Vite debugger.',
    inputSchema: {
      ...pageShape,
      maxFrames: z.number().int().min(1).max(20).optional().default(20),
      maxVariables: z.number().int().min(1).max(20).optional().default(20),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    const targetId = snapshotTargetId(selected.status, args.targetId);
    const snapshot = await bridge.sessionRequest(selected.sessionId, 'snapshot', {
      targetId,
      maxFrames: args.maxFrames,
      maxVariables: args.maxVariables,
    });
    return jsonResult({ sessionId: selected.sessionId, snapshot });
  }));

  server.registerTool('debug_control', {
    title: 'Control debugger execution',
    description:
      'Pauses, resumes, steps, or reloads the selected Vite debug target. ' +
      'Valid actions are pause, continue, stepOver, stepInto, stepOut and reload.',
    inputSchema: {
      ...pageShape,
      action: z.enum(['pause', 'continue', 'stepOver', 'stepInto', 'stepOut', 'reload']),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    const targetId = controlTargetId(selected.status, args.targetId);
    const result = await bridge.sessionRequest(selected.sessionId, 'control', {
      action: args.action,
      targetId,
    });
    return jsonResult({ sessionId: selected.sessionId, result });
  }));

  server.registerTool('debug_replace_breakpoints', {
    title: 'Replace source breakpoints',
    description:
      'Atomically replaces the agent-owned breakpoints for one source file. The breakpoint set is applied to every ' +
      'managed Vite tab in the selected debug session. Pass an empty breakpoints array to clear it.',
    inputSchema: {
      ...sessionShape,
      source: z.string().min(1).max(MAX_URL_CHARS).describe('Absolute source path or source URL.'),
      breakpoints: z.array(z.object({
        line: z.number().int().min(1),
        column: z.number().int().min(1).optional(),
        condition: z.string().max(4_096).optional(),
        hitCondition: z.string().max(1_000).optional(),
        logMessage: z.string().max(10_000).optional(),
      })).max(200),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    const result = await bridge.sessionRequest(selected.sessionId, 'replaceBreakpoints', {
      sourcePath: args.source,
      breakpoints: args.breakpoints,
    });
    return jsonResult({ sessionId: selected.sessionId, result });
  }));

  server.registerTool('browser_tabs', {
    title: 'List browser tabs',
    description:
      'Lists Chrome pages visible to the selected Vite debug session, including stable targetId values. ' +
      'Use targetId in later calls when multiple Vite pages are listed.',
    inputSchema: sessionShape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    const pages = await browser.pagesForStatus(selected.status);
    const viteUrl = readString(selected.status, ['viteUrl'], ['config', 'viteUrl'], ['browser', 'viteUrl']);
    return jsonResult({
      sessionId: selected.sessionId,
      viteUrl: viteUrl ? sanitizeBrowserUrl(viteUrl) : undefined,
      pages: pages.map(({ targetId, url, title }) => ({
        targetId,
        url,
        title,
        matchesViteApp: viteUrl ? urlMatchesVite(url, viteUrl) : undefined,
      })),
    });
  }));

  server.registerTool('browser_snapshot', {
    title: 'Accessibility snapshot',
    description:
      'Returns an AI-oriented ARIA snapshot of the selected Vite page. Elements include refs such as [ref=e12]; ' +
      'pass the ref to browser_click, browser_fill, or browser_press. Refs become stale after navigation or DOM changes.',
    inputSchema: {
      ...pageShape,
      depth: z.number().int().min(1).max(50).optional().default(15),
      boxes: z.boolean().optional().default(false),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    assertRendererAvailable(selected.status, 'browser_snapshot');
    const chosen = await browser.selectPage(selected.status, args.targetId);
    let snapshot = await chosen.page.locator('body').ariaSnapshot({
      mode: 'ai',
      depth: args.depth,
      boxes: args.boxes,
      timeout: DEFAULT_ACTION_TIMEOUT_MS,
    });
    const originalLength = snapshot.length;
    if (snapshot.length > MAX_SNAPSHOT_CHARS) {
      snapshot = `${snapshot.slice(0, MAX_SNAPSHOT_CHARS)}\n# ... snapshot truncated ...`;
    }
    return {
      content: [
        { type: 'text', text: JSON.stringify({
          sessionId: selected.sessionId,
          targetId: chosen.targetId,
          url: chosen.url,
          truncated: originalLength > MAX_SNAPSHOT_CHARS,
        }) },
        { type: 'text', text: snapshot },
      ],
    };
  }));

  server.registerTool('browser_navigate', {
    title: 'Navigate Vite page',
    description:
      'Navigates the selected Vite page to a same-origin URL or relative app route. Cross-origin navigation is rejected.',
    inputSchema: {
      ...pageShape,
      url: z.string().min(1).max(MAX_URL_CHARS).describe('Absolute same-origin URL or relative route.'),
      waitUntil: z.enum(['commit', 'domcontentloaded', 'load', 'networkidle'])
        .optional().default('domcontentloaded'),
      timeoutMs: z.number().int().min(100).max(60_000).optional().default(DEFAULT_ACTION_TIMEOUT_MS),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    assertNotPaused(selected.status, 'browser_navigate');
    const chosen = await browser.selectPage(selected.status, args.targetId);
    const destination = sameOriginDestination(args.url, chosen.url, selected.status);
    const outcome = await runBrowserMutation(bridge, selected, async () => {
      await chosen.page.goto(destination, { waitUntil: args.waitUntil, timeout: args.timeoutMs });
    });
    return jsonResult({
      sessionId: selected.sessionId,
      targetId: chosen.targetId,
      url: sanitizeBrowserUrl(chosen.page.url()),
      ...outcome,
    });
  }));

  server.registerTool('browser_click', {
    title: 'Click page element',
    description:
      'Clicks an element in the selected Vite page. Prefer ref from browser_snapshot; alternatively provide one ' +
      'of selector, role, text, label, or testId. If the click reaches a breakpoint, returns outcome paused.',
    inputSchema: {
      ...pageShape,
      ...locatorShape,
      button: z.enum(['left', 'right', 'middle']).optional().default('left'),
      clickCount: z.number().int().min(1).max(3).optional().default(1),
      timeoutMs: z.number().int().min(100).max(60_000).optional().default(DEFAULT_ACTION_TIMEOUT_MS),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    assertNotPaused(selected.status, 'browser_click');
    const chosen = await browser.selectPage(selected.status, args.targetId);
    const locator = makeLocator(chosen.page, args);
    const outcome = await runBrowserMutation(bridge, selected, async () => {
      await locator.click({
        button: args.button,
        clickCount: args.clickCount,
        timeout: args.timeoutMs,
        noWaitAfter: true,
      });
    });
    return jsonResult({ sessionId: selected.sessionId, targetId: chosen.targetId, ...outcome });
  }));

  server.registerTool('browser_fill', {
    title: 'Fill page field',
    description:
      'Fills an input-like element in the selected Vite page. Prefer ref from browser_snapshot; alternatively ' +
      'provide one of selector, role, text, label, or testId.',
    inputSchema: {
      ...pageShape,
      ...locatorShape,
      value: z.string().max(MAX_INPUT_VALUE_CHARS),
      timeoutMs: z.number().int().min(100).max(60_000).optional().default(DEFAULT_ACTION_TIMEOUT_MS),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    assertNotPaused(selected.status, 'browser_fill');
    const chosen = await browser.selectPage(selected.status, args.targetId);
    const locator = makeLocator(chosen.page, args);
    const outcome = await runBrowserMutation(bridge, selected, async () => {
      await locator.fill(args.value, { timeout: args.timeoutMs });
    });
    return jsonResult({ sessionId: selected.sessionId, targetId: chosen.targetId, ...outcome });
  }));

  server.registerTool('browser_press', {
    title: 'Press key on page element',
    description:
      'Presses a key or shortcut (for example Enter or Control+K) on an element. Prefer a ref from browser_snapshot.',
    inputSchema: {
      ...pageShape,
      ...locatorShape,
      key: z.string().min(1).max(100),
      timeoutMs: z.number().int().min(100).max(60_000).optional().default(DEFAULT_ACTION_TIMEOUT_MS),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    assertNotPaused(selected.status, 'browser_press');
    const chosen = await browser.selectPage(selected.status, args.targetId);
    const locator = makeLocator(chosen.page, args);
    const outcome = await runBrowserMutation(bridge, selected, async () => {
      await locator.press(args.key, { timeout: args.timeoutMs, noWaitAfter: true });
    });
    return jsonResult({ sessionId: selected.sessionId, targetId: chosen.targetId, ...outcome });
  }));

  server.registerTool('browser_screenshot', {
    title: 'Take page screenshot',
    description: 'Takes a PNG screenshot of the selected Vite page and returns it as MCP image content.',
    inputSchema: {
      ...pageShape,
      fullPage: z.boolean().optional().default(false),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    assertRendererAvailable(selected.status, 'browser_screenshot');
    const chosen = await browser.selectPage(selected.status, args.targetId);
    const data = await chosen.page.screenshot({
      type: 'png',
      fullPage: args.fullPage,
      animations: 'disabled',
      timeout: DEFAULT_ACTION_TIMEOUT_MS,
    });
    if (data.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new Error(
        `Screenshot is ${data.byteLength} bytes, exceeding the ${MAX_SCREENSHOT_BYTES}-byte MCP limit. ` +
        'Retry with fullPage=false or reduce the browser viewport.',
      );
    }
    return {
      content: [
        { type: 'text', text: JSON.stringify({
          sessionId: selected.sessionId,
          targetId: chosen.targetId,
          url: sanitizeBrowserUrl(chosen.page.url()),
        }) },
        { type: 'image', data: data.toString('base64'), mimeType: 'image/png' },
      ],
    };
  }));

  server.registerTool('browser_console_messages', {
    title: 'Recent browser console messages',
    description:
      'Returns console and uncaught page-error messages observed since this MCP process connected to the page.',
    inputSchema: {
      ...pageShape,
      limit: z.number().int().min(1).max(MAX_EVENT_HISTORY).optional().default(100),
      clear: z.boolean().optional().default(false),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    const chosen = await browser.selectPage(selected.status, args.targetId);
    const history = browser.consoleHistory(chosen.page, args.limit, args.clear);
    return jsonResult({ sessionId: selected.sessionId, targetId: chosen.targetId, ...history });
  }));

  server.registerTool('browser_network_requests', {
    title: 'Recent browser network requests',
    description:
      'Returns request, response and failure events observed since this MCP process connected. ' +
      'Bodies, cookies and headers are intentionally not captured.',
    inputSchema: {
      ...pageShape,
      limit: z.number().int().min(1).max(MAX_EVENT_HISTORY).optional().default(100),
      clear: z.boolean().optional().default(false),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    const chosen = await browser.selectPage(selected.status, args.targetId);
    const history = browser.networkHistory(chosen.page, args.limit, args.clear);
    return jsonResult({ sessionId: selected.sessionId, targetId: chosen.targetId, ...history });
  }));

  return { dispose: () => browser.dispose() };
}

class BrowserController {
  private browser: Browser | undefined;
  private chromePort: number | undefined;
  private connecting: Promise<Browser> | undefined;
  private connectingPort: number | undefined;
  private disposed = false;
  private readonly states = new Map<Page, PageState>();
  private readonly requestIds = new WeakMap<Request, string>();
  private nextRequestId = 1;

  async pagesForStatus(status: UnknownRecord): Promise<PageDescription[]> {
    const allowedTargetIds = managedTargetIds(status);
    if (allowedTargetIds.size === 0) {
      this.clearPageStates();
      return [];
    }
    const viteUrl = readString(status, ['viteUrl'], ['config', 'viteUrl'], ['browser', 'viteUrl']);
    if (!viteUrl) {
      this.clearPageStates();
      throw new Error('The selected debug session did not report its Vite application URL');
    }
    const port = chromePortFromStatus(status);
    const browser = await this.ensureConnected(port);
    const pages = browser.contexts().flatMap((context) => context.pages()).filter((page) => !page.isClosed());
    const descriptions = (await Promise.all(pages.map((page) => this.describePage(page))))
      .filter((page) =>
        allowedTargetIds.has(page.targetId) && urlMatchesVite(page.page.url(), viteUrl)
      );
    this.reconcilePageStates(descriptions, viteUrl);
    return descriptions.sort((left, right) => left.targetId.localeCompare(right.targetId));
  }

  async selectPage(status: UnknownRecord, requestedTargetId?: string): Promise<PageDescription> {
    const allowedTargetIds = managedTargetIds(status);
    if (requestedTargetId && !allowedTargetIds.has(requestedTargetId)) {
      throw new Error(
        `Chrome target ${boundedText(requestedTargetId, 200)} is not managed by this Vite debug session. ` +
        `Managed targets: ${[...allowedTargetIds].join(', ') || 'none'}`,
      );
    }

    const pages = await this.pagesForStatus(status);
    if (requestedTargetId) {
      const exact = pages.find((page) => page.targetId === requestedTargetId);
      if (!exact) {
        throw new Error(
          `Chrome target ${requestedTargetId} is not available. ` +
          `Available targets: ${pages.map((page) => `${page.targetId} (${page.url})`).join(', ') || 'none'}`,
        );
      }
      return exact;
    }

    if (pages.length === 0) {
      throw new Error(
        'None of the Chrome pages managed by this Vite debug session are currently available to Playwright.',
      );
    }
    if (pages.length > 1) {
      throw new Error(
        'Multiple managed Vite pages are available; pass targetId explicitly. ' +
        pages.map((page) => `${page.targetId} (${page.url})`).join(', '),
      );
    }
    return pages[0];
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const pending = this.connecting;
    if (pending) await pending.catch(() => undefined);
    await this.disconnectCurrent('Vite Debugger MCP server disposed');
  }

  consoleHistory(page: Page, limit: number, clear: boolean): {
    capturedSince: string;
    messages: ConsoleEntry[];
  } {
    const state = this.states.get(page);
    if (!state) throw new Error('The selected page is no longer a managed Vite target');
    const messages = state.console.slice(-limit);
    if (clear) state.console.length = 0;
    return { capturedSince: state.capturedSince, messages };
  }

  networkHistory(page: Page, limit: number, clear: boolean): {
    capturedSince: string;
    events: NetworkEntry[];
  } {
    const state = this.states.get(page);
    if (!state) throw new Error('The selected page is no longer a managed Vite target');
    const events = state.network.slice(-limit);
    if (clear) state.network.length = 0;
    return { capturedSince: state.capturedSince, events };
  }

  private async ensureConnected(port: number): Promise<Browser> {
    if (this.disposed) throw new Error('The MCP browser controller has been disposed');
    if (this.browser?.isConnected() && this.chromePort === port) return this.browser;
    if (this.connecting && this.connectingPort === port) return this.connecting;
    if (this.connecting) {
      await this.connecting.catch(() => undefined);
      return this.ensureConnected(port);
    }

    const connect = async (): Promise<Browser> => {
      await this.disconnectCurrent('Vite Debugger Chrome port changed');
      const endpoint = `http://127.0.0.1:${port}`;
      const connected = await chromium.connectOverCDP(endpoint, {
        timeout: 10_000,
        noDefaults: true,
        isLocal: true,
      });
      if (this.disposed) {
        await connected.close({ reason: 'Vite Debugger MCP server disposed during connection' });
        throw new Error('The MCP browser controller has been disposed');
      }
      this.browser = connected;
      this.chromePort = port;
      connected.once('disconnected', () => {
        if (this.browser === connected) {
          this.browser = undefined;
          this.chromePort = undefined;
          this.clearPageStates();
        }
      });
      return connected;
    };

    this.connectingPort = port;
    const pending = connect();
    this.connecting = pending;
    try {
      return await pending;
    } finally {
      if (this.connecting === pending) {
        this.connecting = undefined;
        this.connectingPort = undefined;
      }
    }
  }

  private async disconnectCurrent(reason: string): Promise<void> {
    const connected = this.browser;
    this.browser = undefined;
    this.chromePort = undefined;
    this.clearPageStates();
    if (connected?.isConnected()) {
      // Playwright documents Browser.close() for a connected browser as
      // disconnecting from the browser server. We create no contexts, so the
      // VS Code-owned Chrome and its pre-existing pages remain alive.
      await connected.close({ reason }).catch(() => undefined);
    }
  }

  private reconcilePageStates(pages: PageDescription[], viteUrl: string): void {
    const allowedPages = new Set(pages.map(({ page }) => page));
    for (const page of this.states.keys()) {
      if (!allowedPages.has(page)) this.unwatchPage(page);
    }
    for (const { page } of pages) this.watchPage(page, viteUrl);
  }

  private clearPageStates(): void {
    for (const page of [...this.states.keys()]) this.unwatchPage(page);
  }

  private unwatchPage(page: Page): void {
    const state = this.states.get(page);
    if (!state) return;
    this.states.delete(page);
    state.dispose();
  }

  private watchPage(page: Page, viteUrl: string): PageState {
    const existing = this.states.get(page);
    if (existing) {
      existing.viteUrl = viteUrl;
      return existing;
    }
    const state: PageState = {
      capturedSince: new Date().toISOString(),
      viteUrl,
      console: [],
      network: [],
      dispose: () => undefined,
    };
    this.states.set(page, state);

    const onConsole = (message: ConsoleMessage) => {
      const location = message.location();
      appendRing(state.console, {
        timestamp: new Date().toISOString(),
        type: boundedText(message.type(), 100),
        text: boundedText(message.text(), MAX_CONSOLE_TEXT_CHARS),
        location: location.url ? {
          url: sanitizeBrowserUrl(location.url),
          lineNumber: location.lineNumber,
          columnNumber: location.columnNumber,
        } : undefined,
        pageUrl: sanitizeBrowserUrl(page.url()),
      });
    };
    const onPageError = (error: Error) => {
      appendRing(state.console, {
        timestamp: new Date().toISOString(),
        type: 'pageerror',
        text: boundedText(error.message, MAX_CONSOLE_TEXT_CHARS),
        pageUrl: sanitizeBrowserUrl(page.url()),
      });
    };
    const onRequest = (request: Request) => {
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame() &&
        !urlMatchesVite(request.url(), state.viteUrl)
      ) {
        this.unwatchPage(page);
        return;
      }
      const requestId = `request-${this.nextRequestId++}`;
      this.requestIds.set(request, requestId);
      appendRing(state.network, {
        timestamp: new Date().toISOString(),
        phase: 'request',
        requestId,
        method: boundedText(request.method(), 32),
        url: sanitizeBrowserUrl(request.url()),
        resourceType: boundedText(request.resourceType(), 100),
      });
    };
    const onResponse = (response: Response) => {
      const request = response.request();
      appendRing(state.network, {
        timestamp: new Date().toISOString(),
        phase: 'response',
        requestId: this.idForRequest(request),
        method: boundedText(request.method(), 32),
        url: sanitizeBrowserUrl(response.url()),
        resourceType: boundedText(request.resourceType(), 100),
        status: response.status(),
        statusText: boundedText(response.statusText(), 500),
      });
    };
    const onRequestFailed = (request: Request) => {
      appendRing(state.network, {
        timestamp: new Date().toISOString(),
        phase: 'failed',
        requestId: this.idForRequest(request),
        method: boundedText(request.method(), 32),
        url: sanitizeBrowserUrl(request.url()),
        resourceType: boundedText(request.resourceType(), 100),
        failure: request.failure()?.errorText
          ? boundedText(request.failure()!.errorText, MAX_ERROR_TEXT_CHARS)
          : null,
      });
    };
    const onFrameNavigated = (frame: Frame) => {
      if (frame === page.mainFrame() && !urlMatchesVite(frame.url(), state.viteUrl)) {
        this.unwatchPage(page);
      }
    };
    const onClose = () => this.unwatchPage(page);
    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('requestfailed', onRequestFailed);
    page.on('framenavigated', onFrameNavigated);
    page.once('close', onClose);
    state.dispose = () => {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
      page.off('framenavigated', onFrameNavigated);
      page.off('close', onClose);
    };
    return state;
  }

  private idForRequest(request: Request): string {
    let id = this.requestIds.get(request);
    if (!id) {
      id = `request-${this.nextRequestId++}`;
      this.requestIds.set(request, id);
    }
    return id;
  }

  private async describePage(page: Page): Promise<PageDescription> {
    const cdp = await page.context().newCDPSession(page);
    try {
      const response = await cdp.send('Target.getTargetInfo') as {
        targetInfo: { targetId: string; title?: string; url?: string };
      };
      return {
        page,
        targetId: response.targetInfo.targetId,
        url: sanitizeBrowserUrl(page.url() || response.targetInfo.url || ''),
        title: response.targetInfo.title
          ? boundedText(response.targetInfo.title, MAX_TITLE_CHARS)
          : undefined,
      };
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }
}

async function listSessions(bridge: BridgeClient): Promise<BridgeSessionMetadata[]> {
  const raw = await bridge.listSessions<unknown>();
  const values = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.sessions)
      ? raw.sessions
      : [];
  return values.flatMap((value) => {
    if (!isRecord(value)) return [];
    const sessionId = typeof value.sessionId === 'string'
      ? value.sessionId
      : typeof value.id === 'string'
        ? value.id
        : undefined;
    if (!sessionId) return [];
    return [{ ...value, sessionId } as BridgeSessionMetadata];
  });
}

async function selectSession(
  bridge: BridgeClient,
  requestedSessionId?: string,
  knownSessions?: BridgeSessionMetadata[],
): Promise<SelectedSession> {
  const sessions = knownSessions ?? await listSessions(bridge);
  if (sessions.length === 0) {
    throw new Error(
      'No active Vite debug session exists in this VS Code window. Start Vite Debugger, then retry.',
    );
  }

  let metadata: BridgeSessionMetadata | undefined;
  if (requestedSessionId) {
    metadata = sessions.find((session) => session.sessionId === requestedSessionId);
    if (!metadata) {
      throw new Error(
        `Unknown Vite debug session ${requestedSessionId}. ` +
        `Available sessions: ${sessions.map((session) => session.sessionId).join(', ')}`,
      );
    }
  } else if (sessions.length === 1) {
    metadata = sessions[0];
  } else {
    throw new Error(
      'Multiple Vite debug sessions are active; pass sessionId explicitly. ' +
      sessions.map((session) => session.sessionId).join(', '),
    );
  }

  const rawStatus = await bridge.sessionRequest<unknown>(metadata.sessionId, 'status', {});
  const status = isRecord(rawStatus) ? rawStatus : { value: rawStatus };
  return { sessionId: metadata.sessionId, metadata, status };
}

function targetsFromStatus(status: UnknownRecord): TargetDescription[] {
  const raw = readUnknown(status, ['targets'], ['browser', 'targets'], ['session', 'targets']);
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_MANAGED_TARGETS).flatMap((value) => {
    if (!isRecord(value)) return [];
    const targetId = typeof value.targetId === 'string'
      ? value.targetId
      : typeof value.id === 'string'
        ? value.id
        : undefined;
    if (!targetId) return [];
    return [{
      targetId: boundedText(targetId, 200),
      type: typeof value.type === 'string' ? boundedText(value.type, 100) : undefined,
      url: typeof value.url === 'string' ? sanitizeBrowserUrl(value.url) : undefined,
      title: typeof value.title === 'string' ? boundedText(value.title, MAX_TITLE_CHARS) : undefined,
      active: typeof value.active === 'boolean' ? value.active : undefined,
      paused: typeof value.paused === 'boolean' ? value.paused : undefined,
    }];
  });
}

function managedTargets(status: UnknownRecord): TargetDescription[] {
  return targetsFromStatus(status).filter((target) => target.type === undefined || target.type === 'page');
}

function managedTargetIds(status: UnknownRecord): Set<string> {
  return new Set(managedTargets(status).map((target) => target.targetId));
}

function assertManagedTarget(
  status: UnknownRecord,
  targetId: string,
  operation: string,
): TargetDescription {
  const target = managedTargets(status).find((candidate) => candidate.targetId === targetId);
  if (!target) {
    throw new Error(
      `${operation} target ${boundedText(targetId, 200)} is not managed by this Vite debug session. ` +
      `Managed targets: ${[...managedTargetIds(status)].join(', ') || 'none'}`,
    );
  }
  return target;
}

function controlTargetId(status: UnknownRecord, requestedTargetId?: string): string {
  const targets = managedTargets(status);
  if (requestedTargetId) {
    return assertManagedTarget(status, requestedTargetId, 'debug_control').targetId;
  }
  if (targets.length === 1) return targets[0].targetId;
  if (targets.length === 0) {
    throw new Error('debug_control has no managed Vite target to control');
  }
  throw new Error(
    'debug_control requires targetId when multiple managed Vite targets exist. ' +
    `Managed targets: ${targets.map((target) => target.targetId).join(', ')}`,
  );
}

function snapshotTargetId(status: UnknownRecord, requestedTargetId?: string): string | undefined {
  if (requestedTargetId) {
    assertManagedTarget(status, requestedTargetId, 'debug_snapshot');
    // The adapter keeps pause state per target. A managed running target can
    // legitimately return paused:false while another tab is paused.
    return requestedTargetId;
  }
  if (!isPaused(status)) return undefined;

  const targets = managedTargets(status);
  const reportedPauseTargetId = readString(
    status,
    ['pauseTargetId'],
    ['state', 'pauseTargetId'],
    ['debugger', 'pauseTargetId'],
  );
  const activeTargetId = reportedPauseTargetId ?? readString(
    status,
    ['activeTargetId'],
    ['state', 'activeTargetId'],
    ['debugger', 'activeTargetId'],
  );
  const representedTargetId = activeTargetId && targets.some((target) => target.targetId === activeTargetId)
    ? activeTargetId
    : targets.find((target) => target.active)?.targetId
      ?? (targets.filter((target) => target.paused).length === 1
        ? targets.find((target) => target.paused)?.targetId
        : undefined);

  if (representedTargetId) return representedTargetId;
  if (targets.length === 1) return targets[0].targetId;
  if (targets.length > 1) {
    throw new Error(
      'Multiple Vite targets are paused but the adapter did not identify the represented snapshot target. ' +
      'Call debug_status and retry with its activeTargetId.',
    );
  }
  return undefined;
}

function chromePortFromStatus(status: UnknownRecord): number {
  const raw = readUnknown(status, ['chromePort'], ['config', 'chromePort'], ['browser', 'chromePort']);
  const port = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(
      'The selected debug session did not report a valid chromePort. ' +
      'Restart it with the updated Vite Debugger extension.',
    );
  }
  return port;
}

function isPaused(status: UnknownRecord): boolean {
  const paused = readUnknown(status, ['paused'], ['state', 'paused'], ['debugger', 'paused']);
  if (paused === true) return true;
  const state = readUnknown(
    status,
    ['status'],
    ['state'],
    ['executionState'],
    ['state', 'status'],
    ['debugger', 'status'],
  );
  return typeof state === 'string' && state.toLowerCase() === 'paused';
}

function assertNotPaused(status: UnknownRecord, operation: string): void {
  if (isPaused(status)) {
    throw new Error(
      `${operation} is blocked while JavaScript is paused. ` +
      'Use debug_snapshot, then debug_control(action="continue") before mutating the page.',
    );
  }
}

function assertRendererAvailable(status: UnknownRecord, operation: string): void {
  if (isPaused(status)) {
    throw new Error(
      `${operation} cannot inspect the DOM while JavaScript is paused. ` +
      'Use debug_snapshot or resume execution first.',
    );
  }
}

async function runBrowserMutation(
  bridge: BridgeClient,
  selected: SelectedSession,
  operation: () => Promise<void>,
): Promise<UnknownRecord> {
  const pending = operation().then(
    () => ({ kind: 'completed' as const }),
    (error: unknown) => ({ kind: 'failed' as const, error }),
  );

  for (;;) {
    const settled = await Promise.race([
      pending,
      delay(250).then(() => ({ kind: 'poll' as const })),
    ]);
    if (settled.kind === 'completed') {
      // A Playwright command can resolve just before the adapter publishes a
      // breakpoint pause. Refresh once on the success path as well as while a
      // CDP command is pending so callers do not immediately issue a second
      // browser mutation against a paused renderer.
      await delay(25);
      try {
        const latest = await bridge.sessionRequest<unknown>(selected.sessionId, 'status', {});
        const latestStatus = isRecord(latest) ? latest : { value: latest };
        if (isPaused(latestStatus)) {
          return {
            outcome: 'paused',
            pendingActionMayCompleteAfterResume: false,
            debugStatus: publicDebugStatus(latestStatus),
          };
        }
      } catch {
        // The browser action itself succeeded; a transient status refresh
        // failure must not turn that success into an action failure.
      }
      return { outcome: 'completed' };
    }

    // A CDP input command can remain pending when its event handler reaches a
    // breakpoint. Poll the adapter so the agent receives the pause hand-off
    // immediately instead of waiting for the Playwright action timeout.
    try {
      const latest = await bridge.sessionRequest<unknown>(selected.sessionId, 'status', {});
      const latestStatus = isRecord(latest) ? latest : { value: latest };
      if (isPaused(latestStatus)) {
        return {
          outcome: 'paused',
          pendingActionMayCompleteAfterResume: true,
          debugStatus: publicDebugStatus(latestStatus),
          ...(settled.kind === 'failed' ? { actionError: errorMessage(settled.error) } : {}),
        };
      }
    } catch {
      // Preserve the original Playwright error when status refresh also fails.
    }

    if (settled.kind === 'failed') throw settled.error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function makeLocator(
  page: Page,
  args: {
    ref?: string;
    selector?: string;
    role?: string;
    name?: string;
    text?: string;
    label?: string;
    testId?: string;
    exact?: boolean;
    index?: number;
  },
): Locator {
  const choices = [args.ref, args.selector, args.role, args.text, args.label, args.testId]
    .filter((value) => value !== undefined);
  if (choices.length !== 1) {
    throw new Error(
      'Specify exactly one locator kind: ref, selector, role, text, label, or testId. ' +
      'Use browser_snapshot to obtain a stable ref.',
    );
  }

  let locator: Locator;
  if (args.ref) {
    const ref = normalizeAriaRef(args.ref);
    locator = page.locator(`aria-ref=${ref}`);
  } else if (args.selector) {
    locator = page.locator(args.selector);
  } else if (args.role) {
    locator = page.getByRole(args.role as Parameters<Page['getByRole']>[0], {
      name: args.name,
      exact: args.exact,
    });
  } else if (args.text) {
    locator = page.getByText(args.text, { exact: args.exact });
  } else if (args.label) {
    locator = page.getByLabel(args.label, { exact: args.exact });
  } else {
    locator = page.getByTestId(args.testId as string);
  }
  return args.index === undefined ? locator : locator.nth(args.index);
}

function normalizeAriaRef(value: string): string {
  const trimmed = value.trim();
  const bracket = /^\[?ref=([^\]\s]+)\]?$/.exec(trimmed);
  const engine = /^aria-ref=(.+)$/.exec(trimmed);
  const ref = bracket?.[1] ?? engine?.[1] ?? trimmed;
  if (!/^[A-Za-z0-9_-]+$/.test(ref)) {
    throw new Error(`Invalid accessibility ref: ${value}`);
  }
  return ref;
}

function sameOriginDestination(input: string, currentUrl: string, status: UnknownRecord): string {
  const viteUrl = readString(status, ['viteUrl'], ['config', 'viteUrl'], ['browser', 'viteUrl']);
  const base = viteUrl || currentUrl;
  let destination: URL;
  let allowed: URL;
  try {
    allowed = new URL(base);
    destination = new URL(input, currentUrl || base);
  } catch {
    throw new Error(`Invalid navigation URL: ${input}`);
  }
  if (!sameOrigin(destination, allowed)) {
    throw new Error(
      `Cross-origin navigation is disabled: ${destination.origin} does not match Vite origin ${allowed.origin}.`,
    );
  }
  return destination.href;
}

function urlMatchesVite(pageUrl: string, viteUrl: string): boolean {
  try {
    const page = new URL(pageUrl);
    const vite = new URL(viteUrl);
    if (!sameOrigin(page, vite)) return false;
    const basePath = vite.pathname.endsWith('/') ? vite.pathname : `${vite.pathname}/`;
    return vite.pathname === '/' || page.pathname === vite.pathname || page.pathname.startsWith(basePath);
  } catch {
    return pageUrl === viteUrl || pageUrl.startsWith(viteUrl.endsWith('/') ? viteUrl : `${viteUrl}/`);
  }
}

function sameOrigin(left: URL, right: URL): boolean {
  if (left.protocol !== right.protocol || effectivePort(left) !== effectivePort(right)) return false;
  return left.hostname === right.hostname || (isLoopback(left.hostname) && isLoopback(right.hostname));
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '';
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function sanitizeBrowserUrl(value: string): string {
  const parseCandidate = value.slice(0, MAX_URL_CHARS * 4);
  try {
    const parsed = new URL(parseCandidate);
    if (parsed.protocol === 'data:' || parsed.protocol === 'javascript:') {
      return `${parsed.protocol}[redacted]`;
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return boundedText(parsed.href, MAX_URL_CHARS);
  } catch {
    const withoutQueryOrHash = parseCandidate.split(/[?#]/, 1)[0];
    const withoutCredentials = withoutQueryOrHash.replace(
      /^([A-Za-z][A-Za-z\d+.-]*:\/\/)[^/@\s]+@/,
      '$1',
    );
    return boundedText(withoutCredentials, MAX_URL_CHARS);
  }
}

function boundedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 1)}…`;
}

function publicDebugStatus(status: UnknownRecord): UnknownRecord {
  const result: UnknownRecord = { ...status };
  if (typeof result.viteUrl === 'string') result.viteUrl = sanitizeBrowserUrl(result.viteUrl);
  if (Array.isArray(result.targets)) {
    result.targets = result.targets.slice(0, MAX_MANAGED_TARGETS).map((target) => {
      if (!isRecord(target)) return target;
      const sanitized: UnknownRecord = { ...target };
      if (typeof sanitized.url === 'string') sanitized.url = sanitizeBrowserUrl(sanitized.url);
      if (typeof sanitized.title === 'string') {
        sanitized.title = boundedText(sanitized.title, MAX_TITLE_CHARS);
      }
      return sanitized;
    });
  }
  return result;
}

function readString(record: UnknownRecord, ...paths: string[][]): string | undefined {
  const value = readUnknown(record, ...paths);
  return typeof value === 'string' ? value : undefined;
}

function readUnknown(record: UnknownRecord, ...paths: string[][]): unknown {
  for (const segments of paths) {
    let value: unknown = record;
    for (const segment of segments) {
      if (!isRecord(value)) {
        value = undefined;
        break;
      }
      value = value[segment];
    }
    if (value !== undefined) return value;
  }
  return undefined;
}

function appendRing<T>(entries: T[], value: T): void {
  entries.push(value);
  if (entries.length > MAX_EVENT_HISTORY) {
    entries.splice(0, entries.length - MAX_EVENT_HISTORY);
  }
}

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

async function safely(operation: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: errorMessage(error) }],
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
