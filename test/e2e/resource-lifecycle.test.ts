import * as http from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceMapGenerator } from 'source-map';
import { SourceMapResolver } from '../../src/sourcemap/SourceMapResolver';
import { BreakpointLocationResolver } from '../../src/breakpoints/BreakpointLocationResolver';
import type { CdpClient } from '../../src/cdp/CdpClient';

const source = '/workspace/src/Resource.tsx';
const resolvers: SourceMapResolver[] = [];
const queries: BreakpointLocationResolver[] = [];
afterEach(() => {
  for (const query of queries.splice(0)) query.dispose();
  for (const resolver of resolvers.splice(0)) resolver.clear();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function rawMap(column = 4, file = source) {
  const generator = new SourceMapGenerator({ file });
  generator.setSourceContent(file, 'const value = 1;\nconst next = 2;');
  generator.addMapping({ generated: { line: 1, column }, source: file, original: { line: 1, column: 0 } });
  generator.addMapping({ generated: { line: 1, column: column + 4 }, source: file, original: { line: 2, column: 0 } });
  generator.addMapping({ generated: { line: 2, column }, source: file, original: { line: 2, column: 0 } });
  return generator.toString();
}

function inline(raw: string) { return 'data:application/json;base64,' + Buffer.from(raw).toString('base64'); }

async function fixture(limits = { maxEntries: 128, maxLocations: 25_000 }) {
  const resolver = new SourceMapResolver('/workspace');
  resolvers.push(resolver);
  await resolver.registerScript('script', 'http://127.0.0.1:5173/src/Resource.tsx', inline(rawMap()));
  const positions = [
    { scriptId: 'script', lineNumber: 0, columnNumber: 4 },
    { scriptId: 'script', lineNumber: 0, columnNumber: 8 },
    { scriptId: 'script', lineNumber: 1, columnNumber: 4 },
  ];
  const getPossibleBreakpoints = vi.fn(async (start: { lineNumber: number }) =>
    positions.filter((position) => position.lineNumber === start.lineNumber));
  const query = new BreakpointLocationResolver({ getPossibleBreakpoints } as unknown as CdpClient, resolver, limits);
  queries.push(query);
  return { resolver, query, positions, getPossibleBreakpoints };
}

describe('Debugger resource lifecycle', () => {
  it('shares one minified-line query across different original lines and simultaneous requests', async () => {
    const { query, getPossibleBreakpoints } = await fixture();
    const [first, second, repeated] = await Promise.all([
      query.forOriginalLine(source, 1, 'script'),
      query.forOriginalLine(source, 2, 'script'),
      query.forOriginalLine(source, 1, 'script'),
    ]);
    expect(first.map((position) => position.originalLine)).toEqual([1]);
    expect(second.map((position) => position.originalLine)).toEqual([2, 2]);
    expect(repeated).toEqual(first);
    expect(getPossibleBreakpoints).toHaveBeenCalledTimes(2); // one per generated line
    await query.forOriginalLine(source, 2, 'script');
    expect(getPossibleBreakpoints).toHaveBeenCalledTimes(2);
  });

  it('evicts least recently used queries at the entry budget', async () => {
    const { query, getPossibleBreakpoints } = await fixture({ maxEntries: 1, maxLocations: 10 });
    await query.forGeneratedLine('script', 0);
    await query.forGeneratedLine('script', 0);
    expect(getPossibleBreakpoints).toHaveBeenCalledTimes(1);
    await query.forGeneratedLine('script', 1);
    await query.forGeneratedLine('script', 0);
    expect(getPossibleBreakpoints).toHaveBeenCalledTimes(3);
  });

  it('preserves oversized results without retaining them beyond the location budget', async () => {
    const { query, getPossibleBreakpoints } = await fixture({ maxEntries: 10, maxLocations: 1 });
    expect(await query.forGeneratedLine('script', 0)).toHaveLength(2);
    expect(await query.forGeneratedLine('script', 0)).toHaveLength(2);
    expect(getPossibleBreakpoints).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed Chrome query as an empty successful result', async () => {
    const { query, getPossibleBreakpoints } = await fixture();
    getPossibleBreakpoints.mockRejectedValueOnce(new Error('temporary CDP failure'));
    expect(await query.forGeneratedLine('script', 0)).toEqual([]);
    expect(await query.forGeneratedLine('script', 0)).toHaveLength(2);
    expect(getPossibleBreakpoints).toHaveBeenCalledTimes(2);
  });

  it('invalidates cached locations when the same script id gets a new map', async () => {
    const { resolver, query, positions, getPossibleBreakpoints } = await fixture();
    expect((await query.forGeneratedLine('script', 0))[0].columnNumber).toBe(4);
    await resolver.registerScript('script', 'http://127.0.0.1:5173/src/Resource.tsx', inline(rawMap(20)));
    positions.splice(0, positions.length, { scriptId: 'script', lineNumber: 0, columnNumber: 20 });
    expect((await query.forGeneratedLine('script', 0))[0].columnNumber).toBe(20);
    expect(getPossibleBreakpoints).toHaveBeenCalledTimes(2);
  });

  it('drops in-flight query results after a script is removed or the cache is cleared', async () => {
    const { resolver, query, getPossibleBreakpoints } = await fixture();
    const response = deferred<Awaited<ReturnType<typeof getPossibleBreakpoints>>>();
    getPossibleBreakpoints.mockReturnValueOnce(response.promise);
    const pending = query.forGeneratedLine('script', 0);
    await vi.waitFor(() => expect(getPossibleBreakpoints).toHaveBeenCalledTimes(1));
    query.clear();
    response.resolve([{ scriptId: 'script', lineNumber: 0, columnNumber: 4 }]);
    expect(await pending).toEqual([]);
    expect(await query.forGeneratedLine('script', 0)).toHaveLength(2);
    resolver.unregisterScript('script', true);
    expect(await query.forGeneratedLine('script', 0)).toEqual([]);
    expect(resolver.getSourceContent(source)).toBeNull();
  });

  it('reclaims unused source text without removing another tab\'s copy', async () => {
    const { resolver } = await fixture();
    await resolver.registerScript('other-tab', 'http://127.0.0.1:5173/src/Resource.tsx', inline(rawMap()));
    resolver.unregisterScript('script', true);
    expect(resolver.getScriptsForSource(source)).toEqual(['other-tab']);
    expect(resolver.getSourceContent(source)).not.toBeNull();
    resolver.unregisterScript('other-tab', true);
    expect(resolver.getScriptsForSource(source)).toEqual([]);
    expect(resolver.getSourceContent(source)).toBeNull();
  });

  it('reloads evicted map consumers and preserves all column mappings', async () => {
    const resolver = new SourceMapResolver('/workspace', undefined, { maxCachedMaps: 1 });
    resolvers.push(resolver);
    await resolver.registerScript('a', 'http://127.0.0.1:5173/src/Resource.tsx', inline(rawMap()));
    expect(resolver.getGeneratedPositionsForOriginalLine(source, 2)).toHaveLength(2);
    expect(resolver.getGeneratedPositionsForOriginalLine(source, 3)).toEqual([]);
    await resolver.registerScript('b', 'http://127.0.0.1:5173/src/Resource.tsx', inline(rawMap()));
    expect(resolver.isSourceMapLoaded('a')).toBe(false);
    expect(await resolver.originalToGenerated(source, 1, 0, 'a')).toMatchObject({ scriptId: 'a', columnNumber: 4 });
    expect(resolver.isSourceMapLoaded('a')).toBe(true);
  });

  it('decodes a broken immutable map once and recovers when its revision changes', async () => {
    const resolver = new SourceMapResolver('/workspace');
    resolvers.push(resolver);
    const raw = JSON.stringify({ version: 3, sources: [source], names: [], mappings: '' });
    const parser = vi.spyOn(JSON, 'parse');
    try {
      await resolver.registerScript('script', 'http://127.0.0.1:5173/src/Resource.tsx', inline(raw));
      for (let i = 0; i < 10; i++) expect(await resolver.ensureSourceMap('script')).toBe(false);
      expect(parser.mock.calls.filter(([text]) => text === raw)).toHaveLength(1);
      expect(resolver.hasFailedScripts()).toBe(false);
      await resolver.registerScript('script', 'http://127.0.0.1:5173/src/Resource.tsx', inline(rawMap()));
      expect(await resolver.generatedToOriginal('script', 0, 4, false)).toMatchObject({ source, line: 1 });
    } finally { parser.mockRestore(); }
  });

  it('handles malformed mapping data without throwing from breakpoint resolution', async () => {
    const resolver = new SourceMapResolver('/workspace');
    resolvers.push(resolver);
    await resolver.registerScript('broken', 'http://127.0.0.1:5173/src/Resource.tsx', inline(JSON.stringify({
      version: 3, file: source, sources: [source], names: [], mappings: '!',
    })));
    expect(await resolver.generatedToOriginal('broken', 0, 0, false)).toBeNull();
    expect(await resolver.originalToGenerated(source, 1)).toBeNull();
  });

  it('never publishes an old HTTP map after replacement, or deletes the replacement\'s pending load', async () => {
    const requests = new Map<string, http.ServerResponse>();
    const first = deferred<void>();
    const second = deferred<void>();
    const server = http.createServer((request, response) => {
      requests.set(request.url!, response);
      (request.url === '/first.map' ? first : second).resolve();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('net').AddressInfo).port;
    const resolver = new SourceMapResolver('/workspace');
    resolvers.push(resolver);
    const loaded = vi.fn();
    resolver.onSourceMapLoaded = loaded;
    try {
      const old = resolver.registerScript('same', `http://127.0.0.1:${port}/src/Old.tsx`, `http://127.0.0.1:${port}/first.map`);
      await first.promise;
      const fresh = resolver.registerScript('same', `http://127.0.0.1:${port}/src/New.tsx`, `http://127.0.0.1:${port}/second.map`);
      await second.promise;
      requests.get('/first.map')!.end(rawMap(4, '/workspace/src/Old.tsx'));
      await old;
      expect(resolver.isSourceMapLoading('same')).toBe(true);
      expect(resolver.getSourcesForScript('same')).toEqual([]);
      requests.get('/second.map')!.end(rawMap(16, '/workspace/src/New.tsx'));
      await fresh;
      expect(loaded).toHaveBeenCalledTimes(1);
      expect(await resolver.generatedToOriginal('same', 0, 16, false)).toMatchObject({ source: '/workspace/src/New.tsx' });
    } finally {
      for (const response of requests.values()) if (!response.writableEnded) response.end(rawMap());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not resurrect maps, source text, or callbacks after a session clears mid-load', async () => {
    const request = deferred<http.ServerResponse>();
    const server = http.createServer((_request, response) => request.resolve(response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('net').AddressInfo).port;
    const resolver = new SourceMapResolver('/workspace');
    resolvers.push(resolver);
    const loaded = vi.fn();
    resolver.onSourceMapLoaded = loaded;
    try {
      const pending = resolver.registerScript('retired', `http://127.0.0.1:${port}/src/Resource.tsx`, `http://127.0.0.1:${port}/map`);
      const response = await request.promise;
      resolver.clear();
      response.end(rawMap());
      await pending;
      expect(resolver.hasSourceMap('retired')).toBe(false);
      expect(resolver.getScriptsForSource(source)).toEqual([]);
      expect(resolver.getSourceContent(source)).toBeNull();
      expect(loaded).not.toHaveBeenCalled();
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
