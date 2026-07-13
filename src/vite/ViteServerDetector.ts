import * as http from 'http';
import * as childProcess from 'child_process';
import * as dns from 'dns';
import * as fs from 'fs';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../util/Logger';
import { isLoopbackHost, isWildcardHost, normalizeHost } from '../util/LocalHosts';

export interface ViteServerInfo {
  url: string;
  /** HTML page Chrome should open. `url` remains the Vite module origin. */
  pageUrl?: string;
  version?: string;
  dnsHostnames?: string[];
  root?: string;  // Absolute path of the Vite project root (e.g., /Users/.../zuzu/client)
  /** Node's CA check failed, but the host resolved exclusively to loopback and was pinned for a local retry. */
  localTlsCertificateBypass?: boolean;
}

interface ListeningEndpoint {
  host?: string;
  port: number;
}

const DNS_LOOKUP_TIMEOUT_MS = 500;
const MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;

interface HttpGetResult {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
  localTlsCertificateBypass?: boolean;
}

interface LoopbackAddress {
  address: string;
  family: 4 | 6;
}

const LOCAL_TLS_TRUST_ERROR_CODES = new Set([
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

async function httpGet(
  url: string,
  timeout: number = 3000,
  requireExclusiveLoopback: boolean = false,
  headers?: http.OutgoingHttpHeaders,
): Promise<HttpGetResult> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  const pinnedLoopback = requireExclusiveLoopback
    ? await resolveExclusiveLoopback(parsed.hostname)
    : undefined;
  if (requireExclusiveLoopback && !pinnedLoopback) {
    throw new Error(`URL no longer resolves exclusively to loopback: ${parsed.origin}`);
  }

  try {
    return await requestUrl(parsed, timeout, pinnedLoopback ?? undefined, false, headers);
  } catch (error) {
    if (parsed.protocol !== 'https:' || !isLocalTlsTrustError(error)) throw error;

    const loopback = pinnedLoopback ?? await resolveExclusiveLoopback(parsed.hostname);
    if (!loopback) throw error;

    logger.warn(
      `Vite HTTPS certificate is not trusted by Node at ${parsed.origin}; ` +
      `retrying only on pinned loopback address ${loopback.address}.`,
    );
    return requestUrl(parsed, timeout, loopback, true, headers);
  }
}

function requestUrl(
  url: URL,
  timeout: number,
  pinnedLoopback?: LoopbackAddress,
  allowUntrustedCertificate: boolean = false,
  headers?: http.OutgoingHttpHeaders,
): Promise<HttpGetResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req: http.ClientRequest;
    let deadline: NodeJS.Timeout;
    const finish = (result: HttpGetResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(error);
    };
    const onResponse = (res: http.IncomingMessage): void => {
      let body = '';
      let bodyBytes = 0;
      res.on('data', (chunk: Buffer | string) => {
        bodyBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        if (bodyBytes > MAX_HTTP_RESPONSE_BYTES) {
          res.destroy();
          fail(new Error(`HTTP response exceeded ${MAX_HTTP_RESPONSE_BYTES} bytes`));
          return;
        }
        body += chunk;
      });
      res.on('error', fail);
      res.on('end', () => {
        finish({
          status: res.statusCode ?? 0,
          body,
          headers: res.headers,
          localTlsCertificateBypass: allowUntrustedCertificate ? true : undefined,
        });
      });
    };

    if (pinnedLoopback) {
      const originalHostname = normalizeHost(url.hostname);
      const options: http.RequestOptions = {
        protocol: url.protocol,
        hostname: pinnedLoopback.address,
        family: pinnedLoopback.family,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, host: url.host },
        timeout,
      };
      if (url.protocol === 'https:') {
        req = https.get({
          ...options,
          servername: net.isIP(originalHostname) === 0 ? originalHostname : undefined,
          rejectUnauthorized: !allowUntrustedCertificate,
        }, onResponse);
      } else {
        req = http.get(options, onResponse);
      }
    } else {
      const transport = url.protocol === 'https:' ? https : http;
      // No TLS options are overridden here: HTTPS always performs Node's
      // normal CA and hostname validation on the first request.
      req = transport.get(url, { timeout, headers }, onResponse);
    }

    deadline = setTimeout(() => {
      req.destroy();
      fail(new Error('Request deadline exceeded'));
    }, timeout);
    req.on('error', fail);
    req.on('timeout', () => {
      req.destroy();
      fail(new Error('Request timeout'));
    });
  });
}

