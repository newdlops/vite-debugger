import * as path from 'path';
import type { ViteDevServer } from 'vite';

export interface FixtureViteServer {
  url: string;
  port: number;
  root: string;
  close(): Promise<void>;
}

export interface FixtureViteOptions {
  base?: string;
  compact?: boolean;
  swc?: boolean;
}

/**
 * Boots the fixture Vite dev server programmatically on a random port.
 * Uses the workspace-level `vite` dep so no per-fixture install is needed.
 */
export async function startFixtureVite(port = 0, options: FixtureViteOptions = {}): Promise<FixtureViteServer> {
  const { createServer } = await import('vite');
  const react = options.swc
    ? (await import('@vitejs/plugin-react-swc')).default
    : (await import('@vitejs/plugin-react')).default;
  const { transform } = await import('esbuild');
  const { SourceMapConsumer, SourceMapGenerator } = await import('source-map');

  const root = path.resolve(__dirname, '..', 'fixtures', 'sample-app');
  const server: ViteDevServer = await createServer({
    root,
    configFile: false,
    base: options.base,
    plugins: [react(), ...(options.compact ? [{
      name: 'compact-fixture-source',
      configureServer(server: ViteDevServer) {
        // Compact after import analysis, which rewrites imports without
        // maintaining columns for plugins that already emitted a single line.
        server.middlewares.use(async (request, response, next) => {
          const url = request.url ?? '';
          if (!url.startsWith('/src/') || !/\.[jt]sx?(?:\?|$)/.test(url)) return next();
          try {
            const transformed = await server.transformRequest(url);
            if (!transformed?.map) return next();
            const intermediateSource = '/transformed' + url.split('?')[0];
            const compact = await transform(transformed.code, {
              minifyWhitespace: true,
              sourcemap: 'external',
              sourcefile: intermediateSource,
            });
            const compactMap = await new SourceMapConsumer(compact.map);
            const originalMap = await new SourceMapConsumer(JSON.stringify(transformed.map));
            try {
              const map = SourceMapGenerator.fromSourceMap(compactMap);
              map.applySourceMap(originalMap, intermediateSource);
              response.setHeader('content-type', 'application/javascript');
              response.end(compact.code + '\n//# sourceMappingURL=data:application/json;base64,'
                + Buffer.from(map.toString()).toString('base64'));
            } finally {
              compactMap.destroy();
              originalMap.destroy();
            }
          } catch (error) {
            next(error as Error);
          }
        });
      },
    }] : [])],
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
  const url = `http://127.0.0.1:${resolvedPort}${(options.base ?? '/').replace(/\/$/, '')}`;

  return {
    url,
    port: resolvedPort,
    root,
    close: async () => {
      await server.close();
    },
  };
}
