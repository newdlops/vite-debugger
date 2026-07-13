import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  launchManagedDebugChrome,
  managedChromeUserDataDir,
} from '../../src/cdp/ChromeDiscovery';

describe('project-owned Chrome launch policy', () => {
  it('uses a stable opaque profile per project and port policy', () => {
    const captain = path.join(os.tmpdir(), 'captain-secret-workspace');
    const other = path.join(os.tmpdir(), 'other-project');

    const first = managedChromeUserDataDir(captain);
    expect(managedChromeUserDataDir(captain)).toBe(first);
    expect(managedChromeUserDataDir(other)).not.toBe(first);
    expect(managedChromeUserDataDir(captain, 9222)).not.toBe(first);
    expect(first).not.toContain('captain-secret-workspace');
  });

  it('reuses only the DevTools port recorded by the same project-owned profile', async () => {
    const fixture = http.createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      const address = fixture.address();
      if (!address || typeof address === 'string') throw new Error('fixture is not listening');
      if (request.url === '/json/version') {
        response.end(JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/owned`,
        }));
        return;
      }
      response.end(JSON.stringify([{
        id: 'owned-page',
        title: 'Owned app',
        type: 'page',
        url: 'http://localhost:5173/',
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/owned-page',
      }]));
    });
    await new Promise<void>((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(0, '127.0.0.1', resolve);
    });

    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind a port');
    const scope = path.join(os.tmpdir(), `vite-debugger-owned-${crypto.randomUUID()}`);
    const profile = managedChromeUserDataDir(scope);
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(
      path.join(profile, 'DevToolsActivePort'),
      `${address.port}\n/devtools/browser/owned\n`,
      'utf8',
    );

    try {
      await expect(launchManagedDebugChrome(
        'http://localhost:5173/',
        undefined,
        scope,
        '/definitely/not/a/chrome-binary',
      )).resolves.toBe(address.port);
    } finally {
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });

  it('rejects a stale profile port now owned by a different browser id', async () => {
    const fixture = http.createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      const address = fixture.address();
      if (!address || typeof address === 'string') throw new Error('fixture is not listening');
      if (request.url === '/json/version') {
        response.end(JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/lighthouse`,
        }));
        return;
      }
      response.end(JSON.stringify([{
        id: 'lighthouse-page',
        title: 'Lighthouse',
        type: 'page',
        url: 'about:blank',
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/lighthouse-page',
      }]));
    });
    await new Promise<void>((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(0, '127.0.0.1', resolve);
    });

    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind a port');
    const scope = path.join(os.tmpdir(), `vite-debugger-stale-${crypto.randomUUID()}`);
    const profile = managedChromeUserDataDir(scope);
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(
      path.join(profile, 'DevToolsActivePort'),
      `${address.port}\n/devtools/browser/previous-owned-browser\n`,
      'utf8',
    );

    try {
      await expect(launchManagedDebugChrome(
        'http://localhost:5173/',
        undefined,
        scope,
        '/definitely/not/a/chrome-binary',
      )).rejects.toThrow('Could not launch isolated debug Chrome');
    } finally {
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
});
