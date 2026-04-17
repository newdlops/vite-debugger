import { EventEmitter } from 'events';
import { DebugProtocol } from '@vscode/debugprotocol';
import { ViteDebugSession } from '../../src/adapter/ViteDebugSession';

type Listener<T> = (event: T) => void;

/**
 * Drives a ViteDebugSession in-process using the same contract VSCode's
 * `DebugAdapterInlineImplementation` uses: handleMessage() for requests,
 * onDidSendMessage for responses and events.
 *
 * Tests read DAP responses by awaiting `request()` and observe events via
 * `once()` / `on()` / `waitForEvent()`.
 */
export class DAPClient {
  private seq = 1;
  private pending = new Map<number, (response: DebugProtocol.Response) => void>();
  private events = new EventEmitter();
  /** Unconsumed events by event name — lets waitForEvent pick up an event
   *  that fired before the listener was attached. Cleared by takeEvent/clearQueue. */
  private queued = new Map<string, DebugProtocol.Event[]>();
  readonly session: ViteDebugSession;

  constructor() {
    this.session = new ViteDebugSession();
    this.session.onDidSendMessage((msg: DebugProtocol.ProtocolMessage) => {
      if (msg.type === 'response') {
        const r = msg as DebugProtocol.Response;
        const cb = this.pending.get(r.request_seq);
        if (cb) {
          this.pending.delete(r.request_seq);
          cb(r);
        }
      } else if (msg.type === 'event') {
        const ev = msg as DebugProtocol.Event;
        const bucket = this.queued.get(ev.event) ?? [];
        bucket.push(ev);
        this.queued.set(ev.event, bucket);
        this.events.emit(ev.event, ev);
        this.events.emit('*', ev);
      }
    });
  }

  /** Drop all queued events of the given name(s), or all events if omitted. */
  clearQueue(...eventNames: string[]): void {
    if (eventNames.length === 0) {
      this.queued.clear();
    } else {
      for (const name of eventNames) this.queued.delete(name);
    }
  }

  request<Req extends DebugProtocol.Request, Resp extends DebugProtocol.Response>(
    command: string,
    args?: Req['arguments'],
    timeoutMs = 15_000,
  ): Promise<Resp> {
    const seq = this.seq++;
    const message: DebugProtocol.Request = {
      seq,
      type: 'request',
      command,
      arguments: args,
    };

    return new Promise<Resp>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`DAP request '${command}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(seq, (resp) => {
        clearTimeout(timer);
        if (!resp.success) {
          reject(new Error(`DAP request '${command}' failed: ${resp.message ?? 'unknown'}`));
          return;
        }
        resolve(resp as Resp);
      });
      this.session.handleMessage(message);
    });
  }

  on(event: string, listener: Listener<DebugProtocol.Event>): void {
    this.events.on(event, listener);
  }

  once(event: string, listener: Listener<DebugProtocol.Event>): void {
    this.events.once(event, listener);
  }

  off(event: string, listener: Listener<DebugProtocol.Event>): void {
    this.events.off(event, listener);
  }

  /**
   * Wait for a DAP event. If one of that name has already been emitted and
   * is still queued (unconsumed), resolves with the oldest one immediately.
   * Otherwise waits for the next occurrence. The returned event is removed
   * from the queue.
   */
  waitForEvent(event: string, timeoutMs = 15_000): Promise<DebugProtocol.Event> {
    const bucket = this.queued.get(event);
    if (bucket && bucket.length > 0) {
      const ev = bucket.shift()!;
      if (bucket.length === 0) this.queued.delete(event);
      return Promise.resolve(ev);
    }
    return new Promise((resolve, reject) => {
      const onEvent = (ev: DebugProtocol.Event): void => {
        clearTimeout(timer);
        // Consume from queue too
        const b = this.queued.get(event);
        if (b) {
          const idx = b.indexOf(ev);
          if (idx >= 0) b.splice(idx, 1);
          if (b.length === 0) this.queued.delete(event);
        }
        resolve(ev);
      };
      const timer = setTimeout(() => {
        this.events.off(event, onEvent);
        reject(new Error(`Timed out waiting for DAP event '${event}' after ${timeoutMs}ms`));
      }, timeoutMs);
      this.events.once(event, onEvent);
    });
  }

  async dispose(): Promise<void> {
    try {
      await this.request<DebugProtocol.DisconnectRequest, DebugProtocol.DisconnectResponse>(
        'disconnect',
        { terminateDebuggee: false },
        5000,
      );
    } catch {
      // Best-effort — session may already be torn down
    }
    this.events.removeAllListeners();
  }
}
