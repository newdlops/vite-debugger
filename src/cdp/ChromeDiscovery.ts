import * as http from 'http';
import * as childProcess from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { logger } from '../util/Logger';
import { isPortOpen } from '../util/PortScanner';

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
  const vitePort = new URL(viteUrl).port;

  // Exact URL match
  let target = targets.find(t => t.url.startsWith(viteUrl));
  if (target) return target;

  // Host match
  const viteHost = new URL(viteUrl).host;
  target = targets.find(t => {
    try { return new URL(t.url).host === viteHost; } catch { return false; }
  });
  if (target) return target;

  // Localhost variations (localhost ↔ 127.0.0.1, same port)
  target = targets.find(t => {
    try {
      const tUrl = new URL(t.url);
      return (tUrl.hostname === 'localhost' || tUrl.hostname === '127.0.0.1') &&
             tUrl.port === vitePort;
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

  // First check processes that explicitly have --remote-debugging-port
  for (const proc of processes) {
    if (proc.debugPort) {
      const targets = await listChromeTargets(proc.debugPort);
      if (targets.length > 0) {
        logger.info(`Found Chrome (PID ${proc.pid}) with debug port ${proc.debugPort}`);
        return proc.debugPort;
      }
    }
  }

  // Also probe common ports in case we missed it from process args
  for (const port of [9222, 9223, 9224, 9225]) {
    const targets = await listChromeTargets(port);
    if (targets.length > 0) {
      logger.info(`Found Chrome debug port ${port} via probe`);
      return port;
    }
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

  // Wait for debug port to be ready
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await listChromeTargets(port);
      if (targets.length > 0) {
        logger.info(`Debug Chrome ready on port ${port}, ${targets.length} tab(s)`);
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }

  throw new Error(`Debug Chrome did not start on port ${port} within 20s`);
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
