import { initLogger, LogLevel } from '../../src/util/Logger';

/**
 * Wires the extension's logger to stderr so adapter internals are visible
 * in test output. Call from beforeAll() in suites that want visibility into
 * ViteDebugSession behavior. Safe to call multiple times.
 */
export function enableTestLogging(level: LogLevel = LogLevel.Debug): void {
  const fakeChannel = {
    appendLine: (msg: string) => {
      // eslint-disable-next-line no-console
      console.error(msg);
    },
  } as unknown as Parameters<typeof initLogger>[0];
  initLogger(fakeChannel, level);
}
