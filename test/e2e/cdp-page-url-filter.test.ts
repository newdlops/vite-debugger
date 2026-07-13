import { describe, expect, it } from 'vitest';
import { CdpClient } from '../../src/cdp/CdpClient';

interface FilterableCdpClient {
  targetUrlFilter?: string;
  urlMatches(url: string): boolean;
}

function clientFor(pageUrl: string): FilterableCdpClient {
  const client = new (
    CdpClient as unknown as new () => CdpClient
  )() as unknown as FilterableCdpClient;
  client.targetUrlFilter = pageUrl;
  return client;
}

describe('CDP application-page target filtering', () => {
  it('manages the app origin rather than the separate Vite module origin', () => {
    const client = clientFor('http://127.0.0.1:8004/accounts/login/');

    expect(client.urlMatches('http://localhost:8004/dashboard')).toBe(true);
    expect(client.urlMatches('http://127.0.0.1:3004/src/index.tsx')).toBe(false);
    expect(client.urlMatches('https://127.0.0.1:8004/accounts/login/')).toBe(false);
  });
});
