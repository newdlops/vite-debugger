import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugProtocol } from '@vscode/debugprotocol';

const detector = vi.hoisted(() => ({
  detectFirst: vi.fn(),
}));
const chrome = vi.hoisted(() => ({
  findViteTab: vi.fn(),
  isChromeDebuggable: vi.fn(),
  findExistingChromeDebugPort: vi.fn(),
  launchDebugChrome: vi.fn(),
  launchManagedDebugChrome: vi.fn(),
}));

vi.mock('../../src/vite/ViteServerDetector', () => ({
  detectFirstViteServer: detector.detectFirst,
  formatViteServerInfo: vi.fn(),
}));
vi.mock('../../src/cdp/ChromeDiscovery', () => chrome);

import { ViteDebugSession } from '../../src/adapter/ViteDebugSession';

interface SessionRequests {
  launchRequest(response: DebugProtocol.LaunchResponse, args: DebugProtocol.LaunchRequestArguments): Promise<void>;
  attachRequest(response: DebugProtocol.AttachResponse, args: DebugProtocol.AttachRequestArguments): Promise<void>;
  sendErrorResponse: ReturnType<typeof vi.fn>;
}

interface StatusSession {
  viteServer: {
    url: string;
    pageUrl?: string;
    localTlsCertificateBypass?: boolean;
  } | null;
  buildMcpStatus(): Record<string, unknown>;
}

interface ChromeSession {
  viteServer: { url: string; pageUrl?: string } | null;
  cdp: {
    isConnected: boolean;
    listTargets: ReturnType<typeof vi.fn>;
    createTarget: ReturnType<typeof vi.fn>;
  } | null;
  ensureChromeDebugPort(chromePort: number): Promise<number>;
  ensureLaunchChromeDebugPort(
    requestedPort: number | undefined,
    profileScope: string,
  ): Promise<number>;
  ensureManagedViteTarget(chromePort: number): Promise<{ targetId: string; created: boolean }>;
}

interface LaunchPortSession extends SessionRequests {
  ensureLaunchChromeDebugPort: ReturnType<typeof vi.fn>;
}

interface PageConfigurationSession extends StatusSession {
  applyConfiguredPageUrl(pageUrl: string | undefined): void;
}

function response(command: 'launch' | 'attach'): DebugProtocol.Response {
  return {
    seq: 1,
    type: 'response',
    request_seq: 1,
    command,
    success: true,
  };
}

function sessionRequests(): SessionRequests {
  const session = new ViteDebugSession() as unknown as SessionRequests;
  session.sendErrorResponse = vi.fn();
  return session;
}

