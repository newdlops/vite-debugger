import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { CallFrame } from '../../src/cdp/CdpTypes';
import { CallStackManager } from '../../src/inspection/CallStackManager';
import type { OriginalLocation, SourceMapResolver } from '../../src/sourcemap/SourceMapResolver';
import type { ViteUrlMapper } from '../../src/vite/ViteUrlMapper';

function callFrame(
  functionName: string,
  scriptId: string,
  url: string,
  lineNumber: number = 0,
  columnNumber: number = 0,
): CallFrame {
  return {
    callFrameId: `frame-${scriptId}`,
    functionName,
    location: { scriptId, lineNumber, columnNumber },
    url,
    scopeChain: [],
    this: { type: 'object' },
  };
}

function completesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Call-frame resolution exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

describe('CallStackManager pause-time resolution', () => {
  it('maps user frames concurrently without waiting for a cold dependency source map', async () => {
    const userSource = path.resolve(process.cwd(), 'test/e2e/call-stack-manager.test.ts');
    let resolveTop!: (location: OriginalLocation) => void;
    const topMapping = new Promise<OriginalLocation>((resolve) => {
      resolveTop = resolve;
    });

    const generatedToOriginal = vi.fn(
      async (scriptId: string): Promise<OriginalLocation | null> => {
        if (scriptId === 'user-top') return topMapping;
        if (scriptId === 'user-lower') {
          return { source: userSource, line: 91, column: 4 };
        }
        // A pause must never wait for this lazy dependency lookup.
        return new Promise<never>(() => undefined);
      },
    );
    const resolver = {
      generatedToOriginal,
      isSourceMapLoaded: vi.fn(() => false),
    } as unknown as SourceMapResolver;
    const mapper = {
      viteUrlToFilePath: vi.fn((url: string) => {
        if (url.includes('/node_modules/')) {
          return '/workspace/node_modules/.vite/deps/react-dom.js';
        }
        return userSource;
      }),
    } as unknown as ViteUrlMapper;
    const manager = new CallStackManager(resolver, mapper);

    const top = callFrame('submitLogin', 'user-top', 'https://app.test/src/login-page.tsx', 20, 8);
    const dependency = callFrame(
      'renderWithHooks',
      'react-dom',
      'https://app.test/node_modules/.vite/deps/react-dom.js',
      100,
      2,
    );
    const lowerUser = callFrame('onSubmit', 'user-lower', 'https://app.test/src/form.tsx', 40, 3);

    const resolution = manager.resolveCallFrames([top, dependency, lowerUser]);

    // The lower user frame starts mapping even while the top mapping is held,
    // proving source-map work is no longer performed sequentially. The cold
    // dependency map is not invoked at all.
    expect(generatedToOriginal.mock.calls.map(([scriptId]) => scriptId)).toEqual([
      'user-top',
      'user-lower',
    ]);

    resolveTop({ source: userSource, line: 55, column: 28 });
    const resolved = await completesWithin(resolution, 1_000);

    expect(resolved.map(({ dapFrame }) => dapFrame.id)).toEqual([1, 2, 3]);
    expect(resolved.map(({ dapFrame }) => dapFrame.name)).toEqual([
      'submitLogin',
      'renderWithHooks',
      'onSubmit',
    ]);
    expect(resolved[0].dapFrame).toMatchObject({
      source: { path: userSource },
      line: 55,
      column: 29,
    });
    expect(resolved[1].dapFrame).toMatchObject({
      line: 101,
      column: 3,
      presentationHint: 'subtle',
      source: { presentationHint: 'deemphasize' },
    });
    expect(manager.getCdpFrame(1)).toBe(top);
    expect(manager.getCdpFrame(2)).toBe(dependency);
    expect(manager.getCdpFrame(3)).toBe(lowerUser);
  });
});
