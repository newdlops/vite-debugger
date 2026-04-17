import { DebugProtocol } from '@vscode/debugprotocol';
import { DAPClient } from './dapClient';
import { FixtureViteServer, startFixtureVite } from './viteServer';
import { LaunchedChrome, launchTestChrome } from './chrome';
import { BrowserSession, connectTestBrowser } from './browser';

export interface E2ESession {
  vite: FixtureViteServer;
  chrome: LaunchedChrome;
  browser: BrowserSession;
  dap: DAPClient;
  webRoot: string;
  /** Full teardown in reverse order. Safe to call multiple times. */
  dispose(): Promise<void>;
}

export interface StartOptions {
  /** Reserved for future variants — currently tests always drive navigation after attach. */
  skipNavigate?: boolean;
}

/**
 * Spin up the full stack for an adapter-level E2E:
 *   1. Vite dev server serving the fixture app
 *   2. Headless Chrome with --remote-debugging-port
 *   3. DAPClient wrapping ViteDebugSession
 *   4. Test-side CDP connection for page interaction
 *
 * Tests then call `dap.request('initialize' | 'launch' | ...)` to drive the
 * adapter. Teardown disposes everything in reverse order.
 */
/**
 * Full bring-up sequence that most breakpoint-oriented tests want:
 *  start session → initialize → launch → configurationDone → navigate.
 * After this returns the fixture page is loaded, the adapter is attached,
 * and setBreakpoints calls will resolve against real scriptParsed events.
 */
export async function startAttachedSession(): Promise<E2ESession> {
  const session = await startE2ESession();
  await session.dap.request<
    DebugProtocol.InitializeRequest,
    DebugProtocol.InitializeResponse
  >('initialize', {
    adapterID: 'vite',
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: 'path',
  });
  const initialized = session.dap.waitForEvent('initialized', 30_000);
  await session.dap.request<
    DebugProtocol.LaunchRequest,
    DebugProtocol.LaunchResponse
  >('launch', {
    viteUrl: session.vite.url,
    chromePort: session.chrome.port,
    webRoot: session.webRoot,
  });
  await initialized;
  await session.dap.request('configurationDone', {});
  await session.browser.navigate(session.vite.url);
  // Let Vite dep-optimize + React hydrate + scriptParsed fan-out settle so
  // subsequent setBreakpoints resolves against live scripts.
  await new Promise((r) => setTimeout(r, 1500));
  return session;
}

export async function startE2ESession(options: StartOptions = {}): Promise<E2ESession> {
  const vite = await startFixtureVite();
  let chrome: LaunchedChrome | null = null;
  let browser: BrowserSession | null = null;
  let dap: DAPClient | null = null;

  try {
    // Always open Chrome at about:blank — tests drive navigation explicitly
    // after the adapter attaches so scriptParsed events fire with the
    // adapter's listeners registered. Attaching to an already-loaded page
    // risks losing pre-attach scriptParsed events and leaving breakpoints
    // permanently pending.
    chrome = await launchTestChrome({ startingUrl: 'about:blank' });
    browser = await connectTestBrowser(chrome.port);
    dap = new DAPClient();

    const webRoot = vite.root;

    const session: E2ESession = {
      vite,
      chrome,
      browser,
      dap,
      webRoot,
      dispose: async () => {
        await session.dap.dispose().catch(() => undefined);
        await session.browser.close().catch(() => undefined);
        await session.chrome.kill().catch(() => undefined);
        await session.vite.close().catch(() => undefined);
      },
    };
    return session;
  } catch (err) {
    // Best-effort cleanup on setup failure
    if (dap) await dap.dispose().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    if (chrome) await chrome.kill().catch(() => undefined);
    await vite.close().catch(() => undefined);
    throw err;
  }
}
