import * as http from 'http';
import * as childProcess from 'child_process';
import * as os from 'os';
import { logger } from '../util/Logger';

export interface ViteServerInfo {
  url: string;
  version?: string;
  root?: string;  // Absolute path of the Vite project root (e.g., /Users/.../zuzu/client)
}

function httpGet(url: string, timeout: number = 3000): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * Find all TCP ports that node processes are listening on,
 * by querying the OS directly. Works on macOS, Linux, and Windows.
 */
function getNodeListeningPorts(): Promise<number[]> {
  return new Promise((resolve) => {
    const platform = os.platform();
    let cmd: string;

    if (platform === 'darwin') {
      // macOS: lsof is the most reliable
      cmd = `lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null | awk '/node|vite|tsx|ts-node|esbuild|bun|deno/{print $9}'`;
    } else if (platform === 'linux') {
      // Linux: ss is faster and more widely available than lsof
      cmd = `ss -tlnp 2>/dev/null | awk '/node|vite/{match($4, /:([0-9]+)$/, a); print a[1]}'`;
    } else if (platform === 'win32') {
      // Windows: netstat + tasklist combo
      cmd = `powershell -Command "Get-NetTCPConnection -State Listen | Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -match 'node|vite' } | Select-Object -ExpandProperty LocalPort"`;
    } else {
      resolve([]);
      return;
    }

    childProcess.exec(cmd, { timeout: 5000 }, (error, stdout) => {
      if (error) {
        logger.debug(`Port discovery command failed: ${error.message}`);
        resolve([]);
        return;
      }

      const ports = new Set<number>();
      const lines = stdout.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        // Extract port number — handle formats like "*:3004", "127.0.0.1:5173", "3004"
        const match = line.match(/:(\d+)$/) || line.match(/^(\d+)$/);
        if (match) {
          const port = parseInt(match[1], 10);
          if (port > 0 && port <= 65535) {
            ports.add(port);
          }
        }
      }

      resolve([...ports].sort((a, b) => a - b));
    });
  });
}

async function probeViteHost(baseUrl: string): Promise<ViteServerInfo | null> {
  try {
    // Primary check: /@vite/client endpoint — unique to Vite
    const clientRes = await httpGet(`${baseUrl}/@vite/client`);
    if (clientRes.status === 200) {
      const contentType = clientRes.headers['content-type'] ?? '';
      const isJs = contentType.includes('javascript') || contentType.includes('text/plain');
      const bodyHasVite = clientRes.body.includes('vite') ||
                          clientRes.body.includes('@vite') ||
                          clientRes.body.includes('__vite');

      if (isJs || bodyHasVite) {
        logger.info(`Vite server detected at ${baseUrl} via /@vite/client`);
        const versionMatch = clientRes.body.match(/vite\/dist\/client|vite\/([\d.]+)/i);
        return { url: baseUrl, version: versionMatch?.[1] };
      }
    }
  } catch { /* try fallback */ }

  try {
    // Fallback: check if the HTML page includes vite client script
    const htmlRes = await httpGet(baseUrl);
    if (htmlRes.status === 200 && htmlRes.body.includes('/@vite/client')) {
      logger.info(`Vite server detected at ${baseUrl} via HTML content`);
      return { url: baseUrl };
    }
  } catch { /* not a vite server on this host */ }

  return null;
}

async function isViteServer(port: number): Promise<ViteServerInfo | null> {
  // Probe both hostnames in parallel — `localhost` and `127.0.0.1` resolve to
  // the same socket on most setups, so one request should succeed fast.
  const probes = ['localhost', '127.0.0.1'].map(h => probeViteHost(`http://${h}:${port}`));
  const results = await Promise.all(probes);
  return results.find(r => r !== null) ?? null;
}

export async function detectViteServers(preferredUrl?: string): Promise<ViteServerInfo[]> {
  // If a preferred URL is given, check it first
  if (preferredUrl) {
    try {
      const url = new URL(preferredUrl);
      const port = parseInt(url.port) || 80;
      const result = await isViteServer(port);
      if (result) return [result];
    } catch {
      logger.warn(`Invalid preferred URL: ${preferredUrl}`);
    }
  }

  // Discover ports from running node processes (covers ALL ports)
  const ports = await getNodeListeningPorts();
  logger.debug(`Node listening ports: ${ports.join(', ') || '(none)'}`);

  if (ports.length === 0) {
    logger.info('No node processes listening on any port');
    return [];
  }

  // Check each port for Vite in parallel
  const servers: ViteServerInfo[] = [];
  const results = await Promise.all(ports.map(port => isViteServer(port)));
  for (const result of results) {
    if (result) servers.push(result);
  }

  logger.info(`Detected ${servers.length} Vite server(s)`);
  return servers;
}

export async function detectFirstViteServer(preferredUrl?: string): Promise<ViteServerInfo | null> {
  const servers = await detectViteServers(preferredUrl);
  if (servers.length === 0) return null;

  const server = servers[0];
  server.root = await queryViteRoot(server.url);
  return server;
}

