import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceMapGenerator } from 'source-map';
import { BreakpointManager } from '../../src/breakpoints/BreakpointManager';
import { SourceMapResolver } from '../../src/sourcemap/SourceMapResolver';
import type { CdpClient } from '../../src/cdp/CdpClient';
import { ViteDebugSession } from '../../src/adapter/ViteDebugSession';
import type { DebugProtocol } from '@vscode/debugprotocol';

const sourcePath = '/workspace/src/Widget.tsx';
const resolvers: SourceMapResolver[] = [];
afterEach(() => { for (const resolver of resolvers.splice(0)) resolver.clear(); });

type Mappings = Array<{ generatedLine: number; generatedColumn: number; line?: number; column?: number }>;

function mapUrl(mappings: Mappings): string {
  const map = new SourceMapGenerator({ file: sourcePath });
  for (const entry of mappings) {
    const generated = { line: entry.generatedLine, column: entry.generatedColumn };
    if (entry.line === undefined) {
      // source-map supports an unmapped segment although its Mapping type
      // requires original/source fields.
      map.addMapping({ generated } as Parameters<SourceMapGenerator['addMapping']>[0]);
    } else {
      map.addMapping({
        generated,
        source: sourcePath,
        original: { line: entry.line, column: entry.column ?? 0 },
      });
    }
  }
  return 'data:application/json;base64,' + Buffer.from(map.toString()).toString('base64');
}

async function setup(url = 'http://127.0.0.1:5173/src/Widget.tsx', mappings: Mappings = [
  { generatedLine: 1, generatedColumn: 99, line: 5, column: 0 },
  { generatedLine: 1, generatedColumn: 100, line: 6, column: 2 },
  { generatedLine: 1, generatedColumn: 150, line: 6, column: 10 },
]) {
  const resolver = new SourceMapResolver('/workspace');
  resolvers.push(resolver);
  await resolver.registerScript('script-1', url, mapUrl(mappings));
  const positions = [99, 150].map((columnNumber) => ({ scriptId: 'script-1', lineNumber: 0, columnNumber }));
  let handle = 0;
  const setBreakpointByUrl = vi.fn(async (lineNumber: number, options: { columnNumber?: number }) => ({
    breakpointId: `physical-${++handle}`,
    locations: [{ scriptId: 'script-1', lineNumber, columnNumber: options.columnNumber ?? 0 }],
  }));
  const removeBreakpoint = vi.fn(async () => undefined);
  const getPossibleBreakpoints = vi.fn(async () => positions);
  const cdp = { setBreakpointByUrl, removeBreakpoint, getPossibleBreakpoints } as unknown as CdpClient;
  const manager = new BreakpointManager(cdp, resolver, 'http://127.0.0.1:5173');
  return { manager, resolver, setBreakpointByUrl, removeBreakpoint, getPossibleBreakpoints, positions };
}

