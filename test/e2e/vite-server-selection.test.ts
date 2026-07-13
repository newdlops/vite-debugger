import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as dns from 'dns';
import { describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({ exec: vi.fn() }));

vi.mock('child_process', () => ({ exec: childProcess.exec }));

import {
  detectFirstViteServer,
  detectViteServers,
  selectViteServerForWebRoot,
  ViteServerInfo,
  verifiedLoopbackHostname,
  viteRootMatchesWebRoot,
} from '../../src/vite/ViteServerDetector';

function server(url: string, root?: string): ViteServerInfo {
  return { url, root };
}

async function startHttpsViteFixture(root: string): Promise<{
  fixture: https.Server;
  port: number;
}> {
  const key = fs.readFileSync(path.join(process.cwd(), 'test/fixtures/tls/localhost.key.pem'));
  const cert = fs.readFileSync(path.join(process.cwd(), 'test/fixtures/tls/localhost.cert.pem'));
  const sourceMap = Buffer.from(JSON.stringify({
    version: 3,
    file: `${root}/src/main.ts`,
    sources: [`${root}/src/main.ts`],
    names: [],
    mappings: '',
  })).toString('base64');
  const fixture = https.createServer({ key, cert }, (request, response) => {
    if (request.url === '/@vite/client') {
      response.setHeader('content-type', 'application/javascript');
      response.end('const vite = true;');
      return;
    }
    if (request.url === '/src/main.ts') {
      response.end(`export const secure = true;\n//# sourceMappingURL=data:application/json;base64,${sourceMap}`);
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<script type="module" src="/src/main.ts"></script>');
  });

  await new Promise<void>((resolve, reject) => {
    fixture.once('error', reject);
    fixture.listen(0, resolve);
  });
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('HTTPS fixture did not bind a TCP port');
  return { fixture, port: address.port };
}

function closeServer(server: http.Server | https.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startHttpViteFixture(options: {
  entryPath?: string;
  moduleBody: string;
  rootStatus?: number;
  indexHtml?: string;
}): Promise<{ fixture: http.Server; url: string }> {
  const entryPath = options.entryPath ?? '/src/index.tsx';
  const fixture = http.createServer((request, response) => {
    if (request.url === '/@vite/client') {
      response.setHeader('content-type', 'application/javascript');
      response.end('const vite = true;');
      return;
    }
    if (request.url === entryPath) {
      response.setHeader('content-type', 'application/javascript');
      response.end(options.moduleBody);
      return;
    }
    if (request.url === '/') {
      response.statusCode = options.rootStatus ?? 200;
      response.setHeader('content-type', 'text/html');
      response.end(options.rootStatus === 404
        ? 'Not found'
        : `<script type="module" src="${entryPath}"></script>`);
      return;
    }
    if (request.url === '/index.html') {
      response.setHeader('content-type', 'text/html');
      response.end(options.indexHtml ?? `<script type="module" src="${entryPath}"></script>`);
      return;
    }
    response.statusCode = 404;
    response.end('Not found');
  });

  await new Promise<void>((resolve, reject) => {
    fixture.once('error', reject);
    fixture.listen(0, '127.0.0.1', resolve);
  });
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind a TCP port');
  return { fixture, url: `http://127.0.0.1:${address.port}` };
}

describe('root-scoped Vite server selection', () => {
  it('accepts the Vite project root itself', () => {
    expect(viteRootMatchesWebRoot('/work/captain/zuzu/client', '/work/captain/zuzu/client'))
      .toBe(true);
  });

  it('accepts one Vite package nested below an outer monorepo webRoot', () => {
    const selected = selectViteServerForWebRoot([
      server('http://127.0.0.1:3004', '/work/captain/zuzu/client'),
      server('http://127.0.0.1:5173', '/work/another-project'),
    ], '/work/captain');

    expect(selected?.url).toBe('http://127.0.0.1:3004');
  });

  it('does not treat a similarly prefixed sibling as nested', () => {
    expect(viteRootMatchesWebRoot('/work/captain-old/client', '/work/captain'))
      .toBe(false);
  });

  it('rejects a Vite parent when webRoot points at an unrelated nested directory', () => {
    expect(viteRootMatchesWebRoot('/work/captain', '/work/captain/zuzu/client'))
      .toBe(false);
  });

  it('rejects nonmatching and root-unknown candidates instead of taking the first endpoint', () => {
    const selected = selectViteServerForWebRoot([
      server('http://127.0.0.1:3004', '/work/another-project'),
      server('http://127.0.0.1:5173'),
    ], '/work/captain');

    expect(selected).toBeNull();
  });

  it('rejects multiple matching Vite packages as ambiguous', () => {
    const selected = selectViteServerForWebRoot([
      server('http://127.0.0.1:3004', '/work/captain/apps/admin'),
      server('http://127.0.0.1:5173', '/work/captain/apps/storefront'),
    ], '/work/captain');

    expect(selected).toBeNull();
  });

  it('uses /index.html when / is 404 and derives roots from safe source map paths without file', async () => {
    const root = '/work/captain/zuzu/client';
    const sourceMaps = [
      {
        version: 3,
        sources: [`${root}/src/index.tsx`],
        names: [],
        mappings: '',
      },
      {
        version: 3,
        sourceRoot: `${root}/src`,
        sources: ['index.tsx'],
        names: [],
        mappings: '',
      },
    ];

    for (const sourceMap of sourceMaps) {
      const encoded = Buffer.from(JSON.stringify(sourceMap)).toString('base64');
      const fixture = await startHttpViteFixture({
        rootStatus: 404,
        moduleBody: `export const app = true;\n//# sourceMappingURL=data:application/json;base64,${encoded}`,
      });
      try {
        const found = await detectFirstViteServer(fixture.url, '/work/captain', true);
        expect(found?.url).toBe(fixture.url);
        expect(found?.pageUrl).toBe(`${fixture.url}/index.html`);
        expect(found?.root).toBe(root);
      } finally {
        await closeServer(fixture.fixture);
      }
    }
  });

  it('falls back to an absolute SWC fileName and only enforces explicit URL scope when requested', async () => {
    const root = '/work/captain/zuzu/client';
    const fixture = await startHttpViteFixture({
      moduleBody:
        `const element = jsxDEV(App, {}, undefined, false, ` +
        `{ fileName: "${root}/src/index.tsx", lineNumber: 1 }, this);`,
    });

    try {
      const linkedCheckout = await detectFirstViteServer(fixture.url, '/work/other');
      expect(linkedCheckout?.root).toBe(root);
      expect(linkedCheckout?.pageUrl).toBe(`${fixture.url}/`);

      const strictMismatch = await detectFirstViteServer(fixture.url, '/work/other', true);
      expect(strictMismatch).toBeNull();
    } finally {
      await closeServer(fixture.fixture);
    }
  });

  it('does not open a raw backend template as the Vite application page', async () => {
    const root = '/work/captain/zuzu/client';
    const fixture = await startHttpViteFixture({
      rootStatus: 404,
      indexHtml: '<!doctype html><html><body><div id="root"></div><%= htmlWebpackPlugin.options.title %></body></html>',
      moduleBody:
        `const element = jsxDEV(App, {}, undefined, false, ` +
        `{ fileName: "${root}/src/index.tsx", lineNumber: 1 }, this);`,
    });

    try {
      const found = await detectFirstViteServer(fixture.url, '/work/captain', true);
      expect(found?.root).toBe(root);
      expect(found?.pageUrl).toBeUndefined();
    } finally {
      await closeServer(fixture.fixture);
    }
  });

  it('uses a browser HTML Accept header so Vite transforms SPA fallback pages', async () => {
    const root = '/work/captain/zuzu/client';
    const htmlAccepts: string[] = [];
    const fixture = http.createServer((request, response) => {
      if (request.url === '/@vite/client') {
        response.setHeader('content-type', 'application/javascript');
        response.end('const vite = true;');
        return;
      }
      if (request.url === '/src/index.tsx') {
        response.end(
          `const app = { fileName: "${root}/src/index.tsx" };`,
        );
        return;
      }
      const accept = String(request.headers.accept ?? '');
      htmlAccepts.push(accept);
      if (accept.includes('text/html')) {
        response.setHeader('content-type', 'text/html');
        response.end(
          '<script type="module" src="/@vite/client"></script>' +
          '<script type="module" src="/src/index.tsx"></script>',
        );
        return;
      }
      if (request.url === '/index.html') {
        response.setHeader('content-type', 'text/html');
        response.end('<!doctype html><div id="root"></div>');
        return;
      }
      response.statusCode = 404;
      response.end('Not found');
    });
    await new Promise<void>((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(0, '127.0.0.1', resolve);
    });
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind a TCP port');

    try {
      const found = await detectFirstViteServer(
        `http://127.0.0.1:${address.port}`,
        '/work/captain',
        true,
      );
      expect(found?.root).toBe(root);
      expect(found?.pageUrl).toBe(`http://127.0.0.1:${address.port}/`);
      expect(htmlAccepts).toContain('text/html,application/xhtml+xml');
    } finally {
      await closeServer(fixture);
    }
  });

  it('ignores a relative source-map file and continues to an absolute SWC fileName', async () => {
    const root = '/work/captain/zuzu/client';
    const sourceMap = Buffer.from(JSON.stringify({
      version: 3,
      file: 'index.tsx',
      sources: ['index.tsx'],
      names: [],
      mappings: '',
    })).toString('base64');
    const fixture = await startHttpViteFixture({
      moduleBody:
        `const element = jsxDEV(App, {}, undefined, false, ` +
        `{ fileName: "${root}/src/index.tsx", lineNumber: 1 }, this);\n` +
        `//# sourceMappingURL=data:application/json;base64,${sourceMap}`,
    });

    try {
      const found = await detectFirstViteServer(fixture.url, '/work/captain', true);
      expect(found?.root).toBe(root);
    } finally {
      await closeServer(fixture.fixture);
    }
  });

  it('revalidates and pins strict explicit-host metadata requests against DNS rebinding', async () => {
    const root = '/work/captain/zuzu/client';
    const requests: string[] = [];
    const sourceMap = Buffer.from(JSON.stringify({
      version: 3,
      file: `${root}/src/index.tsx`,
      sources: [`${root}/src/index.tsx`],
      names: [],
      mappings: '',
    })).toString('base64');
    const fixture = http.createServer((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/@vite/client') {
        response.setHeader('content-type', 'application/javascript');
        response.end('const vite = true;');
        return;
      }
      if (request.url === '/src/index.tsx') {
        response.end(`export const app = true;\n//# sourceMappingURL=data:application/json;base64,${sourceMap}`);
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end('<script type="module" src="/src/index.tsx"></script>');
    });
    await new Promise<void>((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(0, '127.0.0.1', resolve);
    });
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind a TCP port');

    let lookupCount = 0;
    const lookup = vi.spyOn(dns.promises, 'lookup').mockImplementation(async () => {
      lookupCount += 1;
      return lookupCount === 1
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '192.0.2.10', family: 4 }];
    });
    try {
      const found = await detectFirstViteServer(
        `http://strict-vite.test:${address.port}`,
        '/work/captain',
        true,
      );
      expect(found).toBeNull();
      expect(requests).toEqual(['/@vite/client']);
    } finally {
      lookup.mockRestore();
      await closeServer(fixture);
    }
  });

  it('uses a reachable explicit URL but fails closed when that URL is down even if another Vite is discoverable', async () => {
    const sourceMap = Buffer.from(JSON.stringify({
      version: 3,
      file: '/work/linked-checkout/src/main.ts',
      sources: ['/work/linked-checkout/src/main.ts'],
      names: [],
      mappings: '',
    })).toString('base64');
    const fixture = http.createServer((request, response) => {
      if (request.url === '/@vite/client') {
        response.setHeader('content-type', 'application/javascript');
        response.end('const vite = true;');
        return;
      }
      if (request.url === '/src/main.ts') {
        response.end(`export const app = true;\n//# sourceMappingURL=data:application/json;base64,${sourceMap}`);
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end('<script type="module" src="/src/main.ts"></script>');
    });

    await new Promise<void>((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = fixture.address();
      if (!address || typeof address === 'string') throw new Error('Fixture did not bind a TCP port');
      const fixtureUrl = `http://127.0.0.1:${address.port}`;
      const found = await detectFirstViteServer(
        `${fixtureUrl}/some/path`,
        '/work/captain',
      );

      expect(found?.url).toBe(fixtureUrl);
      expect(found?.root).toBe('/work/linked-checkout');

      // Make a fallback scan deterministic: if it ran, it would discover the
      // other, reachable Vite fixture above.
      childProcess.exec.mockImplementation((
        _command: string,
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, `127.0.0.1:${address.port}\n`, '');
      });

      const closed = http.createServer();
      await new Promise<void>((resolve, reject) => {
        closed.once('error', reject);
        closed.listen(0, '127.0.0.1', resolve);
      });
      const closedAddress = closed.address();
      if (!closedAddress || typeof closedAddress === 'string') {
        throw new Error('Closed-port fixture did not bind a TCP port');
      }
      await new Promise<void>((resolve) => closed.close(() => resolve()));

      childProcess.exec.mockClear();
      const unavailablePreferred = await detectViteServers(
        `http://127.0.0.1:${closedAddress.port}`,
      );
      expect(unavailablePreferred).toEqual([]);
      expect(childProcess.exec).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  });

  it('detects a self-signed HTTPS Vite server only after verifying and pinning loopback DNS', async () => {
    const key = fs.readFileSync(path.join(process.cwd(), 'test/fixtures/tls/localhost.key.pem'));
    const cert = fs.readFileSync(path.join(process.cwd(), 'test/fixtures/tls/localhost.cert.pem'));
    const sourceMap = Buffer.from(JSON.stringify({
      version: 3,
      file: '/work/secure-client/src/main.ts',
      sources: ['/work/secure-client/src/main.ts'],
      names: [],
      mappings: '',
    })).toString('base64');
    const fixture = https.createServer({ key, cert }, (request, response) => {
      if (request.url === '/@vite/client') {
        response.setHeader('content-type', 'application/javascript');
        response.end('const vite = true;');
        return;
      }
      if (request.url === '/src/main.ts') {
        response.end(`export const secure = true;\n//# sourceMappingURL=data:application/json;base64,${sourceMap}`);
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end('<script type="module" src="/src/main.ts"></script>');
    });

    await new Promise<void>((resolve, reject) => {
      fixture.once('error', reject);
      // An unspecified bind accepts whichever loopback family Node chooses for
      // localhost on the test machine.
      fixture.listen(0, resolve);
    });

    try {
      const address = fixture.address();
      if (!address || typeof address === 'string') throw new Error('HTTPS fixture did not bind a TCP port');
      const url = `https://localhost:${address.port}`;

      const found = await detectFirstViteServer(url, '/work/secure-client');
      expect(found?.url).toBe(url);
      expect(found?.root).toBe('/work/secure-client');
      expect(found?.localTlsCertificateBypass).toBe(true);

      // A trust failure alone is insufficient. If DNS contains even one
      // non-loopback address, the certificate bypass must be refused.
      const lookup = vi.spyOn(dns.promises, 'lookup').mockImplementation(async () => ([
        { address: '127.0.0.1', family: 4 },
        { address: '192.0.2.10', family: 4 },
      ]));
      try {
        expect(await detectViteServers(url)).toEqual([]);
      } finally {
        lookup.mockRestore();
      }
    } finally {
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  });

  it('auto-detects HTTPS through a forward-verified loopback alias and still enforces root scope', async () => {
    const captain = await startHttpsViteFixture('/work/captain/zuzu/client');
    const other = await startHttpsViteFixture('/work/other/client');
    const lookupService = vi.spyOn(dns.promises, 'lookupService').mockImplementation(
      async () => ({ hostname: 'localhost', service: 'https' }),
    );
    const lookup = vi.spyOn(dns.promises, 'lookup').mockImplementation(async () => ([
      { address: '127.0.0.1', family: 4 },
    ]));
    childProcess.exec.mockImplementation((
      _command: string,
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, `127.0.0.1:${captain.port}\n127.0.0.1:${other.port}\n`, '');
    });

    try {
      expect(await verifiedLoopbackHostname('127.0.0.1', captain.port)).toBe('localhost');

      const selected = await detectFirstViteServer(undefined, '/work/captain');
      expect(selected?.url).toBe(`https://localhost:${captain.port}`);
      expect(selected?.root).toBe('/work/captain/zuzu/client');
      expect(selected?.localTlsCertificateBypass).toBe(true);

      // Hydrate the sibling explicitly before exercising the pure selection
      // policy. Re-running the entire machine endpoint scan here made this
      // assertion depend on two independent TLS fixture passes under full-suite
      // load, even though ambiguity itself is deterministic once roots exist.
      const otherSelected = await detectFirstViteServer(
        `https://localhost:${other.port}`,
        '/work/other',
        true,
      );
      expect(otherSelected?.root).toBe('/work/other/client');
      expect(selectViteServerForWebRoot([selected!, otherSelected!], '/work')).toBeNull();
    } finally {
      lookup.mockRestore();
      lookupService.mockRestore();
      await Promise.all([closeServer(captain.fixture), closeServer(other.fixture)]);
    }
  });

  it('rejects a lookupService alias unless forward DNS includes the exact endpoint and only loopback', async () => {
    const lookupService = vi.spyOn(dns.promises, 'lookupService').mockImplementation(
      async () => ({ hostname: 'alphac', service: 'https' }),
    );
    const lookup = vi.spyOn(dns.promises, 'lookup').mockImplementation(async () => ([
      { address: '127.0.0.2', family: 4 },
      { address: '192.0.2.10', family: 4 },
    ]));
    try {
      expect(await verifiedLoopbackHostname('127.0.0.1', 3004)).toBeUndefined();
    } finally {
      lookup.mockRestore();
      lookupService.mockRestore();
    }
  });
});