function isLocalTlsTrustError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && LOCAL_TLS_TRUST_ERROR_CODES.has(code);
}

async function resolveExclusiveLoopback(hostname: string): Promise<LoopbackAddress | null> {
  const normalized = normalizeHost(hostname);
  const literalFamily = net.isIP(normalized);
  if (literalFamily !== 0) {
    return isLoopbackHost(normalized)
      ? { address: normalized, family: literalFamily as 4 | 6 }
      : null;
  }

  const addresses = await withTimeout(
    dns.promises.lookup(normalized, { all: true, verbatim: true }),
    [],
    DNS_LOOKUP_TIMEOUT_MS,
  );
  if (addresses.length === 0 || addresses.some(({ address }) => !isLoopbackHost(address))) {
    return null;
  }

  const selected = addresses[0];
  return { address: selected.address, family: selected.family as 4 | 6 };
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

async function probeViteHost(
  baseUrl: string,
  requireExclusiveLoopback: boolean = false,
): Promise<ViteServerInfo | null> {
  try {
    // Primary check: /@vite/client endpoint — unique to Vite
    const clientRes = await httpGet(`${baseUrl}/@vite/client`, 3000, requireExclusiveLoopback);
    if (clientRes.status === 200) {
      const contentType = clientRes.headers['content-type'] ?? '';
      const isJs = contentType.includes('javascript') || contentType.includes('text/plain');
      const bodyHasVite = clientRes.body.includes('vite') ||
                          clientRes.body.includes('@vite') ||
                          clientRes.body.includes('__vite');

      if (isJs || bodyHasVite) {
        logger.info(`Vite server detected at ${baseUrl} via /@vite/client`);
        const versionMatch = clientRes.body.match(/vite\/dist\/client|vite\/([\d.]+)/i);
        return addDnsHostnames({
          url: baseUrl,
          version: versionMatch?.[1],
          localTlsCertificateBypass: clientRes.localTlsCertificateBypass,
        });
      }
    }
  } catch { /* try fallback */ }

  // Fallback: check HTML. Some middleware-mode/custom Vite setups deliberately
  // return 404 for `/` while still serving the app at `/index.html`.
  for (const pageUrl of [`${baseUrl}/`, `${baseUrl}/index.html`]) {
    try {
      const htmlRes = await httpGet(
        pageUrl,
        3000,
        requireExclusiveLoopback,
        { accept: 'text/html,application/xhtml+xml' },
      );
      if (htmlRes.status === 200 && htmlRes.body.includes('/@vite/client')) {
        logger.info(`Vite server detected at ${baseUrl} via HTML content at ${pageUrl}`);
        return addDnsHostnames({
          url: baseUrl,
          pageUrl,
          localTlsCertificateBypass: htmlRes.localTlsCertificateBypass,
        });
      }
    } catch { /* try the next HTML candidate */ }
  }

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

function isValidLocalHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253 || !/^[\x00-\x7f]+$/.test(hostname)) {
    return false;
  }
  const labels = hostname.split('.');
  return labels.every((label) =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

/**
 * Resolve a loopback endpoint back to a hosts/DNS name, then forward-verify it
 * before it can influence HTTP Host or TLS SNI. This recovers local aliases
 * such as `alphac` without parsing platform-specific hosts files ourselves.
 */
export async function verifiedLoopbackHostname(
  endpointHost: string,
  endpointPort: number,
): Promise<string | undefined> {
  const address = normalizeHost(endpointHost);
  if (net.isIP(address) === 0 || !isLoopbackHost(address)) return undefined;

  const service = await withTimeout(
    dns.promises.lookupService(address, endpointPort),
    null,
    DNS_LOOKUP_TIMEOUT_MS,
  );
  if (!service) return undefined;

  const hostname = normalizeDnsHostname(service.hostname).toLowerCase();
  if (!isValidLocalHostname(hostname)) return undefined;

  const forward = await withTimeout(
    dns.promises.lookup(hostname, { all: true, verbatim: true }),
    [],
    DNS_LOOKUP_TIMEOUT_MS,
  );
  if (
    forward.length === 0 ||
    forward.some((entry) => !isLoopbackHost(entry.address)) ||
    !forward.some((entry) => normalizeHost(entry.address) === address)
  ) {
    return undefined;
  }
  return hostname;
}

async function isViteServer(endpoint: ListeningEndpoint): Promise<ViteServerInfo | null> {
  const ordinaryHosts = probeHostsForEndpoint(endpoint);
  const alias = endpoint.host
    ? await verifiedLoopbackHostname(endpoint.host, endpoint.port)
    : undefined;

  // Preserve the established HTTP endpoint-first behavior and avoid sending
  // TLS handshakes to a healthy plain-HTTP server. Only if HTTP has no match do
  // we try HTTPS. A verified alias gets the first HTTPS attempt so the selected
  // URL keeps its certificate/Host identity (e.g. https://alphac:3004).
  const httpResult = await firstDetectedVite(
    ordinaryHosts.map((host) => `http://${host}:${endpoint.port}`),
  );
  if (httpResult) return httpResult;

  if (alias) {
    const aliasResult = await probeViteHost(`https://${alias}:${endpoint.port}`);
    if (aliasResult) return aliasResult;
  }

  return firstDetectedVite(
    ordinaryHosts
      .filter((host) => !alias || normalizeHost(host) !== normalizeHost(alias))
      .map((host) => `https://${host}:${endpoint.port}`),
  );
}

async function firstDetectedVite(urls: string[]): Promise<ViteServerInfo | null> {
  const results = await Promise.all([...new Set(urls)].map((url) => probeViteHost(url)));
  return results.find((result) => result !== null) ?? null;
}

export async function detectViteServers(
  preferredUrl?: string,
  requireLocalPreferredUrl: boolean = false,
): Promise<ViteServerInfo[]> {
  // An explicit URL is authoritative and fail-closed. Falling through to the
  // machine-wide endpoint scan after it fails could attach this session to a
  // different project's Vite process.
  if (preferredUrl) {
    try {
      const url = new URL(preferredUrl);
      const result = await probeViteHost(url.origin, requireLocalPreferredUrl);
      if (result) return [result];
      logger.warn(`No Vite server responded at preferred URL: ${url.origin}`);
    } catch {
      logger.warn(`Invalid preferred URL: ${preferredUrl}`);
    }
    return [];
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

/**
 * Return whether a discovered Vite project belongs to the debug session's
 * project root. A Vite package may live below an outer monorepo workspace, so
 * descendants are valid; siblings and parents are not.
 */
export function viteRootMatchesWebRoot(viteRoot: string, webRoot: string): boolean {
  if (!viteRoot.trim() || !webRoot.trim()) return false;
  const normalizedViteRoot = canonicalProjectPath(viteRoot);
  const normalizedWebRoot = canonicalProjectPath(webRoot);
  const relative = path.relative(normalizedWebRoot, normalizedViteRoot);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Select one root-scoped server. Returning null for both zero and multiple
 * matches is deliberate: an automatic debug launch must never attach to an
 * arbitrary Vite process from another project in the same VS Code window.
 */
export function selectViteServerForWebRoot(
  servers: ViteServerInfo[],
  webRoot: string,
): ViteServerInfo | null {
  const matching = servers.filter((server) =>
    typeof server.root === 'string' && viteRootMatchesWebRoot(server.root, webRoot));
  return matching.length === 1 ? matching[0] : null;
}

function canonicalProjectPath(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  try {
    const realPath = fs.realpathSync.native(resolved);
    return process.platform === 'win32' ? realPath.toLowerCase() : realPath;
  } catch {
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}

function urlOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

interface ViteServerMetadata {
  root?: string;
  pageUrl?: string;
}

async function addViteMetadata(
  server: ViteServerInfo,
  preferredPageUrl?: string,
  requireExclusiveLoopback: boolean = false,
): Promise<ViteServerInfo> {
  if (server.root !== undefined && server.pageUrl !== undefined) return server;
  const metadata = await queryViteMetadata(
    server.url,
    preferredPageUrl ?? server.pageUrl,
    requireExclusiveLoopback,
  );
  return {
    ...server,
    root: server.root ?? metadata.root,
    pageUrl: server.pageUrl ?? metadata.pageUrl,
  };
}

export async function detectFirstViteServer(
  preferredUrl?: string,
  webRoot?: string,
  requireExplicitUrlWebRootMatch: boolean = false,
): Promise<ViteServerInfo | null> {
  const servers = await detectViteServers(preferredUrl, requireExplicitUrlWebRootMatch);
  if (servers.length === 0) return null;

  // A reachable explicit URL remains authoritative by default even if its
  // source-map root is outside webRoot. Users may intentionally debug a linked
  // checkout or a non-standard Vite filesystem layout. MCP-generated launches
  // opt into the stricter match so a stale URL cannot cross project windows.
  const preferredOrigin = preferredUrl ? urlOrigin(preferredUrl) : undefined;
  const preferred = preferredOrigin
    ? servers.find((server) => urlOrigin(server.url) === preferredOrigin)
    : undefined;
  if (preferred) {
    const hydrated = await addViteMetadata(
      preferred,
      preferredUrl,
      requireExplicitUrlWebRootMatch,
    );
    if (!requireExplicitUrlWebRootMatch) return hydrated;
    if (
      webRoot &&
      typeof hydrated.root === 'string' &&
      viteRootMatchesWebRoot(hydrated.root, webRoot)
    ) {
      return hydrated;
    }
    logger.warn(
      `Explicit Vite URL ${preferredUrl} did not resolve to a project root below webRoot ` +
      `${webRoot ?? '(missing)'}.`,
    );
    return null;
  }

  // Keep the historical first-server behavior for callers that have no
  // project context (for example, the interactive detection command).
  if (!webRoot) return addViteMetadata(servers[0]);

  const rootedServers = await Promise.all(servers.map((server) => addViteMetadata(server)));
  const selected = selectViteServerForWebRoot(rootedServers, webRoot);
  if (selected) return selected;

  const matching = rootedServers.filter((server) =>
    typeof server.root === 'string' && viteRootMatchesWebRoot(server.root, webRoot));

  if (matching.length === 0) {
    logger.warn(
      `No detected Vite server root matches webRoot ${webRoot}; ` +
      'set viteUrl explicitly to select a server.',
    );
  } else {
    logger.warn(
      `Multiple detected Vite server roots match webRoot ${webRoot}: ` +
      `${matching.map((server) => `${server.url} (${server.root})`).join(', ')}; ` +
      'set viteUrl explicitly to disambiguate.',
    );
  }
  return null;
}

/**
 * Query the Vite dev server to discover the project root on disk.
 *
 * Strategy:
 *   1. Fetch the HTML page (`/`, then `/index.html`) to find the entry module
 *   2. Fetch that module — Vite inlines a base64 source map at the end
 *   3. The source map's `file` field contains the absolute path of the original file
 *   4. Subtract the URL path from the absolute path to derive the root
 *
 * Example:
 *   entry URL path = /src/index.tsx
 *   sourcemap file = /Users/lky/project/captain/zuzu/client/src/index.tsx
 *   → root = /Users/lky/project/captain/zuzu/client
 */
async function queryViteMetadata(
  viteUrl: string,
  preferredPageUrl?: string,
  requireExclusiveLoopback: boolean = false,
): Promise<ViteServerMetadata> {
  const page = await findViteHtmlPage(viteUrl, preferredPageUrl, requireExclusiveLoopback);
  try {
    const entryPath = await findEntryModulePath(
      viteUrl,
      page?.html,
      requireExclusiveLoopback,
    );
    if (!entryPath) return { pageUrl: page?.url };
    return {
      root: await deriveRootFromModule(viteUrl, entryPath, requireExclusiveLoopback),
      pageUrl: page?.url,
    };
  } catch (e) {
    logger.debug(`Failed to query Vite metadata: ${e}`);
    return { pageUrl: page?.url };
  }
}

interface ViteHtmlPage {
  url: string;
  html: string;
}

async function findViteHtmlPage(
  viteUrl: string,
  preferredPageUrl?: string,
  requireExclusiveLoopback: boolean = false,
): Promise<ViteHtmlPage | undefined> {
  const origin = new URL(viteUrl).origin;
  const candidates: string[] = [];
  if (preferredPageUrl) {
    try {
      const preferred = new URL(preferredPageUrl);
      if (preferred.origin === origin && !preferred.pathname.startsWith('/@vite/')) {
        candidates.push(preferred.href);
      }
    } catch { /* ignore an invalid preferred page and use standard paths */ }
  }
  candidates.push(`${origin}/`, `${origin}/index.html`);

  for (const candidate of [...new Set(candidates)]) {
    try {
      const response = await httpGet(
        candidate,
        3000,
        requireExclusiveLoopback,
        { accept: 'text/html,application/xhtml+xml' },
      );
      const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
      const likelyHtml = contentType.includes('text/html') ||
        /<(?:!doctype|html|head|body|script)\b/i.test(response.body);
      if (
        response.status >= 200 &&
        response.status < 300 &&
        likelyHtml &&
        isViteApplicationHtml(response.body)
      ) {
        logger.debug(`Vite HTML page: ${candidate}`);
        return { url: candidate, html: response.body };
      }
    } catch { /* try the next candidate */ }
  }
  return undefined;
}

/**
 * A 2xx HTML response is not necessarily a runnable application. Middleware
 * setups commonly expose a raw public template at `/index.html` while another
 * server renders the real page. Opening that template would create a healthy
 * Chrome target containing a blank app. Only select HTML that actually boots
 * Vite or an application module.
 */
function isViteApplicationHtml(html: string): boolean {
  if (/(?:src|href)=["'][^"']*\/@vite\/client(?:[?"'])/i.test(html)) return true;

  for (const match of html.matchAll(/<script\s[^>]*>/gi)) {
    const tag = match[0];
    if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue;
    if (/\bsrc\s*=\s*["'][^"']+["']/i.test(tag)) return true;
  }

  return /<script\s[^>]*\btype\s*=\s*["']module["'][^>]*>[\s\S]*?\bimport\s*(?:\(|["'])/i.test(html);
}

/**
 * Find the entry module URL path from the Vite HTML page.
 * Handles multiple patterns:
 *   - <script type="module" src="/src/index.tsx">
 *   - <script src="/src/main.tsx" type="module">
 *   - <script type="module">import "/src/main.tsx"</script>
 * Falls back to common entry point paths if HTML parsing fails.
 */
async function findEntryModulePath(
  viteUrl: string,
  html?: string,
  requireExclusiveLoopback: boolean = false,
): Promise<string | undefined> {
  if (html) {
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
  }

  // Fallback: try common Vite entry points in parallel (was sequential with
  // 2s timeout each — could wait up to 12s when the entry wasn't any of them).
  const commonEntries = ['/src/main.tsx', '/src/main.ts', '/src/index.tsx', '/src/index.ts', '/src/main.jsx', '/src/main.js'];
  const results = await Promise.all(commonEntries.map(async (entry) => {
    try {
      const res = await httpGet(`${viteUrl}${entry}`, 1500, requireExclusiveLoopback);
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
async function deriveRootFromModule(
  viteUrl: string,
  entryPath: string,
  requireExclusiveLoopback: boolean = false,
): Promise<string | undefined> {
  const moduleRes = await httpGet(`${viteUrl}${entryPath}`, 3000, requireExclusiveLoopback);

  // Extract inline source map
  const smMatch = moduleRes.body.match(
    /\/\/# sourceMappingURL=data:[^,\r\n]*;base64,([A-Za-z0-9+/=]+)/,
  );
  if (smMatch) {
    try {
      const sourceMap = JSON.parse(
        Buffer.from(smMatch[1], 'base64').toString('utf-8'),
      ) as Record<string, unknown>;

      if (typeof sourceMap.file === 'string') {
        logger.debug(`Entry source map file: ${sourceMap.file}`);
        const absoluteFile = safeAbsoluteFilePath(sourceMap.file);
        const root = absoluteFile
          ? deriveRootFromMappedFile(entryPath, absoluteFile, true)
          : undefined;
        if (root) {
          logger.info(`Vite project root: ${root}`);
          return root;
        }
      }

      // esbuild/SWC maps frequently omit `file`. Only trust absolute source
      // paths (or relative sources safely contained by an absolute sourceRoot)
      // so a crafted URL-like source cannot steer project selection.
      for (const source of absoluteSourceMapFiles(sourceMap)) {
        const root = deriveRootFromMappedFile(entryPath, source, false);
        if (root) {
          logger.info(`Vite project root (source map source): ${root}`);
          return root;
        }
      }

      if (typeof sourceMap.fileName === 'string') {
        const fileName = safeAbsoluteFilePath(sourceMap.fileName);
        const root = fileName
          ? deriveRootFromMappedFile(entryPath, fileName, false)
          : undefined;
        if (root) {
          logger.info(`Vite project root (source map fileName): ${root}`);
          return root;
        }
      }
    } catch (error) {
      logger.debug(`Could not parse entry source map: ${error}`);
    }
  } else {
    logger.debug('No inline source map found in entry module');
  }

  // React's SWC development transform embeds an absolute source location in
  // generated jsxDEV calls even when its source map has no usable path.
  for (const fileName of swcFileNames(moduleRes.body)) {
    const root = deriveRootFromMappedFile(entryPath, fileName, false);
    if (root) {
      logger.info(`Vite project root (SWC fileName): ${root}`);
      return root;
    }
  }

  logger.debug(`Could not derive Vite root for entry=${entryPath}`);
  return undefined;
}

function safeAbsoluteFilePath(value: string): string | undefined {
  if (!value || value.includes('\0')) return undefined;
  if (!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)) return undefined;
  return value;
}

function absoluteSourceMapFiles(sourceMap: Record<string, unknown>): string[] {
  if (!Array.isArray(sourceMap.sources)) return [];
  const sourceRoot = typeof sourceMap.sourceRoot === 'string'
    ? safeAbsoluteFilePath(sourceMap.sourceRoot)
    : undefined;
  const files: string[] = [];

  for (const value of sourceMap.sources) {
    if (typeof value !== 'string' || value.includes('\0')) continue;
    const absolute = safeAbsoluteFilePath(value);
    if (absolute) {
      files.push(absolute);
      continue;
    }
    if (!sourceRoot || /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(value)) continue;

    const pathApi = path.win32.isAbsolute(sourceRoot) ? path.win32 : path.posix;
    const resolved = pathApi.resolve(sourceRoot, value);
    const relative = pathApi.relative(sourceRoot, resolved);
    if (
      relative === '..' ||
      relative.startsWith(`..${pathApi.sep}`) ||
      pathApi.isAbsolute(relative)
    ) {
      continue;
    }
    files.push(resolved);
  }
  return files;
}

function swcFileNames(moduleBody: string): string[] {
  const names: string[] = [];
  const pattern = /\bfileName\s*:\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/g;
  for (const match of moduleBody.matchAll(pattern)) {
    const doubleQuoted = match[1];
    const raw = doubleQuoted ?? match[2];
    let decoded: string;
    try {
      decoded = doubleQuoted !== undefined
        ? JSON.parse(`"${doubleQuoted}"`) as string
        : raw.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    } catch {
      continue;
    }
    const absolute = safeAbsoluteFilePath(decoded);
    if (absolute && !names.includes(absolute)) names.push(absolute);
    if (names.length >= 20) break;
  }
  return names;
}

function deriveRootFromMappedFile(
  entryPath: string,
  mappedFile: string,
  allowFuzzySuffix: boolean,
): string | undefined {
  const normalizedFile = mappedFile.replace(/\\/g, '/');
  let normalizedEntry: string;
  try {
    normalizedEntry = decodeURIComponent(new URL(entryPath, 'http://vite.invalid').pathname)
      .replace(/\\/g, '/');
  } catch {
    normalizedEntry = entryPath.split(/[?#]/, 1)[0].replace(/\\/g, '/');
  }
  if (!normalizedEntry.startsWith('/')) normalizedEntry = `/${normalizedEntry}`;

  if (normalizedFile.endsWith(normalizedEntry)) {
    let root = normalizedFile.slice(0, -normalizedEntry.length) || '/';
    if (/^[A-Za-z]:$/.test(root)) root += '/';
    return root;
  }
  if (!allowFuzzySuffix) return undefined;

  const entryParts = normalizedEntry.split('/').filter(Boolean);
  const fileParts = normalizedFile.split('/');
  let commonSuffix = 0;
  while (
    commonSuffix < entryParts.length &&
    commonSuffix < fileParts.length &&
    entryParts[entryParts.length - 1 - commonSuffix] === fileParts[fileParts.length - 1 - commonSuffix]
  ) {
    commonSuffix++;
  }
  if (commonSuffix === 0) return undefined;
  let root = fileParts.slice(0, fileParts.length - commonSuffix).join('/') || '/';
  if (/^[A-Za-z]:$/.test(root)) root += '/';
  return root;
}
