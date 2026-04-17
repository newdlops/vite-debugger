import * as path from 'path';
import type { ViteDevServer } from 'vite';

export interface FixtureViteServer {
  url: string;
  port: number;
  root: string;
  close(): Promise<void>;
}

/**
 * Boots the fixture Vite dev server programmatically on a random port.
 * Uses the workspace-level `vite` dep so no per-fixture install is needed.
 */
export async function startFixtureVite(port = 0): Promise<FixtureViteServer> {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;

  const root = path.resolve(__dirname, '..', 'fixtures', 'sample-app');
  const server: ViteDevServer = await createServer({
    root,
    configFile: false,
    plugins: [react()],
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port,
      strictPort: false,
    },
  });

  await server.listen();
  const resolvedPort = server.config.server.port ?? 0;
  // Use 127.0.0.1 explicitly (not Vite's default "localhost" URL). Chrome
  // normalizes tab URLs for some hosts, and the adapter filters tabs by URL
  // host — so picking one canonical form avoids a localhost/127.0.0.1
  // mismatch between the adapter's detected URL and the Chrome tab URL.
  const url = `http://127.0.0.1:${resolvedPort}`;

  return {
    url,
    port: resolvedPort,
    root,
    close: async () => {
      await server.close();
    },
  };
}
