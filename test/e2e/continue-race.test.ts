import { describe, expect, it, vi } from 'vitest';
import { CdpClient, TargetInfo } from '../../src/cdp/CdpClient';
import { DAPClient } from '../helpers/dapClient';

interface ClientInternals {
  client: { Debugger: { resume: (...args: unknown[]) => Promise<unknown> } };
  sessions: Map<string, TargetInfo>;
  pausedSessionIds: Set<string>;
  pauseRevisions: Map<string, number>;
  activeSessionId?: string;
  primarySessionId?: string;
}

function fixture() {
  const cdp = new (CdpClient as unknown as new () => CdpClient)();
  const internal = cdp as unknown as ClientInternals;
  const resume = vi.fn(async () => undefined);
  internal.client = { Debugger: { resume } };
  internal.sessions = new Map([['session', { targetId: 'target', type: 'page', title: 'app', url: 'http://127.0.0.1:5173/' }]]);
  internal.pausedSessionIds = new Set(['session']);
  internal.pauseRevisions = new Map([['session', 1]]);
  internal.activeSessionId = 'session';
  internal.primarySessionId = 'session';
  const resumed = vi.fn();
  cdp.on('resumed', resumed);
  return { cdp, internal, resume, resumed };
}

function alreadyRunning() {
  return Object.assign(new Error('Can only perform operation while paused.'), {
    response: { code: -32000, message: 'Can only perform operation while paused.' },
  });
}

describe('Continue state races', () => {
  it('reconciles the target when Chrome reports its old pause already ended', async () => {
    const { cdp, internal, resume, resumed } = fixture();
    resume.mockRejectedValueOnce(alreadyRunning());
    await cdp.resume('target');
    expect(internal.pausedSessionIds.size).toBe(0);
    expect(resumed).toHaveBeenCalledWith('session');
  });

  it('preserves a newer pause while an earlier resume is in flight', async () => {
    const { cdp, internal, resume, resumed } = fixture();
    resume.mockImplementationOnce(async () => {
      internal.pauseRevisions.set('session', 2);
      throw alreadyRunning();
    });
    await cdp.resume('target');
    expect(internal.pausedSessionIds.has('session')).toBe(true);
    expect(resumed).not.toHaveBeenCalled();
  });

  it('does not swallow unrelated CDP errors', async () => {
    const { cdp, resume } = fixture();
    resume.mockRejectedValueOnce(new Error('transport closed'));
    await expect(cdp.resume('target')).rejects.toThrow('transport closed');
  });

  it('answers a failed DAP continue instead of leaving the request pending', async () => {
    const dap = new DAPClient();
    (dap.session as unknown as { cdp: CdpClient }).cdp = {
      resume: vi.fn(async () => { throw new Error('transport closed'); }),
    } as unknown as CdpClient;
    await expect(dap.request('continue', { threadId: 1 }, 1000)).rejects.toThrow('Continue failed: transport closed');
  });
});