describe('ViteDebugSession root-scoped detection wiring', () => {
  beforeEach(() => {
    detector.detectFirst.mockReset();
    detector.detectFirst.mockResolvedValue(null);
    chrome.findViteTab.mockReset();
    chrome.findViteTab.mockResolvedValue(null);
    chrome.isChromeDebuggable.mockReset();
    chrome.isChromeDebuggable.mockResolvedValue(false);
    chrome.findExistingChromeDebugPort.mockReset();
    chrome.findExistingChromeDebugPort.mockResolvedValue(null);
    chrome.launchDebugChrome.mockReset();
    chrome.launchDebugChrome.mockResolvedValue(undefined);
    chrome.launchManagedDebugChrome.mockReset();
    chrome.launchManagedDebugChrome.mockResolvedValue(43123);
  });

  it('passes launch webRoot into automatic Vite detection', async () => {
    const session = sessionRequests();
    await session.launchRequest(
      response('launch') as DebugProtocol.LaunchResponse,
      { webRoot: '/work/captain' },
    );

    expect(detector.detectFirst).toHaveBeenCalledWith(undefined, '/work/captain', false);
    expect(session.sendErrorResponse).toHaveBeenCalledWith(
      expect.anything(),
      1001,
      expect.stringContaining('set viteUrl explicitly'),
    );
  });

  it('passes attach webRoot alongside an explicit viteUrl', async () => {
    const session = sessionRequests();
    await session.attachRequest(
      response('attach') as DebugProtocol.AttachResponse,
      {
        webRoot: '/work/captain/zuzu/client',
        viteUrl: 'http://localhost:3004/',
        _viteDebuggerMcpRequireWorkspaceMatch: true,
      },
    );

    expect(detector.detectFirst).toHaveBeenCalledWith(
      'http://localhost:3004/',
      '/work/captain/zuzu/client',
      true,
    );
  });

  it('strictly scopes an MCP-generated launch viteUrl to its outer workspace webRoot', async () => {
    const session = sessionRequests();
    await session.launchRequest(
      response('launch') as DebugProtocol.LaunchResponse,
      {
        webRoot: '/work/captain',
        viteUrl: 'https://alphac:3004/',
        _viteDebuggerMcpStartId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        _viteDebuggerMcpRequireWorkspaceMatch: true,
      } as never,
    );

    expect(detector.detectFirst).toHaveBeenCalledWith(
      'https://alphac:3004/',
      '/work/captain',
      true,
    );
  });

  it('opens and recovers the HTML pageUrl while leaving the Vite module origin separate', async () => {
    const pageUrl = 'https://alphac:3004/index.html';
    const session = new ViteDebugSession() as unknown as ChromeSession;
    session.viteServer = { url: 'https://alphac:3004', pageUrl };

    expect(await session.ensureChromeDebugPort(9222)).toBe(9222);
    expect(chrome.launchDebugChrome).toHaveBeenCalledWith(pageUrl, 9222);

    const target = { targetId: 'page-1', type: 'page' };
    const createTarget = vi.fn().mockResolvedValue('page-1');
    session.cdp = {
      isConnected: true,
      listTargets: vi.fn()
        .mockReturnValueOnce([])
        .mockReturnValue([target]),
      createTarget,
    };

    await expect(session.ensureManagedViteTarget(9222)).resolves.toEqual({
      targetId: 'page-1',
      created: true,
    });
    expect(chrome.findViteTab).toHaveBeenCalledWith(9222, pageUrl);
    expect(createTarget).toHaveBeenCalledWith(pageUrl);
  });

  it('never discovers an arbitrary machine-wide Chrome port for launch', async () => {
    const pageUrl = 'http://localhost:5173/';
    const session = new ViteDebugSession() as unknown as ChromeSession;
    session.viteServer = { url: pageUrl, pageUrl };
    chrome.findExistingChromeDebugPort.mockResolvedValue(45678); // e.g. transient Lighthouse

    await expect(
      session.ensureLaunchChromeDebugPort(undefined, '/work/captain'),
    ).resolves.toBe(43123);

    expect(chrome.findExistingChromeDebugPort).not.toHaveBeenCalled();
    expect(chrome.launchDebugChrome).not.toHaveBeenCalled();
    expect(chrome.launchManagedDebugChrome).toHaveBeenCalledWith(
      pageUrl,
      undefined,
      '/work/captain',
    );
  });

  it('reuses only an explicitly requested reachable port for launch', async () => {
    const pageUrl = 'http://localhost:5173/';
    const session = new ViteDebugSession() as unknown as ChromeSession;
    session.viteServer = { url: pageUrl, pageUrl };
    chrome.isChromeDebuggable.mockResolvedValue(true);

    await expect(
      session.ensureLaunchChromeDebugPort(9333, '/work/captain'),
    ).resolves.toBe(9333);

    expect(chrome.isChromeDebuggable).toHaveBeenCalledWith(9333);
    expect(chrome.findExistingChromeDebugPort).not.toHaveBeenCalled();
    expect(chrome.launchManagedDebugChrome).not.toHaveBeenCalled();
  });

  it('launches an isolated profile on an unavailable explicit port without discovery', async () => {
    const pageUrl = 'http://localhost:5173/';
    const session = new ViteDebugSession() as unknown as ChromeSession;
    session.viteServer = { url: pageUrl, pageUrl };
    chrome.findExistingChromeDebugPort.mockResolvedValue(45678);
    chrome.launchManagedDebugChrome.mockResolvedValue(9333);

    await expect(
      session.ensureLaunchChromeDebugPort(9333, '/work/captain'),
    ).resolves.toBe(9333);

    expect(chrome.findExistingChromeDebugPort).not.toHaveBeenCalled();
    expect(chrome.launchManagedDebugChrome).toHaveBeenCalledWith(
      pageUrl,
      9333,
      '/work/captain',
    );
  });

  it('does not treat an MCP schema-default chromePort as an intentional shared port', async () => {
    detector.detectFirst.mockResolvedValue({ url: 'http://localhost:5173/' });
    const session = sessionRequests() as LaunchPortSession;
    session.ensureLaunchChromeDebugPort = vi.fn().mockRejectedValue(new Error('selection captured'));

    await session.launchRequest(
      response('launch') as DebugProtocol.LaunchResponse,
      {
        webRoot: '/work/captain',
        chromePort: 9222,
        _viteDebuggerMcpStartId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        _viteDebuggerMcpChromePortExplicit: false,
      } as never,
    );

    expect(session.ensureLaunchChromeDebugPort).toHaveBeenCalledWith(undefined, '/work/captain');
    expect(chrome.findExistingChromeDebugPort).not.toHaveBeenCalled();
  });

  it('overrides the inferred Vite page with an explicit backend-rendered app URL', () => {
    const session = new ViteDebugSession() as unknown as PageConfigurationSession;
    session.viteServer = {
      url: 'https://alphac:3004',
      pageUrl: 'https://alphac:3004/',
    };

    session.applyConfiguredPageUrl('http://127.0.0.1:8004/accounts/login');

    expect(session.viteServer).toEqual({
      url: 'https://alphac:3004',
      pageUrl: 'http://127.0.0.1:8004/accounts/login',
    });
  });

  it('exposes the loopback TLS bypass and an actionable Chrome trust warning to MCP', () => {
    const session = new ViteDebugSession() as unknown as StatusSession;
    session.viteServer = {
      url: 'https://alphac:3004/',
      pageUrl: 'https://alphac:3004/index.html',
      localTlsCertificateBypass: true,
    };

    const status = session.buildMcpStatus();
    expect(status.viteUrl).toBe('https://alphac:3004/');
    expect(status.pageUrl).toBe('https://alphac:3004/index.html');
    expect(status.localTlsCertificateBypass).toBe(true);
    expect(status.tlsCertificateWarning).toEqual(expect.stringContaining('project-owned debug Chrome profile'));
    expect(status.tlsCertificateWarning).toEqual(expect.stringContaining('install its local CA'));

    session.viteServer = { url: 'https://trusted.example.test:3004/' };
    const trustedStatus = session.buildMcpStatus();
    expect(trustedStatus.localTlsCertificateBypass).toBe(false);
    expect(trustedStatus.tlsCertificateWarning).toBeNull();
  });
});
