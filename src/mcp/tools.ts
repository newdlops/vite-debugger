import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Frame,
  type Locator,
  type Page,
  type Request,
  type Response,
} from 'playwright-core';
import { z } from 'zod';
import { BridgeClient, BridgeRpcError, type BridgeSessionMetadata } from './BridgeClient';
import { localOriginsEquivalent } from '../util/LocalHosts';

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
const MAX_UPLOAD_FILES = 10;
const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_TRACE_BYTES = 100 * 1024 * 1024;
const MAX_TRACE_DURATION_MS = 5 * 60_000;
const DEBUG_START_CLEANUP_TIMEOUT_MS = 1_000;

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
  pageUrl: string;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  dispose: () => void;
}

interface TraceState {
  sessionId: string;
  context: BrowserContext;
  startedAt: string;
  startedAtMs: number;
  targetIds: string[];
  pageUrl: string;
  timer?: NodeJS.Timeout;
  guards: Array<() => void>;
  invalidReason?: string;
}

interface UploadFileDescription {
  path: string;
  relativePath: string;
  bytes: number;
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

const locatorSchema = z.object(locatorShape);
const waitConditionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('element'),
    locator: locatorSchema,
    state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional().default('visible'),
  }),
  z.object({
    kind: z.literal('url'),
    value: z.string().min(1).max(MAX_URL_CHARS),
    match: z.enum(['exact', 'contains']).optional().default('contains'),
  }),
  z.object({
    kind: z.literal('load'),
    state: z.enum(['domcontentloaded', 'load', 'networkidle']).optional().default('load'),
  }),
  z.object({
    kind: z.literal('console'),
    textContains: z.string().min(1).max(2_000),
    type: z.string().min(1).max(100).optional(),
    includeExisting: z.boolean().optional().default(true),
  }),
  z.object({
    kind: z.literal('request'),
    urlContains: z.string().min(1).max(MAX_URL_CHARS),
    method: z.string().min(1).max(32).optional(),
    includeExisting: z.boolean().optional().default(true),
  }),
  z.object({
    kind: z.literal('response'),
    urlContains: z.string().min(1).max(MAX_URL_CHARS),
    method: z.string().min(1).max(32).optional(),
    status: z.number().int().min(100).max(599).optional(),
    includeExisting: z.boolean().optional().default(true),
  }),
]);

type WaitCondition = z.infer<typeof waitConditionSchema>;