/**
 * Query the Vite dev server to discover the project root on disk.
 *
 * Strategy:
 *   1. Fetch the HTML page to find the entry module (e.g., /src/index.tsx)
 *   2. Fetch that module — Vite inlines a base64 source map at the end
 *   3. The source map's `file` field contains the absolute path of the original file
 *   4. Subtract the URL path from the absolute path to derive the root
 *
 * Example:
 *   entry URL path = /src/index.tsx
 *   sourcemap file = /Users/lky/project/captain/zuzu/client/src/index.tsx
 *   → root = /Users/lky/project/captain/zuzu/client
 */
async function queryViteRoot(viteUrl: string): Promise<string | undefined> {
  try {
    // Step 1: Find the entry module URL path
    const entryPath = await findEntryModulePath(viteUrl);
    if (!entryPath) {
      return undefined;
    }

    // Step 2: Derive root from the entry module's source map
    return await deriveRootFromModule(viteUrl, entryPath);
  } catch (e) {
    logger.debug(`Failed to query Vite root: ${e}`);
    return undefined;
  }
}

/**
 * Find the entry module URL path from the Vite HTML page.
 * Handles multiple patterns:
 *   - <script type="module" src="/src/index.tsx">
 *   - <script src="/src/main.tsx" type="module">
 *   - <script type="module">import "/src/main.tsx"</script>
 * Falls back to common entry point paths if HTML parsing fails.
 */
async function findEntryModulePath(viteUrl: string): Promise<string | undefined> {
  try {
    const htmlRes = await httpGet(viteUrl);
    const html = htmlRes.body;

    // Pattern 1: <script ... src="..." ... type="module" ...> (any attribute order)
    const scriptTags = html.matchAll(/<script\s[^>]*>/gi);
    for (const tag of scriptTags) {
      const tagStr = tag[0];
      if (/type=["']module["']/i.test(tagStr)) {
        const srcMatch = tagStr.match(/src=["']([^"']+)["']/);
        if (srcMatch && srcMatch[1].startsWith('/src/')) {
          logger.debug(`Vite entry point (src attr): ${srcMatch[1]}`);
          return srcMatch[1];
        }
      }
    }

    // Pattern 2: inline <script type="module">import "/src/..." or import('/src/...')
    const inlineModules = html.matchAll(/<script\s[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi);
    for (const m of inlineModules) {
      const body = m[1];
      const importMatch = body.match(/import\s+["']([^"']+)["']/) ||
                          body.match(/import\(["']([^"']+)["']\)/);
      if (importMatch && importMatch[1].startsWith('/src/')) {
        logger.debug(`Vite entry point (inline import): ${importMatch[1]}`);
        return importMatch[1];
      }
    }

    logger.debug('Could not find module entry point in HTML, trying common paths');
  } catch (e) {
    logger.debug(`Failed to fetch HTML: ${e}`);
  }

  // Fallback: try common Vite entry points in parallel (was sequential with
  // 2s timeout each — could wait up to 12s when the entry wasn't any of them).
  const commonEntries = ['/src/main.tsx', '/src/main.ts', '/src/index.tsx', '/src/index.ts', '/src/main.jsx', '/src/main.js'];
  const results = await Promise.all(commonEntries.map(async (entry) => {
    try {
      const res = await httpGet(`${viteUrl}${entry}`, 1500);
      if (res.status === 200 && res.body.length > 0) return entry;
    } catch { /* not this one */ }
    return null;
  }));
  const hit = results.find(r => r !== null);
  if (hit) {
    logger.debug(`Vite entry point (fallback probe): ${hit}`);
    return hit;
  }

  logger.debug('Could not find any Vite entry module');
  return undefined;
}

/**
 * Fetch a module from the Vite server and extract the project root
 * from its source map's `file` field.
 */
async function deriveRootFromModule(viteUrl: string, entryPath: string): Promise<string | undefined> {
  const moduleRes = await httpGet(`${viteUrl}${entryPath}`);

  // Extract inline source map
  const smMatch = moduleRes.body.match(/\/\/# sourceMappingURL=data:[^;]+;base64,(.+)$/m);
  if (!smMatch) {
    logger.debug('No inline source map found in entry module');
    return undefined;
  }

  const smJson = JSON.parse(Buffer.from(smMatch[1], 'base64').toString('utf-8'));
  const file: string | undefined = smJson.file;
  if (!file) {
    logger.debug('Source map has no "file" field');
    return undefined;
  }

  logger.debug(`Entry source map file: ${file}`);

  // Derive root: entryPath="/src/index.tsx", file="/Users/.../zuzu/client/src/index.tsx"
  // → root = "/Users/.../zuzu/client"
  if (file.endsWith(entryPath)) {
    const root = file.slice(0, -entryPath.length);
    logger.info(`Vite project root: ${root}`);
    return root;
  }

  // Fuzzy match: find longest common suffix between URL path and file path
  const entryParts = entryPath.split('/');
  const fileParts = file.split('/');
  let commonSuffix = 0;
  while (
    commonSuffix < entryParts.length &&
    commonSuffix < fileParts.length &&
    entryParts[entryParts.length - 1 - commonSuffix] === fileParts[fileParts.length - 1 - commonSuffix]
  ) {
    commonSuffix++;
  }
  if (commonSuffix > 0) {
    const root = fileParts.slice(0, fileParts.length - commonSuffix).join('/');
    logger.info(`Vite project root (suffix match): ${root}`);
    return root;
  }

  logger.debug(`Could not derive root: entry=${entryPath}, file=${file}`);
  return undefined;
}
