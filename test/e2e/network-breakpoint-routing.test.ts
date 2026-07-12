import { describe, expect, it, vi } from 'vitest';
import { NetworkBreakpointManager } from '../../src/breakpoints/NetworkBreakpointManager';
import { CdpClient } from '../../src/cdp/CdpClient';
import type { FetchRequestPausedEvent } from '../../src/cdp/CdpTypes';

function pausedRequest(requestId: string): FetchRequestPausedEvent {
  return {
    requestId,
    request: {
      url: 'http://localhost:5173/api/data',
      method: 'GET',
      headers: {},
    },
    frameId: 'frame-1',
    resourceType: 'Fetch',
  };
}

function routableCdpClient(owners: Map<string, Set<string>>): {
  client: CdpClient;
  continueRequest: ReturnType<typeof vi.fn>;
  failRequest: ReturnType<typeof vi.fn>;
} {
  // CdpClient's constructor is intentionally private for production callers;
  // Reflect.construct gives this routing-only test a normally initialized
  // instance without opening a browser connection.
  const client = Reflect.construct(
    CdpClient as unknown as new () => CdpClient,
    [],
  );
  const continueRequest = vi.fn(async () => undefined);
  const failRequest = vi.fn(async () => undefined);
  const internals = client as unknown as {
    client: {
      Fetch: {
        continueRequest: typeof continueRequest;
        failRequest: typeof failRequest;
      };
    };
    fetchRequestOwners: Map<string, Set<string>>;
  };
  internals.client = { Fetch: { continueRequest, failRequest } };
  internals.fetchRequestOwners = owners;
  return { client, continueRequest, failRequest };
}

describe('multi-tab network breakpoint routing', () => {
  it('passes each Fetch event session through matching and continuation', async () => {
    const continueFetchRequest = vi.fn(async () => undefined);
    const cdp = { continueFetchRequest } as unknown as CdpClient;
    const manager = new NetworkBreakpointManager(cdp);
    manager.setRules(['fetch:*\/api\/data']);
    const matchedSessions: Array<string | undefined> = [];
    manager.onMatch((_rule, _request, sessionId) => {
      matchedSessions.push(sessionId);
    });

    // CDP request ids are session-scoped, so two tabs may report the same id.
    await manager.handleRequest(pausedRequest('interception-job-1'), 'session-a');
    await manager.handleRequest(pausedRequest('interception-job-1'), 'session-b');

    expect(matchedSessions).toEqual(['session-a', 'session-b']);
    expect(continueFetchRequest).toHaveBeenNthCalledWith(
      1,
      'interception-job-1',
      'session-a',
    );
    expect(continueFetchRequest).toHaveBeenNthCalledWith(
      2,
      'interception-job-1',
      'session-b',
    );
  });

  it('continues and fails colliding request ids in only the explicit target session', async () => {
    const owners = new Map([
      ['interception-job-1', new Set(['session-a', 'session-b'])],
    ]);
    const { client, continueRequest, failRequest } = routableCdpClient(owners);

    await client.continueFetchRequest('interception-job-1', 'session-a');
    expect(continueRequest).toHaveBeenCalledWith(
      { requestId: 'interception-job-1' },
      'session-a',
    );
    expect(owners.get('interception-job-1')).toEqual(new Set(['session-b']));

    await client.failFetchRequest('interception-job-1', 'Aborted', 'session-b');
    expect(failRequest).toHaveBeenCalledWith(
      { requestId: 'interception-job-1', reason: 'Aborted' },
      'session-b',
    );
    expect(owners.has('interception-job-1')).toBe(false);
  });

  it('preserves implicit routing for a uniquely owned request', async () => {
    const owners = new Map([
      ['request-unique', new Set(['session-b'])],
    ]);
    const { client, continueRequest } = routableCdpClient(owners);

    await client.continueFetchRequest('request-unique');

    expect(continueRequest).toHaveBeenCalledWith(
      { requestId: 'request-unique' },
      'session-b',
    );
  });

  it('rejects an explicit session which does not own the request', async () => {
    const owners = new Map([
      ['request-a', new Set(['session-a'])],
    ]);
    const { client, continueRequest } = routableCdpClient(owners);

    await expect(client.continueFetchRequest('request-a', 'session-b'))
      .rejects.toThrow('does not belong to target session session-b');
    expect(continueRequest).not.toHaveBeenCalled();
  });
});