export function registerMcpTools(server: McpServer, bridge: BridgeClient): McpToolsRegistration {
  const browser = new BrowserController();

  server.registerTool('debug_start', {
    title: 'Start Vite debugging',
    description:
      'Starts a Vite debug session in this project\'s VS Code window without UI interaction. ' +
      'A matching launch.json configuration is used with its preLaunchTask; when none exists, a safe generated ' +
      'launch configuration attaches to an already-running Vite server. Reuses an active session. ' +
      'When several Vite servers use the same project sources, pass their local origin as viteUrl. ' +
      'When another local server renders the browser app, pass that route as pageUrl.',
    inputSchema: {
      configurationName: z.string().min(1).max(200).optional().describe(
        'Exact name of a type=vite launch configuration. Omit to prefer "Debug Vite App" or the only Vite configuration.',
      ),
      viteUrl: z.string().min(1).max(MAX_URL_CHARS).optional().describe(
        'Optional local Vite origin, for example https://alphac:3004. It must resolve exclusively to loopback; paths and credentials are rejected.',
      ),
      pageUrl: z.string().min(1).max(MAX_URL_CHARS).optional().describe(
        'Optional local browser application URL when the rendered page is served separately from Vite, for example http://alphac:8004/app.',
      ),
      timeoutMs: z.number().int().min(1_000).max(120_000).optional().default(30_000).describe(
        'Hard limit for discovery, start, adapter connection, and launch-page readiness.',
      ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (args) => safely(async () => {
    const deadline = Date.now() + args.timeoutMs;
    const existing = await beforeDeadline(
      () => listSessions(bridge),
      deadline,
      'list Vite debug sessions before starting',
    );
    if (existing.length > 1) {
      return jsonResult({
        workspace: bridge.workspace,
        started: false,
        reused: true,
        selectionRequired: true,
        sessions: existing,
      });
    }
    if (existing.length === 1) {
      const activeConfigurationName = typeof existing[0].name === 'string'
        ? existing[0].name
        : undefined;
      if (args.configurationName && activeConfigurationName !== args.configurationName) {
        return jsonErrorResult({
          workspace: bridge.workspace,
          started: false,
          reused: false,
          ready: false,
          state: 'conflict',
          message:
            `An active Vite debug session uses configuration ` +
            `${activeConfigurationName ? boundedText(activeConfigurationName, 200) : '(unknown)'}, ` +
            `not the requested ${args.configurationName}. ` +
            'Stop that session before starting another configuration.',
        });
      }
      const reusedStart: UnknownRecord = {
        accepted: false,
        reused: true,
        request: existing[0].request === 'attach' ? 'attach' : 'launch',
        ...(typeof existing[0].startOperationId === 'string'
          ? { operationId: existing[0].startOperationId }
          : {}),
      };
      const ready = await waitForStartedDebugSession(bridge, reusedStart, deadline);
      if (ready.failure) {
        return jsonErrorResult({
          workspace: bridge.workspace,
          started: false,
          reused: true,
          ready: false,
          state: ready.failure.state,
          message: ready.failure.message,
        });
      }
      if (ready.timedOut) {
        const cleanup = await cancelTimedOutCorrelatedDebugStart(
          bridge,
          reusedStart,
          ready.sessions,
        );
        if (cleanup?.cancelled) {
          return jsonErrorResult({
            workspace: bridge.workspace,
            started: false,
            reused: true,
            ready: false,
            state: 'terminated',
            cleanup,
            message: cleanup.message ??
              'Stopped the correlated Vite debug session after adapter readiness timed out.',
          });
        }
        return jsonResult({
          workspace: bridge.workspace,
          started: false,
          reused: true,
          ready: false,
          state: 'starting',
          sessions: ready.sessions,
          message: 'The existing Vite debug session is still connecting. Call debug_status before retrying.',
          ...(cleanup ? { cleanup } : {}),
          ...(ready.lastError ? { lastError: ready.lastError } : {}),
        });
      }
      if (!ready.selected) {
        return jsonResult({
          workspace: bridge.workspace,
          started: false,
          reused: true,
          selectionRequired: true,
          sessions: ready.sessions,
        });
      }
      if (args.viteUrl) {
        const activeViteUrl = readString(
          ready.selected.status,
          ['viteUrl'],
          ['config', 'viteUrl'],
          ['browser', 'viteUrl'],
        );
        if (!activeViteUrl || !urlsHaveSameOrigin(args.viteUrl, activeViteUrl)) {
          return jsonErrorResult({
            workspace: bridge.workspace,
            started: false,
            reused: false,
            ready: false,
            state: 'conflict',
            message:
              `An active Vite debug session uses ${activeViteUrl ?? 'an unknown Vite URL'}, ` +
              `not the requested ${args.viteUrl}. Stop that session before starting another URL.`,
          });
        }
      }
      if (args.pageUrl) {
        const activePageUrl = browserPageUrl(ready.selected.status);
        if (!activePageUrl || !urlsReferToSamePage(args.pageUrl, activePageUrl)) {
          return jsonErrorResult({
            workspace: bridge.workspace,
            started: false,
            reused: false,
            ready: false,
            state: 'conflict',
            message:
              `An active Vite debug session uses ${activePageUrl ?? 'an unknown browser page URL'}, ` +
              `not the requested ${args.pageUrl}. Stop that session before starting another page URL.`,
          });
        }
      }
      const conflict = debugStartSelectionConflict(bridge, args, reusedStart, ready.selected);
      return conflict ?? readyDebugStartResult(bridge, reusedStart, ready.selected);
    }

    const rawStart = await beforeDeadline(
      () => bridge.startDebugging<unknown>({
        operationId: crypto.randomUUID(),
        ...(args.configurationName ? { configurationName: args.configurationName } : {}),
        ...(args.viteUrl ? { viteUrl: args.viteUrl } : {}),
        ...(args.pageUrl ? { pageUrl: args.pageUrl } : {}),
      }),
      deadline,
      'ask VS Code to start Vite debugging',
    );
    const start = publicDebugStart(rawStart);
    const ready = await waitForStartedDebugSession(bridge, start, deadline);
    if (ready.failure) {
      return jsonErrorResult({
        workspace: bridge.workspace,
        started: false,
        reused: start.reused === true,
        ready: false,
        state: ready.failure.state,
        start,
        message: ready.failure.message,
      });
    }
    if (ready.timedOut) {
      const cleanup = await cancelTimedOutCorrelatedDebugStart(bridge, start, ready.sessions);
      if (cleanup?.cancelled) {
        return jsonErrorResult({
          workspace: bridge.workspace,
          started: start.reused !== true,
          reused: start.reused === true,
          ready: false,
          state: 'terminated',
          start,
          cleanup,
          message: cleanup.message ??
            'Stopped the correlated Vite debug session after adapter readiness timed out.',
        });
      }
      return jsonResult({
        workspace: bridge.workspace,
        started: start.reused !== true,
        reused: start.reused === true,
        ready: false,
        state: 'starting',
        start,
        sessions: ready.sessions,
        message:
          'No connected Vite session is ready yet. A configured preLaunchTask may still be starting. ' +
          'Call debug_status before retrying; if no preLaunchTask is configured, start the Vite dev server first.',
        ...(cleanup ? { cleanup } : {}),
        ...(ready.lastError ? { lastError: ready.lastError } : {}),
      });
    }
    if (!ready.selected) {
      return jsonResult({
        workspace: bridge.workspace,
        started: true,
        reused: start.reused === true,
        selectionRequired: true,
        sessions: ready.sessions,
        start,
      });
    }
    const conflict = debugStartSelectionConflict(bridge, args, start, ready.selected);
    return conflict ?? readyDebugStartResult(bridge, start, ready.selected);
  }));

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

  server.registerTool('debug_evaluate', {
    title: 'Evaluate in paused frame',
    description:
      'Evaluates a JavaScript expression in a selected paused call frame and returns a bounded preview. ' +
      'Expressions can have side effects; use simple reads unless mutation is intentional.',
    inputSchema: {
      ...pageShape,
      expression: z.string().min(1).max(10_000),
      frameIndex: z.number().int().min(0).max(19).optional().default(0),
      pauseEpoch: z.number().int().nonnegative().optional().describe(
        'Pause epoch from debug_snapshot. When provided, stale evaluations are rejected.',
      ),
      allowSideEffects: z.boolean().optional().default(false).describe(
        'Allow assignments, calls, and other expressions that may mutate page state.',
      ),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    const targetId = snapshotTargetId(selected.status, args.targetId);
    const result = await bridge.sessionRequest(selected.sessionId, 'evaluate', {
      expression: args.expression,
      frameIndex: args.frameIndex,
      pauseEpoch: args.pauseEpoch,
      allowSideEffects: args.allowSideEffects,
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
    const pageUrl = browserPageUrl(selected.status);
    return jsonResult({
      sessionId: selected.sessionId,
      viteUrl: viteUrl ? sanitizeBrowserUrl(viteUrl) : undefined,
      pageUrl: pageUrl ? sanitizeBrowserUrl(pageUrl) : undefined,
      pages: pages.map(({ targetId, url, title }) => ({
        targetId,
        url,
        title,
        matchesViteApp: pageUrl ? urlMatchesBrowserApp(url, pageUrl) : undefined,
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
      openIfMissing: z.boolean().optional().default(true).describe(
        'Reopen the session Vite page when every managed tab was closed. Ignored when targetId is provided.',
      ),
      waitUntil: z.enum(['commit', 'domcontentloaded', 'load', 'networkidle'])
        .optional().default('domcontentloaded'),
      timeoutMs: z.number().int().min(100).max(60_000).optional().default(DEFAULT_ACTION_TIMEOUT_MS),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => safely(async () => {
    let selected = await selectSession(bridge, args.sessionId);
    assertNotPaused(selected.status, 'browser_navigate');
    let createdTarget = false;
    let chosen: PageDescription;
    let destination: string;

    if (!args.targetId && managedTargets(selected.status).length === 0) {
      const pageUrl = browserPageUrl(selected.status);
      if (!pageUrl) {
        throw new Error('The selected debug session did not report its browser application URL');
      }
      // Reject unsafe destinations before asking the adapter to create a tab.
      destination = sameOriginDestination(args.url, pageUrl, selected.status);
      if (!args.openIfMissing) {
        throw new Error(
          'No managed Vite page is open. Retry browser_navigate with openIfMissing=true or open the Vite URL in debug Chrome.',
        );
      }
      browser.assertCanOpenPage(selected.sessionId);
      const rawEnsured = await bridge.sessionRequest<unknown>(
        selected.sessionId,
        'ensureBrowserTarget',
        {},
      );
      if (!isRecord(rawEnsured) || typeof rawEnsured.targetId !== 'string') {
        throw new Error('The debug adapter did not return the reopened Vite target id');
      }
      createdTarget = rawEnsured.created === true;
      const ready = await waitForManagedPage(
        bridge,
        browser,
        selected,
        rawEnsured.targetId,
        10_000,
      );
      selected = ready.selected;
      chosen = ready.page;
    } else {
      chosen = await browser.selectPage(selected.status, args.targetId);
      destination = sameOriginDestination(args.url, chosen.url, selected.status);
    }
    const outcome = await runBrowserMutation(bridge, selected, async () => {
      await chosen.page.goto(destination, { waitUntil: args.waitUntil, timeout: args.timeoutMs });
    });
    return jsonResult({
      sessionId: selected.sessionId,
      targetId: chosen.targetId,
      url: sanitizeBrowserUrl(chosen.page.url()),
      createdTarget,
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

  server.registerTool('browser_wait_for', {
    title: 'Wait for browser condition',
    description:
      'Waits for an element, URL, load state, console message, request, or response. Existing console/network ' +
      'history is checked first by default, and a debugger pause is returned immediately.',
    inputSchema: {
      ...pageShape,
      condition: waitConditionSchema,
      timeoutMs: z.number().int().min(100).max(60_000).optional().default(DEFAULT_ACTION_TIMEOUT_MS),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    assertRendererAvailable(selected.status, 'browser_wait_for');
    const chosen = await browser.selectPage(selected.status, args.targetId);
    const outcome = await runBrowserOperation(
      bridge,
      selected,
      () => browser.waitFor(chosen.page, args.condition, args.timeoutMs),
    );
    return jsonResult({ sessionId: selected.sessionId, targetId: chosen.targetId, ...outcome });
  }));

  server.registerTool('browser_hover', {
    title: 'Hover page element',
    description: 'Moves the pointer over a selected element. Hover handlers can reach debugger breakpoints.',
    inputSchema: {
      ...pageShape,
      ...locatorShape,
      timeoutMs: z.number().int().min(100).max(60_000).optional().default(DEFAULT_ACTION_TIMEOUT_MS),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    assertNotPaused(selected.status, 'browser_hover');
    const chosen = await browser.selectPage(selected.status, args.targetId);
    const locator = makeLocator(chosen.page, args);
    const outcome = await runBrowserMutation(bridge, selected, () =>
      locator.hover({ timeout: args.timeoutMs }));
    return jsonResult({ sessionId: selected.sessionId, targetId: chosen.targetId, ...outcome });
  }));

  server.registerTool('browser_select', {
    title: 'Select options',
    description: 'Selects one or more values in a <select> element and returns the selected values.',
    inputSchema: {
      ...pageShape,
      ...locatorShape,
      values: z.array(z.string().max(MAX_INPUT_VALUE_CHARS)).min(1).max(100),
      timeoutMs: z.number().int().min(100).max(60_000).optional().default(DEFAULT_ACTION_TIMEOUT_MS),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    assertNotPaused(selected.status, 'browser_select');
    const chosen = await browser.selectPage(selected.status, args.targetId);
    const locator = makeLocator(chosen.page, args);
    const outcome = await runBrowserOperation(
      bridge,
      selected,
      () => locator.selectOption(args.values, { timeout: args.timeoutMs }),
    );
    return jsonResult({ sessionId: selected.sessionId, targetId: chosen.targetId, ...outcome });
  }));

  server.registerTool('browser_check', {
    title: 'Check or uncheck control',
    description: 'Sets a checkbox or radio control to the requested checked state.',
    inputSchema: {
      ...pageShape,
      ...locatorShape,
      checked: z.boolean().optional().default(true),
      timeoutMs: z.number().int().min(100).max(60_000).optional().default(DEFAULT_ACTION_TIMEOUT_MS),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    assertNotPaused(selected.status, 'browser_check');
    const chosen = await browser.selectPage(selected.status, args.targetId);
    const locator = makeLocator(chosen.page, args);
    const outcome = await runBrowserMutation(bridge, selected, () =>
      locator.setChecked(args.checked, { timeout: args.timeoutMs }));
    return jsonResult({ sessionId: selected.sessionId, targetId: chosen.targetId, ...outcome });
  }));

  server.registerTool('browser_upload', {
    title: 'Upload project files',
    description:
      'Sets files on a file input. Paths must resolve to regular files inside the configured workspace; ' +
      'an empty files array clears the input.',
    inputSchema: {
      ...pageShape,
      ...locatorShape,
      files: z.array(z.string().min(1).max(MAX_URL_CHARS)).max(MAX_UPLOAD_FILES),
      timeoutMs: z.number().int().min(100).max(60_000).optional().default(DEFAULT_ACTION_TIMEOUT_MS),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    assertNotPaused(selected.status, 'browser_upload');
    const chosen = await browser.selectPage(selected.status, args.targetId);
    const locator = makeLocator(chosen.page, args);
    const files = await validateUploadFiles(bridge.workspace, args.files);
    const outcome = await runBrowserMutation(bridge, selected, () =>
      locator.setInputFiles(files.map((file) => file.path), { timeout: args.timeoutMs }));
    return jsonResult({
      sessionId: selected.sessionId,
      targetId: chosen.targetId,
      files: files.map(({ relativePath, bytes }) => ({ relativePath, bytes })),
      ...outcome,
    });
  }));

  server.registerTool('browser_trace', {
    title: 'Record Playwright trace',
    description:
      'Explicitly starts, stops, or reports a Playwright trace. Traces may contain DOM, network data, and screenshots. ' +
      'Recording is rejected when the browser context contains a page outside the managed Vite app.',
    inputSchema: {
      ...pageShape,
      action: z.enum(['start', 'stop', 'status']),
      screenshots: z.boolean().optional().default(true),
      snapshots: z.boolean().optional().default(true),
      sources: z.boolean().optional().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => safely(async () => {
    const selected = await selectSession(bridge, args.sessionId);
    if (args.action === 'status') {
      return jsonResult({
        sessionId: selected.sessionId,
        trace: await browser.traceStatus(selected.sessionId),
      });
    }
    if (args.action === 'stop') {
      const trace = await browser.stopTrace(selected.sessionId, bridge.workspace);
      return jsonResult({ sessionId: selected.sessionId, trace });
    }

    assertRendererAvailable(selected.status, 'browser_trace');
    const chosen = await browser.selectPage(selected.status, args.targetId);
    const trace = await browser.startTrace(
      selected.sessionId,
      chosen,
      selected.status,
      { screenshots: args.screenshots, snapshots: args.snapshots, sources: args.sources },
    );
    return jsonResult({ sessionId: selected.sessionId, targetId: chosen.targetId, trace });
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
  private activeTrace: TraceState | undefined;

  assertCanOpenPage(sessionId: string): void {
    const trace = this.activeTrace;
    if (!trace) return;
    if (trace.sessionId !== sessionId) {
      throw new Error(`A browser trace belongs to another debug session: ${trace.sessionId}`);
    }
    throw new Error(
      'browser_navigate cannot reopen a page while a browser trace is active. Stop the trace first.',
    );
  }

  async pagesForStatus(status: UnknownRecord): Promise<PageDescription[]> {
    const allowedTargetIds = managedTargetIds(status);
    if (allowedTargetIds.size === 0) {
      this.clearPageStates();
      return [];
    }
    const pageUrl = browserPageUrl(status);
    if (!pageUrl) {
      this.clearPageStates();
      throw new Error('The selected debug session did not report its browser application URL');
    }
    const port = chromePortFromStatus(status);
    const browser = await this.ensureConnected(port);
    const pages = browser.contexts().flatMap((context) => context.pages()).filter((page) => !page.isClosed());
    const descriptions = (await this.describePages(pages))
      .filter((page) =>
        allowedTargetIds.has(page.targetId) && urlMatchesBrowserApp(page.page.url(), pageUrl)
      );
    this.reconcilePageStates(descriptions, pageUrl);
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
    await this.discardActiveTrace();
    await this.disconnectCurrent('Vite Debugger MCP server disposed');
  }

  async waitFor(page: Page, condition: WaitCondition, timeoutMs: number): Promise<UnknownRecord> {
    const state = this.states.get(page);
    if (!state) throw new Error('The selected page is no longer a managed Vite target');

    switch (condition.kind) {
      case 'element': {
        const locator = makeLocator(page, condition.locator);
        await locator.waitFor({ state: condition.state, timeout: timeoutMs });
        return { kind: condition.kind, state: condition.state };
      }
      case 'url': {
        const expected = condition.match === 'exact'
          ? sameOriginDestination(condition.value, page.url(), { pageUrl: state.pageUrl })
          : undefined;
        await page.waitForURL((url) => {
          if (!urlMatchesBrowserApp(url.href, state.pageUrl)) return false;
          const sanitized = sanitizeBrowserUrl(url.href);
          return condition.match === 'exact'
            ? sanitized === sanitizeBrowserUrl(expected!)
            : sanitized.includes(condition.value);
        }, { timeout: timeoutMs });
        return { kind: condition.kind, url: sanitizeBrowserUrl(page.url()) };
      }
      case 'load':
        await page.waitForLoadState(condition.state, { timeout: timeoutMs });
        return { kind: condition.kind, state: condition.state, url: sanitizeBrowserUrl(page.url()) };
      case 'console': {
        const matches = (entry: ConsoleEntry) =>
          entry.text.includes(condition.textContains) &&
          (!condition.type || entry.type === condition.type);
        const existing = condition.includeExisting ? [...state.console].reverse().find(matches) : undefined;
        if (existing) return { kind: condition.kind, source: 'history', message: existing };

        if (condition.type === 'pageerror') {
          const error = await page.waitForEvent('pageerror', {
            predicate: (candidate) => candidate.message.includes(condition.textContains),
            timeout: timeoutMs,
          });
          return {
            kind: condition.kind,
            source: 'event',
            message: {
              timestamp: new Date().toISOString(),
              type: 'pageerror',
              text: boundedText(error.message, MAX_CONSOLE_TEXT_CHARS),
              pageUrl: sanitizeBrowserUrl(page.url()),
            },
          };
        }
        const message = await page.waitForEvent('console', {
          predicate: (candidate) => candidate.text().includes(condition.textContains) &&
            (!condition.type || candidate.type() === condition.type),
          timeout: timeoutMs,
        });
        return {
          kind: condition.kind,
          source: 'event',
          message: {
            timestamp: new Date().toISOString(),
            type: boundedText(message.type(), 100),
            text: boundedText(message.text(), MAX_CONSOLE_TEXT_CHARS),
            pageUrl: sanitizeBrowserUrl(page.url()),
          },
        };
      }
      case 'request': {
        const method = condition.method?.toUpperCase();
        const matches = (entry: NetworkEntry) => entry.phase === 'request' &&
          entry.url.includes(condition.urlContains) && (!method || entry.method.toUpperCase() === method);
        const existing = condition.includeExisting ? [...state.network].reverse().find(matches) : undefined;
        if (existing) return { kind: condition.kind, source: 'history', request: existing };
        const request = await page.waitForRequest((candidate) =>
          sanitizeBrowserUrl(candidate.url()).includes(condition.urlContains) &&
          (!method || candidate.method().toUpperCase() === method),
        { timeout: timeoutMs });
        return {
          kind: condition.kind,
          source: 'event',
          request: {
            method: boundedText(request.method(), 32),
            url: sanitizeBrowserUrl(request.url()),
            resourceType: boundedText(request.resourceType(), 100),
          },
        };
      }
      case 'response': {
        const method = condition.method?.toUpperCase();
        const matches = (entry: NetworkEntry) => entry.phase === 'response' &&
          entry.url.includes(condition.urlContains) &&
          (!method || entry.method.toUpperCase() === method) &&
          (condition.status === undefined || entry.status === condition.status);
        const existing = condition.includeExisting ? [...state.network].reverse().find(matches) : undefined;
        if (existing) return { kind: condition.kind, source: 'history', response: existing };
        const response = await page.waitForResponse((candidate) => {
          const request = candidate.request();
          return sanitizeBrowserUrl(candidate.url()).includes(condition.urlContains) &&
            (!method || request.method().toUpperCase() === method) &&
            (condition.status === undefined || candidate.status() === condition.status);
        }, { timeout: timeoutMs });
        return {
          kind: condition.kind,
          source: 'event',
          response: {
            method: boundedText(response.request().method(), 32),
            url: sanitizeBrowserUrl(response.url()),
            status: response.status(),
            statusText: boundedText(response.statusText(), 500),
          },
        };
      }
    }
  }

  async startTrace(
    sessionId: string,
    selected: PageDescription,
    status: UnknownRecord,
    options: { screenshots: boolean; snapshots: boolean; sources: boolean },
  ): Promise<UnknownRecord> {
    if (this.activeTrace) {
      throw new Error(`A browser trace is already active for session ${this.activeTrace.sessionId}`);
    }
    const context = selected.page.context();
    const allowedTargetIds = managedTargetIds(status);
    const pageUrl = browserPageUrl(status);
    if (!pageUrl) throw new Error('The selected debug session did not report its browser application URL');
    const descriptions = await this.describePages(
      context.pages().filter((page) => !page.isClosed()),
    );
    const unmanaged = descriptions.filter((page) =>
      !allowedTargetIds.has(page.targetId) || !urlMatchesBrowserApp(page.url, pageUrl));
    if (unmanaged.length > 0) {
      throw new Error(
        'Trace recording is blocked because the Chrome context contains a page outside this managed Vite app: ' +
        unmanaged.map((page) => `${page.targetId} (${page.url})`).join(', '),
      );
    }

    const startedAtMs = Date.now();
    const trace: TraceState = {
      sessionId,
      context,
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      targetIds: descriptions.map((page) => page.targetId).sort(),
      pageUrl,
      guards: [],
    };
    this.installTraceGuards(trace, context.pages().filter((page) => !page.isClosed()));
    try {
      await context.tracing.start(options);
      if (trace.invalidReason) {
        await context.tracing.stop().catch(() => undefined);
        throw new Error(trace.invalidReason);
      }
      trace.timer = setTimeout(() => {
        if (this.activeTrace === trace) void this.discardActiveTrace();
      }, MAX_TRACE_DURATION_MS);
    } catch (error) {
      this.disposeTraceGuards(trace);
      throw error;
    }
    trace.timer?.unref?.();
    this.activeTrace = trace;
    return this.publicTraceStatus(trace);
  }

  async traceStatus(sessionId: string): Promise<UnknownRecord> {
    const trace = this.activeTrace;
    if (!trace) return { active: false };
    if (trace.sessionId !== sessionId) {
      throw new Error(`A browser trace belongs to another debug session: ${trace.sessionId}`);
    }
    await this.refreshTraceValidity(trace);
    return this.publicTraceStatus(trace);
  }

  async stopTrace(sessionId: string, workspace: string): Promise<UnknownRecord> {
    const trace = this.activeTrace;
    if (!trace) throw new Error('No browser trace is active');
    if (trace.sessionId !== sessionId) {
      throw new Error(`The active browser trace belongs to another debug session: ${trace.sessionId}`);
    }
    this.activeTrace = undefined;
    if (trace.timer) clearTimeout(trace.timer);

    let filePath: string | undefined;
    try {
      await this.refreshTraceValidity(trace);
      const directory = await prepareTraceDirectory(workspace);
      filePath = path.join(
        directory,
        `vite-debugger-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.zip`,
      );
      await trace.context.tracing.stop({ path: filePath });
      if (trace.invalidReason) {
        await fs.unlink(filePath).catch(() => undefined);
        throw new Error(`Trace was discarded for privacy: ${trace.invalidReason}`);
      }
      await fs.chmod(filePath, 0o600);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error('Playwright did not create a trace file');
      if (stat.size > MAX_TRACE_BYTES) {
        await fs.unlink(filePath).catch(() => undefined);
        throw new Error(`Trace exceeded the ${MAX_TRACE_BYTES}-byte size limit and was deleted`);
      }
      await pruneTraceDirectory(directory, filePath);
      return {
        active: false,
        startedAt: trace.startedAt,
        stoppedAt: new Date().toISOString(),
        durationMs: Date.now() - trace.startedAtMs,
        path: filePath,
        bytes: stat.size,
        environment: process.platform,
      };
    } catch (error) {
      if (filePath) await fs.unlink(filePath).catch(() => undefined);
      await trace.context.tracing.stop().catch(() => undefined);
      throw error;
    } finally {
      this.disposeTraceGuards(trace);
    }
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
          void this.discardActiveTrace();
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
    await this.discardActiveTrace();
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

  private publicTraceStatus(trace: TraceState): UnknownRecord {
    return {
      active: true,
      startedAt: trace.startedAt,
      durationMs: Date.now() - trace.startedAtMs,
      maxDurationMs: MAX_TRACE_DURATION_MS,
      targetIds: trace.targetIds,
      valid: trace.invalidReason === undefined,
      ...(trace.invalidReason ? { invalidReason: trace.invalidReason } : {}),
    };
  }

  private async discardActiveTrace(): Promise<void> {
    const trace = this.activeTrace;
    if (!trace) return;
    this.activeTrace = undefined;
    if (trace.timer) clearTimeout(trace.timer);
    try {
      await trace.context.tracing.stop().catch(() => undefined);
    } finally {
      this.disposeTraceGuards(trace);
    }
  }

  private installTraceGuards(trace: TraceState, pages: readonly Page[]): void {
    const watchPage = (page: Page) => {
      const onFrameNavigated = (frame: Frame) => {
        if (frame !== page.mainFrame() || urlMatchesBrowserApp(frame.url(), trace.pageUrl)) return;
        trace.invalidReason ??=
          `a traced page navigated outside the managed Vite app (${sanitizeBrowserUrl(frame.url())})`;
      };
      page.on('framenavigated', onFrameNavigated);
      trace.guards.push(() => page.off('framenavigated', onFrameNavigated));
    };
    const onPage = (page: Page) => {
      trace.invalidReason ??= 'the traced browser context opened a new page';
      watchPage(page);
    };
    trace.context.on('page', onPage);
    trace.guards.push(() => trace.context.off('page', onPage));
    for (const page of pages) watchPage(page);
  }

  private disposeTraceGuards(trace: TraceState): void {
    for (const dispose of trace.guards.splice(0)) dispose();
  }

  private async refreshTraceValidity(trace: TraceState): Promise<void> {
    // Target lifecycle notifications arrive independently on each CDP client.
    // Yield briefly before inspecting the context so a page opened by the app
    // or another attached client cannot slip into a trace artifact.
    await delay(25);
    const descriptions = await this.describePages(
      trace.context.pages().filter((page) => !page.isClosed()),
    );
    const originalTargets = new Set(trace.targetIds);
    const unexpected = descriptions.find((page) =>
      !originalTargets.has(page.targetId) || !urlMatchesBrowserApp(page.url, trace.pageUrl));
    if (unexpected) {
      trace.invalidReason ??=
        `the traced context contains an unexpected page (${unexpected.targetId}, ${unexpected.url})`;
    }
  }

  private reconcilePageStates(pages: PageDescription[], pageUrl: string): void {
    const allowedPages = new Set(pages.map(({ page }) => page));
    for (const page of this.states.keys()) {
      if (!allowedPages.has(page)) this.unwatchPage(page);
    }
    for (const { page } of pages) this.watchPage(page, pageUrl);
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

  private watchPage(page: Page, pageUrl: string): PageState {
    const existing = this.states.get(page);
    if (existing) {
      existing.pageUrl = pageUrl;
      return existing;
    }
    const state: PageState = {
      capturedSince: new Date().toISOString(),
      pageUrl,
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
        !urlMatchesBrowserApp(request.url(), state.pageUrl)
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
      if (frame === page.mainFrame() && !urlMatchesBrowserApp(frame.url(), state.pageUrl)) {
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

  private async describePages(pages: readonly Page[]): Promise<PageDescription[]> {
    const settled = await Promise.allSettled(pages.map((page) => this.describePage(page)));
    return settled.flatMap((result, index) => {
      if (result.status === 'fulfilled') return [result.value];
      const page = pages[index];
      if (page.isClosed() || isVanishedPlaywrightPageError(result.reason)) return [];
      throw result.reason;
    });
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

function publicDebugStart(raw: unknown): UnknownRecord {
  if (!isRecord(raw)) return {};
  const result: UnknownRecord = {};
  if (typeof raw.accepted === 'boolean') result.accepted = raw.accepted;
  if (typeof raw.reused === 'boolean') result.reused = raw.reused;
  if (raw.state === 'starting') result.state = raw.state;
  if (typeof raw.configurationName === 'string') {
    result.configurationName = boundedText(raw.configurationName, 200);
  }
  if (typeof raw.operationId === 'string' && /^[0-9a-f-]{36}$/i.test(raw.operationId)) {
    result.operationId = raw.operationId;
  }
  if (raw.source === 'workspace' || raw.source === 'generated') result.source = raw.source;
  if (raw.request === 'launch' || raw.request === 'attach') result.request = raw.request;
  if (typeof raw.preLaunchTask === 'boolean') result.preLaunchTask = raw.preLaunchTask;
  if (typeof raw.viteUrl === 'string') result.viteUrl = sanitizeBrowserUrl(raw.viteUrl);
  if (typeof raw.pageUrl === 'string') result.pageUrl = sanitizeBrowserUrl(raw.pageUrl);
  return result;
}

function debugStartSelectionConflict(
  bridge: BridgeClient,
  requested: { configurationName?: string; viteUrl?: string; pageUrl?: string },
  start: UnknownRecord,
  selected: SelectedSession,
): CallToolResult | undefined {
  const reused = start.reused === true;
  const activeConfigurationName = typeof selected.metadata.name === 'string'
    ? boundedText(selected.metadata.name, 200)
    : undefined;
  if (requested.configurationName && activeConfigurationName !== requested.configurationName) {
    return jsonErrorResult({
      workspace: bridge.workspace,
      started: !reused,
      reused,
      ready: false,
      state: 'conflict',
      message:
        `The selected Vite session uses configuration ${activeConfigurationName ?? '(unknown)'}, ` +
        `not the requested ${requested.configurationName}. Stop that session before retrying.`,
    });
  }

  if (requested.viteUrl) {
    const activeViteUrl = readString(
      selected.status,
      ['viteUrl'],
      ['config', 'viteUrl'],
      ['browser', 'viteUrl'],
    );
    if (!activeViteUrl || !urlsHaveSameOrigin(requested.viteUrl, activeViteUrl)) {
      return jsonErrorResult({
        workspace: bridge.workspace,
        started: !reused,
        reused,
        ready: false,
        state: 'conflict',
        message:
          `The selected Vite session uses ${activeViteUrl ?? 'an unknown Vite URL'}, ` +
          `not the requested ${requested.viteUrl}. Stop that session before retrying.`,
      });
    }
  }

  if (requested.pageUrl) {
    const activePageUrl = browserPageUrl(selected.status);
    if (!activePageUrl || !urlsReferToSamePage(requested.pageUrl, activePageUrl)) {
      return jsonErrorResult({
        workspace: bridge.workspace,
        started: !reused,
        reused,
        ready: false,
        state: 'conflict',
        message:
          `The selected Vite session uses ${activePageUrl ?? 'an unknown browser page URL'}, ` +
          `not the requested ${requested.pageUrl}. Stop that session before retrying.`,
      });
    }
  }
  return undefined;
}

async function cancelTimedOutCorrelatedDebugStart(
  bridge: BridgeClient,
  start: UnknownRecord,
  sessions: readonly BridgeSessionMetadata[],
): Promise<UnknownRecord | undefined> {
  const operationId = typeof start.operationId === 'string' && /^[0-9a-f-]{36}$/i.test(start.operationId)
    ? start.operationId
    : undefined;
  if (!operationId || !sessions.some((session) => session.startOperationId === operationId)) {
    return undefined;
  }

  try {
    const raw = await beforeDeadline(
      () => bridge.cancelDebugStart<unknown>(operationId),
      Date.now() + DEBUG_START_CLEANUP_TIMEOUT_MS,
      'stop the timed-out correlated Vite debug session',
    );
    if (!isRecord(raw)) return { attempted: true, cancelled: false };
    return {
      attempted: true,
      cancelled: raw.cancelled === true,
      ...(raw.state === 'starting' || raw.state === 'accepted' ||
          raw.state === 'declined' || raw.state === 'failed' ||
          raw.state === 'terminated' || raw.state === 'unknown'
        ? { state: raw.state }
        : {}),
      ...(typeof raw.reason === 'string'
        ? { reason: boundedText(raw.reason, 200) }
        : {}),
      ...(typeof raw.message === 'string'
        ? { message: boundedText(raw.message, MAX_ERROR_TEXT_CHARS) }
        : {}),
    };
  } catch (error) {
    return {
      attempted: true,
      cancelled: false,
      error: boundedText(error instanceof Error ? error.message : String(error), MAX_ERROR_TEXT_CHARS),
    };
  }
}

function readyDebugStartResult(
  bridge: BridgeClient,
  start: UnknownRecord,
  selected: SelectedSession,
): CallToolResult {
  const status = publicDebugStatus(selected.status);
  const request = start.request === 'attach' || selected.metadata.request === 'attach'
    ? 'attach'
    : 'launch';
  const noManagedTarget = managedTargets(selected.status).length === 0;
  return jsonResult({
    workspace: bridge.workspace,
    started: start.reused !== true,
    reused: start.reused === true,
    ready: true,
    start,
    sessionId: selected.sessionId,
    metadata: selected.metadata,
    ...status,
    ...(noManagedTarget ? {
      message:
        request === 'attach'
          ? 'The attach session is connected but has no managed Vite page yet. ' +
            'Call browser_navigate to open and attach the project Vite page.'
          : 'The launch session is connected but no managed Vite page is open. ' +
            'Call browser_navigate to reopen and attach the project Vite page.',
    } : {}),
  });
}

async function waitForStartedDebugSession(
  bridge: BridgeClient,
  start: UnknownRecord,
  deadline: number,
): Promise<{
  sessions: BridgeSessionMetadata[];
  selected?: SelectedSession;
  failure?: { state: 'declined' | 'failed' | 'terminated'; message: string };
  timedOut?: boolean;
  lastError?: string;
}> {
  const operationId = typeof start.operationId === 'string' ? start.operationId : undefined;
  const request = start.request === 'attach' ? 'attach' : 'launch';
  const recoveredTargets = new Set<string>();
  let lastError: unknown;
  let sessions: BridgeSessionMetadata[] = [];
  while (Date.now() < deadline) {
    try {
      sessions = await beforeDeadline(
        () => listSessions(bridge),
        deadline,
        'list Vite debug sessions',
      );
    } catch (error) {
      lastError = error;
      break;
    }
    // An unrelated/manual session can appear while VS Code runs a preLaunchTask.
    // When this start has a correlation token, selecting no session is safer
    // than attaching browser control to the wrong project/session.
    const candidates = operationId
      ? sessions.filter((session) => session.startOperationId === operationId)
      : sessions;
    if (candidates.length > 1) return { sessions: candidates };
    if (candidates.length === 1) {
      try {
        const selected = await beforeDeadline(
          () => selectSession(bridge, candidates[0].sessionId, sessions),
          deadline,
          'read Vite debug status',
        );
        const connected = readUnknown(
          selected.status,
          ['connected'],
          ['browser', 'connected'],
          ['debugger', 'connected'],
        ) === true;
        const launchTargetReady = request === 'attach' || managedTargets(selected.status).length > 0;
        if (connected && launchTargetReady) return { sessions: candidates, selected };
        if (connected && request === 'launch' && start.reused === true) {
          if (recoveredTargets.has(selected.sessionId)) {
            // The debugger itself is usable even if tab recreation did not
            // become visible in status yet; browser_navigate can retry the
            // same narrow recovery request and reports an actionable error.
            return { sessions: candidates, selected };
          }
          recoveredTargets.add(selected.sessionId);
          try {
            await beforeDeadline(
              () => bridge.sessionRequest(selected.sessionId, 'ensureBrowserTarget', {}),
              deadline,
              'reopen the Vite browser target',
            );
          } catch (error) {
            lastError = error;
          }
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (operationId) {
      try {
        const operation = publicDebugStartOperation(
          await beforeDeadline(
            () => bridge.debugStartStatus<unknown>(operationId),
            deadline,
            'read Vite debug start status',
          ),
        );
        if (operation.state === 'declined' || operation.state === 'failed' ||
            operation.state === 'terminated') {
          return {
            sessions: candidates,
            failure: {
              state: operation.state,
              message: operation.message ?? 'VS Code did not start the Vite debug configuration',
            },
          };
        }
      } catch (error) {
        lastError = error;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(100, remaining));
  }

  return {
    sessions,
    timedOut: true,
    ...(lastError instanceof Error ? { lastError: boundedText(lastError.message, MAX_ERROR_TEXT_CHARS) } : {}),
  };
}

function beforeDeadline<T>(operation: () => Promise<T>, deadline: number, description: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.reject(new Error(`Timed out while attempting to ${description}`));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Timed out while attempting to ${description}`));
    }, remaining);
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      clearTimeout(timer);
      settled = true;
      reject(error);
      return;
    }
    pending.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function publicDebugStartOperation(raw: unknown): {
  state?: 'starting' | 'accepted' | 'declined' | 'failed' | 'terminated' | 'unknown';
  message?: string;
} {
  if (!isRecord(raw)) return {};
  const state = raw.state === 'starting' || raw.state === 'accepted' ||
    raw.state === 'declined' || raw.state === 'failed' || raw.state === 'terminated' ||
    raw.state === 'unknown'
    ? raw.state
    : undefined;
  return {
    ...(state ? { state } : {}),
    ...(typeof raw.message === 'string'
      ? { message: boundedText(raw.message, MAX_ERROR_TEXT_CHARS) }
      : {}),
  };
}

async function selectSession(
  bridge: BridgeClient,
  requestedSessionId?: string,
  knownSessions?: BridgeSessionMetadata[],
): Promise<SelectedSession> {
  const sessions = knownSessions ?? await listSessions(bridge);
  if (sessions.length === 0) {
    throw new Error(
      'No active Vite debug session exists in this VS Code window. Call debug_start, then retry.',
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

async function waitForManagedPage(
  bridge: BridgeClient,
  browser: BrowserController,
  selected: SelectedSession,
  targetId: string,
  timeoutMs: number,
): Promise<{ selected: SelectedSession; page: PageDescription }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const rawStatus = await bridge.sessionRequest<unknown>(selected.sessionId, 'status', {});
    const status = isRecord(rawStatus) ? rawStatus : { value: rawStatus };
    const refreshed = { ...selected, status };
    if (managedTargetIds(status).has(targetId)) {
      try {
        return { selected: refreshed, page: await browser.selectPage(status, targetId) };
      } catch (error) {
        lastError = error;
      }
    }
    await delay(50);
  }
  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`The reopened Vite page did not become available to Playwright within ${timeoutMs}ms.${detail}`);
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
  return runBrowserOperation(bridge, selected, operation);
}

async function runBrowserOperation<T>(
  bridge: BridgeClient,
  selected: SelectedSession,
  operation: () => Promise<T>,
): Promise<UnknownRecord> {
  const pending = operation().then(
    (value) => ({ kind: 'completed' as const, value }),
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
            ...(settled.value === undefined ? {} : { result: settled.value }),
          };
        }
      } catch {
        // The browser action itself succeeded; a transient status refresh
        // failure must not turn that success into an action failure.
      }
      return {
        outcome: 'completed',
        ...(settled.value === undefined ? {} : { result: settled.value }),
      };
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

async function validateUploadFiles(
  workspace: string,
  inputs: readonly string[],
): Promise<UploadFileDescription[]> {
  const workspaceRoot = await fs.realpath(workspace);
  const files: UploadFileDescription[] = [];
  let totalBytes = 0;

  for (const input of inputs) {
    if (input.includes('\0')) throw new Error('Upload path contains a null byte');
    const candidate = path.resolve(workspace, input);
    if (!pathIsInside(workspaceRoot, candidate)) {
      throw new Error(`Upload path is outside the configured workspace: ${input}`);
    }
    const relativeCandidate = path.relative(workspaceRoot, candidate);
    let current = workspaceRoot;
    for (const segment of relativeCandidate.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const component = await fs.lstat(current);
      if (component.isSymbolicLink()) {
        throw new Error(`Upload path must not contain a symbolic link: ${input}`);
      }
    }
    const resolved = await fs.realpath(candidate);
    if (!pathIsInside(workspaceRoot, resolved)) {
      throw new Error(`Upload path is outside the configured workspace: ${input}`);
    }
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error(`Upload path is not a regular file: ${input}`);
    if (stat.size > MAX_UPLOAD_FILE_BYTES) {
      throw new Error(`Upload file exceeds the ${MAX_UPLOAD_FILE_BYTES}-byte per-file limit: ${input}`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
      throw new Error(`Upload files exceed the ${MAX_UPLOAD_TOTAL_BYTES}-byte total limit`);
    }
    files.push({
      path: resolved,
      relativePath: path.relative(workspaceRoot, resolved).replace(/\\/g, '/'),
      bytes: stat.size,
    });
  }
  return files;
}

function pathIsInside(parent: string, child: string): boolean {
  const normalize = (value: string) => process.platform === 'win32'
    ? path.resolve(value).toLocaleLowerCase('en-US')
    : path.resolve(value);
  const relative = path.relative(normalize(parent), normalize(child));
  return relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function prepareTraceDirectory(workspace: string): Promise<string> {
  const hash = crypto.createHash('sha256').update(await fs.realpath(workspace)).digest('hex').slice(0, 24);
  const parent = path.join(os.tmpdir(), 'vite-debugger-traces');
  const directory = path.join(parent, hash);
  await ensurePrivateTraceDirectory(parent);
  await ensurePrivateTraceDirectory(directory);
  return directory;
}

async function ensurePrivateTraceDirectory(directory: string): Promise<void> {
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Unsafe trace directory: ${directory}`);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error(`Trace directory is owned by another user: ${directory}`);
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (createError) {
      if (!isNodeError(createError) || createError.code !== 'EEXIST') throw createError;
    }
    const created = await fs.lstat(directory);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error(`Could not create a safe trace directory: ${directory}`);
    }
    if (typeof process.getuid === 'function' && created.uid !== process.getuid()) {
      throw new Error(`Trace directory is owned by another user: ${directory}`);
    }
  }
  await fs.chmod(directory, 0o700);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function isVanishedPlaywrightPageError(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value);
  return /no object with guid|target page, context or browser has been closed|page has been closed/i.test(message);
}

async function pruneTraceDirectory(directory: string, keepPath: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const traces = (await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.zip'))
    .map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      try {
        return { filePath, mtimeMs: (await fs.stat(filePath)).mtimeMs };
      } catch {
        return undefined;
      }
    })))
    .filter((trace): trace is { filePath: string; mtimeMs: number } => trace !== undefined)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
  await Promise.all(traces.map(async (trace, index) => {
    if (trace.filePath === keepPath || (index < 10 && trace.mtimeMs >= cutoff)) return;
    await fs.unlink(trace.filePath).catch(() => undefined);
  }));
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
  const base = browserPageUrl(status) || currentUrl;
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
      `Cross-origin navigation is disabled: ${destination.origin} does not match browser app origin ${allowed.origin}.`,
    );
  }
  return destination.href;
}

function browserPageUrl(status: UnknownRecord): string | undefined {
  return readString(status, ['pageUrl'], ['config', 'pageUrl'], ['browser', 'pageUrl']) ??
    readString(status, ['viteUrl'], ['config', 'viteUrl'], ['browser', 'viteUrl']);
}

function urlMatchesBrowserApp(pageUrl: string, appUrl: string): boolean {
  try {
    const page = new URL(pageUrl);
    const app = new URL(appUrl);
    return sameOrigin(page, app);
  } catch {
    return pageUrl === appUrl || pageUrl.startsWith(appUrl.endsWith('/') ? appUrl : `${appUrl}/`);
  }
}

function sameOrigin(left: URL, right: URL): boolean {
  return localOriginsEquivalent(left, right);
}

function urlsHaveSameOrigin(left: string, right: string): boolean {
  try {
    return sameOrigin(new URL(left), new URL(right));
  } catch {
    return false;
  }
}

function urlsReferToSamePage(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    const normalizedPath = (value: string) => value.replace(/\/+$/, '') || '/';
    return sameOrigin(leftUrl, rightUrl) &&
      normalizedPath(leftUrl.pathname) === normalizedPath(rightUrl.pathname);
  } catch {
    return left === right;
  }
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
  if (typeof result.pageUrl === 'string') result.pageUrl = sanitizeBrowserUrl(result.pageUrl);
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

function jsonErrorResult(value: unknown): CallToolResult {
  return { ...jsonResult(value), isError: true };
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
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof BridgeRpcError && isRecord(error.data)) {
    const available = Array.isArray(error.data.availableConfigurations)
      ? error.data.availableConfigurations
        .filter((value): value is string => typeof value === 'string')
        .slice(0, 50)
        .map((value) => boundedText(value.replace(/[\x00-\x1f\x7f]/g, ' '), 200))
      : [];
    if (available.length > 0) {
      return boundedText(
        `${message}. Available Vite configurations: ${available.join(', ')}`,
        MAX_ERROR_TEXT_CHARS,
      );
    }
  }
  return boundedText(message, MAX_ERROR_TEXT_CHARS);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
