import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import { ViteUrlMapper } from '../../src/vite/ViteUrlMapper';
import { normalizeViteUrl, SourceMapResolver } from '../../src/sourcemap/SourceMapResolver';
import { detectFirstViteServer } from '../../src/vite/ViteServerDetector';
import { isChromeDebuggable } from '../../src/cdp/ChromeDiscovery';
import { FixtureViteServer, startFixtureVite } from '../helpers/viteServer';
import { LaunchedChrome, launchTestChrome } from '../helpers/chrome';

describe('ViteUrlMapper (pure)', () => {
  const mapper = new ViteUrlMapper(
    'http://127.0.0.1:5173',
    '/Users/test/project',
    '/Users/test/project',
  );

  it('maps project file to Vite URL without /@fs prefix', () => {
    expect(mapper.filePathToViteUrl('/Users/test/project/src/App.tsx'))
      .toBe('http://127.0.0.1:5173/src/App.tsx');
  });

  it('maps out-of-root file through /@fs', () => {
    expect(mapper.filePathToViteUrl('/opt/shared/lib/utils.ts'))
      .toBe('http://127.0.0.1:5173/@fs/opt/shared/lib/utils.ts');
  });

  it('reverses /@fs URLs back to absolute paths', () => {
    expect(mapper.viteUrlToFilePath('http://127.0.0.1:5173/@fs/opt/shared/lib/utils.ts'))
      .toBe('/opt/shared/lib/utils.ts');
  });

  it('returns null for Vite internal URLs', () => {
    expect(mapper.viteUrlToFilePath('http://127.0.0.1:5173/@vite/client')).toBeNull();
    expect(mapper.viteUrlToFilePath('http://127.0.0.1:5173/@react-refresh')).toBeNull();
  });

  it('flags internal URLs via isViteInternalUrl', () => {
    expect(mapper.isViteInternalUrl('http://127.0.0.1:5173/@vite/client')).toBe(true);
    expect(mapper.isViteInternalUrl('http://127.0.0.1:5173/src/App.tsx')).toBe(false);
  });
});

describe('ViteUrlMapper (monorepo: webRoot != viteRoot)', () => {
  // Workspace root above the Vite sub-package — mirrors a pnpm/yarn workspace
  // layout where vite.config lives in apps/web while the editor opened the
  // outer repo.
  const mapper = new ViteUrlMapper(
    'http://127.0.0.1:5173',
    '/Users/test/workspace',
    '/Users/test/workspace/apps/web',
  );

  it('maps a sub-package source to a Vite-relative URL (no /apps/web prefix)', () => {
    // Bug fix: previously this used webRoot, producing /apps/web/src/App.tsx
    // which Vite returns 404 on — Vite serves files relative to viteRoot.
    expect(mapper.filePathToViteUrl('/Users/test/workspace/apps/web/src/App.tsx'))
      .toBe('http://127.0.0.1:5173/src/App.tsx');
  });

  it('maps a workspace-sibling file (outside viteRoot) through /@fs', () => {
    expect(mapper.filePathToViteUrl('/Users/test/workspace/packages/shared/util.ts'))
      .toBe('http://127.0.0.1:5173/@fs/Users/test/workspace/packages/shared/util.ts');
  });
});

describe('normalizeViteUrl', () => {
  it('strips ?v=<hash> versioning', () => {
    expect(normalizeViteUrl('http://127.0.0.1:5173/src/App.tsx?v=abc123'))
      .toBe('http://127.0.0.1:5173/src/App.tsx');
  });
  it('strips ?t=<ts> HMR timestamps', () => {
    expect(normalizeViteUrl('http://127.0.0.1:5173/src/App.tsx?t=1700000000'))
      .toBe('http://127.0.0.1:5173/src/App.tsx');
  });
  it('passes through data URIs untouched', () => {
    expect(normalizeViteUrl('data:application/json;base64,abc'))
      .toBe('data:application/json;base64,abc');
  });
  it('is a no-op for URLs without a query string', () => {
    expect(normalizeViteUrl('http://127.0.0.1:5173/src/App.tsx'))
      .toBe('http://127.0.0.1:5173/src/App.tsx');
  });
});

describe('Vite-backed module integration', () => {
  let vite: FixtureViteServer;

  // One Vite boot for all integration tests in this file — keeps the slow
  // dep pre-bundling to a single cost and avoids close() races between specs.
  beforeAll(async () => {
    vite = await startFixtureVite();
  }, 180_000);

  afterAll(async () => {
    if (vite) {
      await Promise.race([
        vite.close(),
        new Promise((r) => setTimeout(r, 10_000)),
      ]);
    }
  }, 20_000);

  it('detectFirstViteServer finds the running fixture server', async () => {
    const found = await detectFirstViteServer(vite.url);
    expect(found).not.toBeNull();
    // Vite may report either 127.0.0.1 or localhost — match on port, not host.
    const expectedPort = new URL(vite.url).port;
    const actualPort = new URL(found!.url).port;
    expect(actualPort).toBe(expectedPort);
  });

  it('detectFirstViteServer derives the project root from the entry source map', async () => {
    const found = await detectFirstViteServer(vite.url);
    expect(found?.root).toBe(vite.root);
  });

  it('SourceMapResolver loads an inline source map and maps to src/App.tsx', async () => {
    const resolver = new SourceMapResolver(vite.root, vite.root);
    const scriptUrl = `${vite.url}/src/App.tsx`;

    // Fetch the transformed module and verify it advertises an inline source map.
    const res = await fetch(scriptUrl);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/\/\/# sourceMappingURL=data:application\/json;base64,/);

    // Register it with the resolver (simulating CDP's scriptParsed).
    const sourceMapUrl = body.match(/\/\/# sourceMappingURL=(data:[^\s]+)/)![1];
    await resolver.registerScript('script-1', scriptUrl, sourceMapUrl);

    // The original source file path should be discovered through the source map.
    const sources = resolver.getSourcesForScript('script-1');
    const appTsx = path.join(vite.root, 'src', 'App.tsx');
    expect(sources).toContain(appTsx);
  });
});

describe('ChromeDiscovery (integration)', () => {
  let chrome: LaunchedChrome | undefined;

  beforeAll(async () => {
    chrome = await launchTestChrome({ startingUrl: 'about:blank' });
  }, 60_000);

  afterAll(async () => {
    await chrome?.kill();
  });

  it('confirms the launched port is CDP-debuggable', async () => {
    const ok = await isChromeDebuggable(chrome!.port);
    expect(ok).toBe(true);
  });

  it('returns false for a clearly closed port', async () => {
    const ok = await isChromeDebuggable(1);
    expect(ok).toBe(false);
  });
});