describe('Breakpoint source accuracy', () => {
  it('chooses the requested original line rather than the closest generated column', async () => {
    const { manager, setBreakpointByUrl } = await setup();
    const [bp] = await manager.setBreakpoints(sourcePath, [{ line: 6, column: 1 }]);
    expect(setBreakpointByUrl).toHaveBeenCalledWith(0, expect.objectContaining({ columnNumber: 150 }));
    expect(bp).toMatchObject({ verified: true, line: 6, column: 11 });
  });

  it('keeps the requested line separate from the resolved line for later HMR', async () => {
    const { manager } = await setup();
    const [bp] = await manager.setBreakpoints(sourcePath, [{ line: 4, column: 1 }]);
    expect(bp).toMatchObject({ verified: true, line: 5 });
    expect(manager.getAllBreakpoints().get(sourcePath)?.[0]).toMatchObject({ line: 4, resolvedLine: 5 });
  });

  it('does not treat unmapped generated helpers as executable source code', async () => {
    const { manager, resolver, positions, setBreakpointByUrl } = await setup(undefined, [
      { generatedLine: 1, generatedColumn: 0, line: 6, column: 2 },
      { generatedLine: 2, generatedColumn: 0 },
    ]);
    positions.splice(0, positions.length, { scriptId: 'script-1', lineNumber: 1, columnNumber: 0 });
    expect(await resolver.generatedToOriginal('script-1', 1, 0)).toMatchObject({ line: 6 });
    expect(await resolver.generatedToOriginal('script-1', 1, 0, false)).toBeNull();
    const [bp] = await manager.setBreakpoints(sourcePath, [{ line: 6, column: 1 }]);
    expect(bp.verified).toBe(false);
    expect(setBreakpointByUrl).not.toHaveBeenCalled();
  });

  it('does not advertise breakpoint columns inferred from unmapped injected code', async () => {
    const { resolver } = await setup(undefined, [
      { generatedLine: 1, generatedColumn: 0, line: 6, column: 2 },
      { generatedLine: 2, generatedColumn: 0 },
      { generatedLine: 2, generatedColumn: 20, line: 6, column: 10 },
    ]);
    const session = new ViteDebugSession() as unknown as {
      sourceMapResolver: SourceMapResolver;
      cdp: CdpClient;
      sendResponse(response: DebugProtocol.BreakpointLocationsResponse): void;
      breakpointLocationsRequest(
        response: DebugProtocol.BreakpointLocationsResponse,
        args: DebugProtocol.BreakpointLocationsArguments,
      ): Promise<void>;
    };
    session.sourceMapResolver = resolver;
    session.cdp = {
      getPossibleBreakpoints: vi.fn(async (start: { lineNumber: number }) => [{
        scriptId: 'script-1', lineNumber: start.lineNumber, columnNumber: 0,
      }]),
    } as unknown as CdpClient;
    session.sendResponse = vi.fn();
    const response: DebugProtocol.BreakpointLocationsResponse = {
      seq: 1, request_seq: 1, type: 'response', command: 'breakpointLocations', success: true,
      body: { breakpoints: [] },
    };
    await session.breakpointLocationsRequest(response, { source: { path: sourcePath }, line: 6 });
    expect(response.body?.breakpoints).toEqual([{ line: 6, column: 3 }]);
  });

  it.each([
    'http://127.0.0.1:5173/debug/src/Widget.tsx',
    'http://localhost:5173/packages/src/nested/src/Widget.tsx',
    'http://127.0.0.1:5173/@fs/workspace/shared/Widget.tsx',
    'http://127.0.0.1:5173/components/Widget.tsx',
    'https://localhost/components/My%20Widget.tsx',
  ])('binds to the mapped script URL exactly: %s', async (url) => {
    const { manager, setBreakpointByUrl } = await setup(url);
    await manager.setBreakpoints(sourcePath, [{ line: 6, column: 1 }]);
    const options = setBreakpointByUrl.mock.calls[0][1] as { urlRegex: string };
    const regex = new RegExp(options.urlRegex);
    expect(regex.test(url)).toBe(true);
    expect(regex.test(url + '?t=12345')).toBe(true);
    expect(regex.test(url + '.backup')).toBe(false);
    expect(regex.test(url.replace('/components/', '/other-components/'))).toBe(!url.includes('/components/'));
    const alias = url.replace('localhost', '127.0.0.1').replace('127.0.0.1', '[::1]');
    expect(regex.test(alias)).toBe(true);
  });

  it('reports an unbound Chrome breakpoint as pending and retries it when the script arrives', async () => {
    const { manager, setBreakpointByUrl, removeBreakpoint } = await setup();
    setBreakpointByUrl.mockResolvedValueOnce({ breakpointId: 'unbound', locations: [] });
    const [pending] = await manager.setBreakpoints(sourcePath, [{ line: 6, column: 1 }]);
    expect(pending.verified).toBe(false);
    expect(manager.hasPendingBreakpoints()).toBe(true);
    const resolved = await manager.resolveBreakpointsForScript('script-1', 'http://127.0.0.1:5173/src/Widget.tsx');
    expect(removeBreakpoint).toHaveBeenCalledWith('unbound');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ verified: true, resolvedLine: 6, resolvedColumn: 11 });
    await manager.setBreakpoints(sourcePath, []);
    expect(removeBreakpoint).toHaveBeenCalledWith('physical-1');
  });

  it('resolves pending breakpoints using the arriving script and releases the superseded handle', async () => {
    const { manager, resolver, positions, setBreakpointByUrl, removeBreakpoint } = await setup();
    setBreakpointByUrl.mockResolvedValueOnce({ breakpointId: 'old-unbound', locations: [] });
    await manager.setBreakpoints(sourcePath, [{ line: 6, column: 1 }]);
    await resolver.registerScript('script-2', 'http://127.0.0.1:5173/src/Widget.tsx?t=2', mapUrl([
      { generatedLine: 1, generatedColumn: 300, line: 6, column: 10 },
    ]));
    positions.splice(0, positions.length, { scriptId: 'script-2', lineNumber: 0, columnNumber: 300 });
    setBreakpointByUrl.mockResolvedValueOnce({
      breakpointId: 'new-bound', locations: [{ scriptId: 'script-2', lineNumber: 0, columnNumber: 300 }],
    });
    expect(await resolver.originalToGenerated(sourcePath, 6, 0, 'script-2')).toMatchObject({
      scriptId: 'script-2', columnNumber: 300,
    });
    expect(await manager.resolveBreakpointsForScript('script-2', '')).toHaveLength(1);
    expect(removeBreakpoint).toHaveBeenCalledWith('old-unbound');
    await manager.setBreakpoints(sourcePath, []);
    expect(removeBreakpoint).toHaveBeenCalledWith('new-bound');
  });

  it('removes a Chrome breakpoint that bound to a different source position', async () => {
    const { manager, setBreakpointByUrl, removeBreakpoint } = await setup();
    setBreakpointByUrl.mockResolvedValueOnce({
      breakpointId: 'wrong-line', locations: [{ scriptId: 'script-1', lineNumber: 0, columnNumber: 99 }],
    });
    const [bp] = await manager.setBreakpoints(sourcePath, [{ line: 6, column: 1 }]);
    expect(bp.verified).toBe(false);
    expect(removeBreakpoint).toHaveBeenCalledWith('wrong-line');
  });
});
