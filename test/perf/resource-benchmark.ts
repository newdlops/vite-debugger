import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { SourceMapGenerator } from 'source-map';
import { SourceMapResolver } from '../../src/sourcemap/SourceMapResolver';
import { BreakpointManager } from '../../src/breakpoints/BreakpointManager';
import type { CdpClient } from '../../src/cdp/CdpClient';

// A reproducible stress case for the adapter's own work, without Chrome/Vite
// process startup or network latency in the CPU/heap measurements.
const lines = 6000;
const segmentsPerLine = 4;
const scripts = 8;
const breakpointCount = 24;
const samples = 5;

function collect(): void {
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
}

async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-debugger-resource-'));
  const sourcePath = path.join(directory, 'Benchmark.tsx');
  const content = Array.from({ length: lines }, (_, i) => `const value${i} = ${i};`).join('\n');
  fs.writeFileSync(sourcePath, content);
  const map = new SourceMapGenerator({ file: sourcePath });
  map.setSourceContent(sourcePath, content);
  const positions: Array<{ scriptId: string; lineNumber: number; columnNumber: number }> = [];
  for (let line = 1; line <= lines; line++) {
    for (let segment = 0; segment < segmentsPerLine; segment++) {
      const column = ((line - 1) * segmentsPerLine + segment) * 8;
      map.addMapping({
        source: sourcePath,
        original: { line, column: segment * 4 },
        generated: { line: 1, column },
      });
      positions.push({ scriptId: 'script-0', lineNumber: 0, columnNumber: column });
    }
  }
  const mapUrl = 'data:application/json;base64,' + Buffer.from(map.toString()).toString('base64');
  const requests = Array.from({ length: breakpointCount }, (_, i) => ({ line: 1 + i * 200, column: 1 }));
  const results: unknown[] = [];
  for (let sample = 0; sample < samples; sample++) {
    collect();
    const initial = process.memoryUsage();
    const resolver = new SourceMapResolver(directory);
    const loadCpu = process.cpuUsage();
    const loadStart = performance.now();
    for (let script = 0; script < scripts; script++) {
      await resolver.registerScript(`script-${script}`, 'http://127.0.0.1:5173/src/Benchmark.tsx', mapUrl);
    }
    const loadMs = performance.now() - loadStart;
    const loadUsage = process.cpuUsage(loadCpu);
    collect();
    const loaded = process.memoryUsage();
    let queries = 0;
    let handles = 0;
    const cdp = {
      getPossibleBreakpoints: async () => { queries++; return positions; },
      setBreakpointByUrl: async (lineNumber: number, options: { columnNumber: number }) => ({
        breakpointId: `physical-${++handles}`,
        locations: [{ scriptId: 'script-0', lineNumber, columnNumber: options.columnNumber }],
      }),
      removeBreakpoint: async () => undefined,
    } as unknown as CdpClient;
    const manager = new BreakpointManager(cdp, resolver, 'http://127.0.0.1:5173');
    const bpCpu = process.cpuUsage();
    const bpStart = performance.now();
    const breakpoints = await manager.setBreakpoints(sourcePath, requests);
    const breakpointMs = performance.now() - bpStart;
    const bpUsage = process.cpuUsage(bpCpu);
    if (breakpoints.some((bp, i) => !bp.verified || bp.line !== requests[i].line)) {
      throw new Error('Benchmark must preserve every requested breakpoint location');
    }
    collect();
    const bound = process.memoryUsage();
    results.push({
      loadMs, loadCpuMs: (loadUsage.user + loadUsage.system) / 1000,
      loadedHeapBytes: loaded.heapUsed - initial.heapUsed,
      breakpointMs, breakpointCpuMs: (bpUsage.user + bpUsage.system) / 1000,
      boundHeapBytes: bound.heapUsed - initial.heapUsed, cdpQueries: queries,
    });
    await manager.setBreakpoints(sourcePath, []);
    manager.clear();
    resolver.clear();
  }
  fs.unlinkSync(sourcePath);
  fs.rmdirSync(directory);
  process.stdout.write(JSON.stringify({
    node: process.version, platform: `${process.platform}-${process.arch}`,
    workload: { lines, segmentsPerLine, scripts, breakpointCount, samples }, samples: results,
  }, null, 2) + '\n');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
