import * as dns from 'dns';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceMapResolver } from '../../src/sourcemap/SourceMapResolver';

function rawMap(file: string, source: string): string {
  return JSON.stringify({
    version: 3,
    file,
    sources: [source],
    sourcesContent: ['export const secure = true;\n'],
    names: [],
    mappings: 'AAAA',
  });
}

describe('SourceMapResolver HTTPS loading', () => {
  let fixture: https.Server;
  let origin: string;
  let externalMapRequests = 0;
  let dependencyMapRequests = 0;
  let lastHostHeader: string | undefined;

  beforeAll(async () => {
    const key = fs.readFileSync(path.join(process.cwd(), 'test/fixtures/tls/localhost.key.pem'));
    const cert = fs.readFileSync(path.join(process.cwd(), 'test/fixtures/tls/localhost.cert.pem'));
    fixture = https.createServer({ key, cert }, (request, response) => {
      lastHostHeader = request.headers.host;
      if (request.url === '/src/external.ts.map') {
        externalMapRequests++;
        response.setHeader('content-type', 'application/json');
        response.end(rawMap('/work/secure/src/external.ts', 'external.ts'));
        return;
      }
      if (request.url === '/node_modules/.vite/deps/react.js.map') {
        dependencyMapRequests++;
        response.statusCode = 503;
        response.end('not ready');
        return;
      }
      response.statusCode = 404;
      response.end('not found');
    });

    await new Promise<void>((resolve, reject) => {
      fixture.once('error', reject);
      // Match the detector fixture: accept whichever loopback family Node
      // selects for localhost.
      fixture.listen(0, resolve);
    });
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('HTTPS fixture did not bind a port');
    origin = `https://localhost:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  });

  beforeEach(() => {
    externalMapRequests = 0;
    dependencyMapRequests = 0;
    lastHostHeader = undefined;
  });

  it('loads an inline map advertised by an HTTPS script without a network request', async () => {
    const resolver = new SourceMapResolver('/work/secure', '/work/secure');
    const encoded = Buffer.from(
      rawMap('/work/secure/src/inline.ts', 'inline.ts'),
    ).toString('base64');

    await resolver.registerScript(
      'inline-https',
      `${origin}/src/inline.ts`,
      `data:application/json;base64,${encoded}`,
    );

    expect(resolver.getSourcesForScript('inline-https'))
      .toContain('/work/secure/src/inline.ts');
    expect(externalMapRequests).toBe(0);
    expect(dependencyMapRequests).toBe(0);
  });

  it('loads an external map over self-signed local HTTPS using a pinned loopback retry', async () => {
    const resolver = new SourceMapResolver('/work/secure', '/work/secure');

    await resolver.registerScript(
      'external-https',
      `${origin}/src/external.ts`,
      'external.ts.map',
    );

    expect(resolver.getSourcesForScript('external-https'))
      .toContain('/work/secure/src/external.ts');
    expect(resolver.hasSourceMapFailed('external-https')).toBe(false);
    expect(externalMapRequests).toBe(1);
    expect(lastHostHeader).toBe(new URL(origin).host);
  });

  it('refuses the certificate bypass when DNS is not exclusively loopback', async () => {
    const lookup = vi.spyOn(dns.promises, 'lookup').mockImplementation(async () => ([
      { address: '127.0.0.1', family: 4 },
      { address: '192.0.2.10', family: 4 },
    ] as any));
    try {
      const resolver = new SourceMapResolver('/work/secure', '/work/secure');
      await resolver.registerScript(
        'mixed-dns',
        `${origin}/src/external.ts`,
        'external.ts.map',
      );

      expect(resolver.hasSourceMapFailed('mixed-dns')).toBe(true);
      // The self-signed handshake is rejected before an HTTP request reaches
      // the fixture, and no untrusted pinned retry is allowed.
      expect(externalMapRequests).toBe(0);
    } finally {
      lookup.mockRestore();
    }
  });

  it('does not retry a failing optimized-dependency map', async () => {
    const resolver = new SourceMapResolver('/work/secure', '/work/secure');
    // Warm the narrowly scoped local-TLS decision for this resolver so this
    // assertion counts only HTTP attempts, not the initial trusted handshake.
    await resolver.registerScript(
      'external-before-dependency',
      `${origin}/src/external.ts`,
      'external.ts.map',
    );

    await resolver.registerScript(
      'optimized-dependency',
      `${origin}/node_modules/.vite/deps/react.js`,
      'react.js.map',
    );

    expect(resolver.hasSourceMapFailed('optimized-dependency')).toBe(true);
    expect(dependencyMapRequests).toBe(1);

    expect(resolver.hasFailedScripts()).toBe(false);
    await resolver.retryFailed();
    expect(dependencyMapRequests).toBe(1);
  });
});
