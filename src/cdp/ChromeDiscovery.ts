import * as http from 'http';
import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { logger } from '../util/Logger';
import { isPortOpen } from '../util/PortScanner';
import { isLoopbackHost, localOriginsEquivalent } from '../util/LocalHosts';

const DEBUG_CHROME_START_TIMEOUT_MS = 15_000;
const DEVTOOLS_ACTIVE_PORT_FILE = 'DevToolsActivePort';

export interface ChromeTarget {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl: string;
}

export interface ChromeProcessInfo {
  pid: number;
  debugPort: number | null;
  userDataDir: string | null;
  execPath: string | null;
}

function httpGetJson<T>(url: string, timeout: number = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Failed to parse JSON from ${url}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function execAsync(cmd: string, timeout: number = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.exec(cmd, { timeout }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

export async function listChromeTargets(port: number): Promise<ChromeTarget[]> {
  try {
    const targets = await httpGetJson<ChromeTarget[]>(`http://127.0.0.1:${port}/json/list`);
    return targets.filter(t => t.type === 'page');
  } catch (e) {
    logger.debug(`No Chrome debug endpoint on port ${port}: ${e}`);
    return [];
  }
}

export async function findViteTab(chromePort: number, viteUrl: string): Promise<ChromeTarget | null> {
  const targets = await listChromeTargets(chromePort);
  const expected = new URL(viteUrl);
  const target = targets.find(t => {
    try {
      return localOriginsEquivalent(new URL(t.url), expected);
    } catch { return false; }
  });

  return target ?? null;
}

// ---------- Chrome process detection ----------

/**
 * Detect running Chrome/Chromium processes and extract their info.
 */
export async function detectChromeProcesses(): Promise<ChromeProcessInfo[]> {
  const platform = os.platform();

  if (platform === 'darwin') {
    return detectChromeProcessesMac();
  } else if (platform === 'linux') {
    return detectChromeProcessesLinux();
  } else if (platform === 'win32') {
    return detectChromeProcessesWin();
  }
  return [];
}

async function detectChromeProcessesMac(): Promise<ChromeProcessInfo[]> {
  try {
    // Get main Chrome browser process (type=normal is the browser process, not renderers)
    const stdout = await execAsync(
      `ps -eo pid,command 2>/dev/null | grep -i '[C]hrome' | grep -v 'helper' | grep -v 'framework'`
    );
    return parseChromeProcessLines(stdout);
  } catch {
    return [];
  }
}

async function detectChromeProcessesLinux(): Promise<ChromeProcessInfo[]> {
  try {
    const stdout = await execAsync(
      `ps -eo pid,args 2>/dev/null | grep -i '[c]hrome\\|[c]hromium' | grep -v 'helper'`
    );
    return parseChromeProcessLines(stdout);
  } catch {
    return [];
  }
}

async function detectChromeProcessesWin(): Promise<ChromeProcessInfo[]> {
  try {
    const stdout = await execAsync(
      `wmic process where "name like '%chrome%'" get processid,commandline /format:csv 2>NUL`
    );
    return parseChromeProcessLines(stdout);
  } catch {
    return [];
  }
}

function parseChromeProcessLines(stdout: string): ChromeProcessInfo[] {
  const results: ChromeProcessInfo[] = [];
  const seen = new Set<number>();

  for (const line of stdout.split('\n').filter(Boolean)) {
    const pidMatch = line.match(/^\s*(\d+)/);
    if (!pidMatch) continue;
    const pid = parseInt(pidMatch[1], 10);
    if (seen.has(pid)) continue;
    seen.add(pid);

    const portMatch = line.match(/--remote-debugging-port=(\d+)/);
    const dirMatch = line.match(/--user-data-dir=([^\s]+)/);

    // Extract exec path (first token that looks like a path to chrome)
    const execMatch = line.match(/(\/\S*[Cc]hrom\S*)/);

    results.push({
      pid,
      debugPort: portMatch ? parseInt(portMatch[1], 10) : null,
      userDataDir: dirMatch ? dirMatch[1] : null,
      execPath: execMatch ? execMatch[1] : null,
    });
  }

  return results;
}

/**
 * Find an existing Chrome with a debug port already active.
 * Returns the port number if found.
 */
export async function findExistingChromeDebugPort(): Promise<number | null> {
  const processes = await detectChromeProcesses();

  // Probe every candidate port in parallel (was sequential, adding up to 3s
  // of HTTP timeouts per failed port before we got to the answer).
  const candidatePorts = new Set<number>([9222, 9223, 9224, 9225]);
  for (const proc of processes) {
    if (proc.debugPort) candidatePorts.add(proc.debugPort);
  }

  const results = await Promise.all(
    [...candidatePorts].map(async (port) => {
      const targets = await listChromeTargets(port);
      return targets.length > 0 ? port : null;
    })
  );
  const found = results.find((p): p is number => p !== null);
  if (found !== undefined) {
    logger.info(`Found Chrome debug port ${found}`);
    return found;
  }

  return null;
}

/**
 * Check if Chrome is running (with or without debug port).
 */
export async function isChromeRunning(): Promise<boolean> {
  const processes = await detectChromeProcesses();
  return processes.length > 0;
}

// ---------- Debug-enabled Chrome ----------

/**
 * Get the debug-specific user data directory.
 *
 * Chrome REQUIRES a non-default --user-data-dir when using --remote-debugging-port.
 * We use a dedicated "Chrome-Debug" directory that's separate from the normal profile.
 * This means the debug Chrome is a separate instance — the user's normal Chrome
 * stays untouched and can keep running.
 */
function getDebugUserDataDir(): string {
  const platform = os.platform();
  const home = os.homedir();

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome-Debug');
  } else if (platform === 'linux') {
    return path.join(home, '.config', 'google-chrome-debug');
  } else if (platform === 'win32') {
    return path.join(process.env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local'),
      'Google', 'Chrome-Debug');
  }
  return path.join(home, '.config', 'google-chrome-debug');
}

/** Stable per-project profile path without exposing the workspace path itself. */
export function managedChromeUserDataDir(
  profileScope: string,
  requestedPort?: number,
): string {
  let canonicalScope: string;
  try {
    canonicalScope = fs.realpathSync.native(path.resolve(profileScope));
  } catch {
    canonicalScope = path.resolve(profileScope);
  }
  if (process.platform === 'win32') canonicalScope = canonicalScope.toLowerCase();
  const profileId = crypto.createHash('sha256')
    .update(canonicalScope)
    .update('\0')
    .update(requestedPort === undefined ? 'leased' : `fixed:${requestedPort}`)
    .digest('hex')
    .slice(0, 32);
  return path.join(os.tmpdir(), 'vite-debugger-chrome-profiles', profileId);
}

function prepareManagedDebugUserDataDir(profileScope: string, requestedPort?: number): string {
  const directory = managedChromeUserDataDir(profileScope, requestedPort);
  const parent = path.dirname(directory);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertPrivateManagedDirectory(parent);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivateManagedDirectory(directory);
  return directory;
}

function assertPrivateManagedDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Unsafe managed Chrome profile directory');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Managed Chrome profile directory is owned by another user');
  }
  try {
    fs.chmodSync(directory, 0o700);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    // chmod is best-effort on Windows. The directory name contains only a
    // one-way project hash, never the workspace path or MCP operation id.
  }
}

