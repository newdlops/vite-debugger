import * as net from 'net';

export interface LaunchedChrome {
  port: number;
  kill(): Promise<void>;
}

/** Pick an OS-assigned free TCP port. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (typeof address === 'object' && address) {
        const { port } = address;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Could not read assigned port')));
      }
    });
  });
}

/**
 * Launch a headless Chrome with a fresh profile and remote debugging port.
 * Uses `chrome-launcher` which handles Chrome discovery and cleanup.
 *
 * The fresh user-data-dir is created in a tmp path managed by chrome-launcher
 * and is removed on kill().
 */
export async function launchTestChrome(
  opts: { port?: number; startingUrl?: string } = {},
): Promise<LaunchedChrome> {
  // chrome-launcher is ESM-dynamic in some versions; require works for CJS build
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Launcher } = require('chrome-launcher') as typeof import('chrome-launcher');

  const port = opts.port ?? (await getFreePort());

  const instance = new Launcher({
    port,
    startingUrl: opts.startingUrl ?? 'about:blank',
    chromeFlags: [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--mute-audio',
      '--hide-scrollbars',
    ],
    handleSIGINT: false,
    // Cold Chrome startup can exceed five seconds on shared CI runners.
    // This only extends readiness polling; test failures are never retried.
    connectionPollInterval: 100,
    maxConnectionRetries: 300,
    logLevel: 'error',
  });

  try {
    await instance.launch();
  } catch (error) {
    // launch() can reject after spawning Chrome. Keep the instance so failed
    // setup releases its process and temporary profile as well.
    instance.kill();
    throw error;
  }

  return {
    port: instance.port!,
    kill: async () => {
      await instance.kill();
    },
  };
}
