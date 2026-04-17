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
  const { launch } = require('chrome-launcher') as typeof import('chrome-launcher');

  const port = opts.port ?? (await getFreePort());

  const instance = await launch({
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
    // chrome-launcher pool waits for the debug port to be reachable.
    connectionPollInterval: 100,
    maxConnectionRetries: 50,
  });

  return {
    port: instance.port,
    kill: async () => {
      await instance.kill();
    },
  };
}