interface DevToolsActiveEndpoint {
  port: number;
  browserPath: string;
}

function readDevToolsActiveEndpoint(userDataDir: string): DevToolsActiveEndpoint | undefined {
  try {
    const lines = fs.readFileSync(
      path.join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILE),
      'utf8',
    ).split(/\r?\n/);
    const port = Number(lines[0]);
    const browserPath = lines[1];
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    if (!/^\/devtools\/browser\/[A-Za-z0-9._-]+$/.test(browserPath ?? '')) return undefined;
    return { port, browserPath };
  } catch {
    return undefined;
  }
}

async function isOwnedChromeEndpoint(endpoint: DevToolsActiveEndpoint): Promise<boolean> {
  try {
    const version = await httpGetJson<{ webSocketDebuggerUrl?: unknown }>(
      `http://127.0.0.1:${endpoint.port}/json/version`,
    );
    if (typeof version.webSocketDebuggerUrl !== 'string') return false;
    const websocket = new URL(version.webSocketDebuggerUrl);
    const websocketPort = Number(websocket.port || (websocket.protocol === 'wss:' ? 443 : 80));
    return (websocket.protocol === 'ws:' || websocket.protocol === 'wss:') &&
      isLoopbackHost(websocket.hostname) &&
      websocketPort === endpoint.port &&
      websocket.pathname === endpoint.browserPath;
  } catch {
    return false;
  }
}

