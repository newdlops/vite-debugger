export function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function isWildcardHost(host: string | undefined | null): boolean {
  if (!host) return true;
  const normalized = normalizeHost(host);
  return normalized === '*' ||
         normalized === '0.0.0.0' ||
         normalized === '::' ||
         normalized === '';
}

function isValidIpv4Octet(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  const n = Number(value);
  return n >= 0 && n <= 255;
}

export function isIpv4LoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  const parts = normalized.split('.');
  return parts.length === 4 &&
         parts[0] === '127' &&
         parts.every(isValidIpv4Octet);
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === 'localhost' ||
         normalized === '::1' ||
         normalized === '0:0:0:0:0:0:0:1' ||
         isIpv4LoopbackHost(normalized);
}

export function hostsEquivalent(a: string, b: string): boolean {
  const normalizedA = normalizeHost(a);
  const normalizedB = normalizeHost(b);
  return normalizedA === normalizedB ||
         (isLoopbackHost(normalizedA) && isLoopbackHost(normalizedB));
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  if (url.protocol === 'http:') return '80';
  if (url.protocol === 'https:') return '443';
  return '';
}

/** Compare web origins while treating every 127/8 spelling, localhost, and ::1 as the same host. */
export function localOriginsEquivalent(a: URL, b: URL): boolean {
  return a.protocol === b.protocol &&
    effectivePort(a) === effectivePort(b) &&
    hostsEquivalent(a.hostname, b.hostname);
}

export function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function urlHostPatternForHost(host: string): string {
  const normalized = normalizeHost(host);
  if (isLoopbackHost(normalized)) {
    return '(?:localhost|127(?:\\.(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)){3}|\\[::1\\])';
  }
  return escapeRegexLiteral(host);
}
