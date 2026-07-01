import * as http from 'http';
import * as childProcess from 'child_process';
import * as dns from 'dns';
import * as net from 'net';
import * as os from 'os';
import { logger } from '../util/Logger';
import { isLoopbackHost, isWildcardHost, normalizeHost } from '../util/LocalHosts';

export interface ViteServerInfo {
  url: string;
  version?: string;
  dnsHostnames?: string[];
  root?: string;  // Absolute path of the Vite project root (e.g., /Users/.../zuzu/client)
}

interface ListeningEndpoint {
  host?: string;
  port: number;
}

const DNS_LOOKUP_TIMEOUT_MS = 500;

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

function formatDnsHostnames(server: ViteServerInfo): string | undefined {
  return server.dnsHostnames && server.dnsHostnames.length > 0
    ? server.dnsHostnames.join(', ')
    : undefined;
}

export function formatViteServerInfo(server: ViteServerInfo): string {
  const details: string[] = [];
  const dnsHostnames = formatDnsHostnames(server);
  if (dnsHostnames) details.push(`DNS: ${dnsHostnames}`);
  if (server.version) details.push(`Vite ${server.version}`);
  return `${server.url}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
}

export function formatViteServerDescription(server: ViteServerInfo): string | undefined {
  const details: string[] = [];
  const dnsHostnames = formatDnsHostnames(server);
  if (dnsHostnames) details.push(dnsHostnames);
  if (server.version) details.push(`Vite ${server.version}`);
  return details.length > 0 ? details.join(' | ') : undefined;
}

/**
 * Find TCP endpoints that node/Vite-like processes are listening on,
 * by querying the OS directly. Works on macOS, Linux, and Windows.
 */
function getNodeListeningEndpoints(): Promise<ListeningEndpoint[]> {
  return new Promise((resolve) => {
    const platform = os.platform();
    let cmd: string;

    if (platform === 'darwin') {
      // macOS: lsof is the most reliable
      cmd = `lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null | awk '/node|vite|tsx|ts-node|esbuild|bun|deno|portmanager/{print $9}'`;
    } else if (platform === 'linux') {
      // Linux: ss is faster and more widely available than lsof
      cmd = `ss -tlnp 2>/dev/null | awk '/node|vite|tsx|ts-node|esbuild|bun|deno|portmanager/{print $4}'`;
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

      const endpoints = new Map<string, ListeningEndpoint>();
      const lines = stdout.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        const endpoint = parseListeningEndpoint(line);
        if (!endpoint) continue;
        const hostKey = endpoint.host ? normalizeHost(endpoint.host) : '*';
        endpoints.set(`${hostKey}:${endpoint.port}`, endpoint);
      }

      resolve([...endpoints.values()].sort((a, b) => {
        if (a.port !== b.port) return a.port - b.port;
        return (a.host ?? '').localeCompare(b.host ?? '');
      }));
    });
  });
}

function parseListeningEndpoint(line: string): ListeningEndpoint | null {
  const raw = line.trim();
  const portOnly = raw.match(/^(\d+)$/);
  if (portOnly) return validEndpoint(undefined, portOnly[1]);

  const bracketed = raw.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketed) return validEndpoint(bracketed[1], bracketed[2]);

  const colon = raw.lastIndexOf(':');
  if (colon < 0) return null;

  const host = raw.slice(0, colon);
  const port = raw.slice(colon + 1);
  return validEndpoint(host, port);
}

function validEndpoint(host: string | undefined, portText: string): ListeningEndpoint | null {
  const port = parseInt(portText, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return {
    host: isWildcardHost(host) ? undefined : host,
    port,
  };
}

async function withTimeout<T>(promise: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function normalizeDnsHostname(hostname: string): string {
  return hostname.replace(/\.$/, '');
}

async function reverseDnsHostnamesForUrl(baseUrl: string): Promise<string[]> {
  let host: string;
  try {
    host = normalizeHost(new URL(baseUrl).hostname);
  } catch {
    return [];
  }

  if (net.isIP(host) === 0) return [];

  const resolved = await withTimeout(
    dns.promises.reverse(host),
    [],
    DNS_LOOKUP_TIMEOUT_MS,
  );
  const seen = new Set<string>();
  return resolved
    .map(normalizeDnsHostname)
    .filter((hostname) => {
      const key = hostname.toLowerCase();
      if (!hostname || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function addDnsHostnames(server: ViteServerInfo): Promise<ViteServerInfo> {
  const dnsHostnames = await reverseDnsHostnamesForUrl(server.url);
  if (dnsHostnames.length === 0) return server;
  logger.debug(`Reverse DNS for ${server.url}: ${dnsHostnames.join(', ')}`);
  return { ...server, dnsHostnames };
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
        return addDnsHostnames({ url: baseUrl, version: versionMatch?.[1] });
      }
    }
  } catch { /* try fallback */ }

  try {
    // Fallback: check if the HTML page includes vite client script
    const htmlRes = await httpGet(baseUrl);
    if (htmlRes.status === 200 && htmlRes.body.includes('/@vite/client')) {
      logger.info(`Vite server detected at ${baseUrl} via HTML content`);
      return addDnsHostnames({ url: baseUrl });
    }
  } catch { /* not a vite server on this host */ }

  return null;
}

function probeHostsForEndpoint(endpoint: ListeningEndpoint): string[] {
  const hosts: string[] = [];
  if (endpoint.host && !isWildcardHost(endpoint.host)) {
    hosts.push(endpoint.host);
    if (isLoopbackHost(endpoint.host)) {
      hosts.push('localhost', '127.0.0.1');
    }
  } else {
    hosts.push('localhost', '127.0.0.1');
  }

  const seen = new Set<string>();
  return hosts.filter((host) => {
    const key = normalizeHost(host);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function isViteServer(endpoint: ListeningEndpoint): Promise<ViteServerInfo | null> {
  // Probe the host reported by the OS first. This matters when tools bind Vite
  // to a virtual 127.x.x.x loopback address instead of 127.0.0.1.
  const probes = probeHostsForEndpoint(endpoint).map(h => probeViteHost(`http://${h}:${endpoint.port}`));
  const results = await Promise.all(probes);
  return results.find(r => r !== null) ?? null;
}

export async function detectViteServers(preferredUrl?: string): Promise<ViteServerInfo[]> {
  // If a preferred URL is given, check it first
  if (preferredUrl) {
    try {
      const url = new URL(preferredUrl);
      const result = await probeViteHost(url.origin);
      if (result) return [result];
    } catch {
      logger.warn(`Invalid preferred URL: ${preferredUrl}`);
    }
  }

  // Discover endpoints from running node/Vite-like processes.
  const endpoints = await getNodeListeningEndpoints();
  logger.debug(
    `Node listening endpoints: ${endpoints.map(e => `${e.host ?? '*'}:${e.port}`).join(', ') || '(none)'}`,
  );

  if (endpoints.length === 0) {
    logger.info('No node processes listening on any port');
    return [];
  }

  // Check each endpoint for Vite in parallel
  const servers: ViteServerInfo[] = [];
  const seenUrls = new Set<string>();
  const results = await Promise.all(endpoints.map(endpoint => isViteServer(endpoint)));
  for (const result of results) {
    if (!result || seenUrls.has(result.url)) continue;
    seenUrls.add(result.url);
    servers.push(result);
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