/**
 * Start a Chrome instance owned by one launch session.
 *
 * Each canonical project scope receives a stable hashed profile, preserving
 * local login and certificate trust across debug starts without collapsing
 * different projects into Chrome's single global profile. When no port was
 * explicitly requested, `--remote-debugging-port=0` lets Chrome/OS lease a
 * collision-free port and publishes it through DevToolsActivePort. A later
 * start for the same project reuses only that owned port, never a machine-wide
 * Lighthouse/headless endpoint.
 */
export async function launchManagedDebugChrome(
  url: string,
  requestedPort?: number,
  profileScope: string = process.cwd(),
  chromePath?: string,
): Promise<number> {
  if (requestedPort !== undefined && (
    !Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535
  )) {
    throw new Error('Chrome remote-debugging port must be an integer between 1 and 65535');
  }

  const userDataDir = prepareManagedDebugUserDataDir(profileScope, requestedPort);
  if (requestedPort === undefined) {
    const ownedEndpoint = readDevToolsActiveEndpoint(userDataDir);
    if (ownedEndpoint && await isOwnedChromeEndpoint(ownedEndpoint)) {
      logger.info(`Reusing project-owned debug Chrome on port ${ownedEndpoint.port}`);
      return ownedEndpoint.port;
    }
    // Do not delete a stale-looking file here: another VS Code window for the
    // same project may have just launched this profile and not exposed
    // /json/version yet. Chrome overwrites DevToolsActivePort on a fresh start,
    // and the readiness loop re-reads and verifies both port and browser id.
  }

  const execPath = chromePath ?? findChromePath();
  if (!execPath) {
    throw new Error('Chrome not found. Please install Chrome or specify the path.');
  }

  const portArgument = requestedPort ?? 0;
  const args = [
    `--remote-debugging-port=${portArgument}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ];

  logger.info(`Launching project-owned debug Chrome with remote-debugging port ${portArgument || 'leased'}`);

  const proc = childProcess.spawn(execPath, args, {
    detached: true,
    stdio: 'ignore',
  });
  let spawnError: Error | undefined;
  proc.once('error', (error) => { spawnError = error; });
  proc.unref();

  const deadline = Date.now() + DEBUG_CHROME_START_TIMEOUT_MS;
  let activePort = requestedPort;
  let delay = 100;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(`Could not launch isolated debug Chrome: ${spawnError.message}`);
    }
    if (requestedPort === undefined) {
      const endpoint = readDevToolsActiveEndpoint(userDataDir);
      activePort = endpoint?.port;
      if (endpoint && await isOwnedChromeEndpoint(endpoint)) {
        logger.info(`Project-owned debug Chrome ready on leased port ${endpoint.port}`);
        return endpoint.port;
      }
    } else if (activePort !== undefined) {
      const targets = await listChromeTargets(activePort);
      if (targets.length > 0) {
        logger.info(`Isolated debug Chrome ready on port ${activePort}, ${targets.length} tab(s)`);
        return activePort;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 1000);
  }

  try {
    if (!proc.killed) proc.kill();
  } catch {
    // The detached launcher may already have exited. Preserve the actionable
    // readiness timeout below instead of replacing it with ESRCH/EPERM.
  }
  const detail = activePort === undefined
    ? 'Chrome did not publish a leased DevTools port'
    : `Chrome did not expose a page target on port ${activePort}`;
  throw new Error(`${detail} within ${DEBUG_CHROME_START_TIMEOUT_MS / 1000}s`);
}

/**
 * Launch a debug-enabled Chrome instance.
 *
 * Key insight: Chrome refuses --remote-debugging-port with the default profile dir.
 * So we run a SEPARATE Chrome instance with its own "Chrome-Debug" profile.
 * The user's normal Chrome keeps running — no quit, no restart, no disruption.
 * The debug Chrome opens the Vite URL directly.
 */
export async function launchDebugChrome(
  url: string,
  port: number = 9222,
  chromePath?: string,
): Promise<void> {
  const execPath = chromePath ?? findChromePath();
  if (!execPath) {
    throw new Error('Chrome not found. Please install Chrome or specify the path.');
  }

  const userDataDir = getDebugUserDataDir();
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ];

  logger.info(`Launching debug Chrome: ${execPath} ${args.join(' ')}`);

  const proc = childProcess.spawn(execPath, args, {
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();

  // Wait for debug port to be ready. Exponential backoff up to ~15s total —
  // catches fast starts (~300ms on warm disk) without burning CPU on long
  // polls, and fails faster than the old fixed 500ms × 40 probe.
  const deadline = Date.now() + DEBUG_CHROME_START_TIMEOUT_MS;
  let delay = 100;
  while (Date.now() < deadline) {
    try {
      const targets = await listChromeTargets(port);
      if (targets.length > 0) {
        logger.info(`Debug Chrome ready on port ${port}, ${targets.length} tab(s)`);
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 2, 1000);
  }

  throw new Error(`Debug Chrome did not start on port ${port} within 15s`);
}

/**
 * @deprecated Use launchDebugChrome instead.
 * Kept for compatibility — restarts normal Chrome with debug port.
 * This doesn't work reliably because Chrome rejects --remote-debugging-port
 * with the default profile directory.
 */
export async function restartChromeWithDebugPort(
  port: number = 9222,
  chromePath?: string,
): Promise<void> {
  // Delegate to the working approach: launch a separate debug Chrome
  return launchDebugChrome('about:blank', port, chromePath);
}

// ---------- Fresh Chrome launch ----------

function findChromePath(): string | null {
  const platform = os.platform();

  if (platform === 'darwin') {
    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    return paths.find(p => fs.existsSync(p)) ?? null;
  }

  if (platform === 'linux') {
    const paths = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ];
    return paths.find(p => fs.existsSync(p)) ?? null;
  }

  if (platform === 'win32') {
    const prefixes = [
      process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
      process.env['PROGRAMFILES'] ?? 'C:\\Program Files',
      process.env['LOCALAPPDATA'] ?? '',
    ];
    for (const prefix of prefixes) {
      const chromePath = path.join(prefix, 'Google', 'Chrome', 'Application', 'chrome.exe');
      if (fs.existsSync(chromePath)) return chromePath;
    }
    return null;
  }

  return null;
}

export async function launchChrome(
  url: string,
  port: number = 9222,
  chromePath?: string,
): Promise<childProcess.ChildProcess> {
  const execPath = chromePath ?? findChromePath();
  if (!execPath) {
    throw new Error('Chrome not found. Please install Chrome or specify the path.');
  }

  const userDataDir = path.join(os.tmpdir(), `vite-debugger-chrome-${port}`);
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ];

  logger.info(`Launching fresh Chrome: ${execPath} ${args.join(' ')}`);

  const proc = childProcess.spawn(execPath, args, {
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    if (await isPortOpen(port)) {
      logger.info(`Chrome debug port ${port} is ready`);
      return proc;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  throw new Error(`Chrome debug port ${port} did not open within 15 seconds`);
}

export async function isChromeDebuggable(port: number): Promise<boolean> {
  try {
    const targets = await listChromeTargets(port);
    return targets.length > 0;
  } catch {
    return false;
  }
}
