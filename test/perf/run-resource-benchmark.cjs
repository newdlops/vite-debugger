const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildSync } = require('esbuild');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-debugger-bench-build-'));
const output = path.join(directory, 'benchmark.cjs');
try {
  const sourceMapModule = require.resolve('source-map');
  buildSync({
    entryPoints: [path.join(__dirname, 'resource-benchmark.ts')],
    outfile: output, bundle: true, platform: 'node', format: 'cjs',
    alias: { 'source-map': sourceMapModule }, external: [sourceMapModule],
    logLevel: 'silent',
  });
  const result = spawnSync(process.execPath, ['--expose-gc', output], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  if (fs.existsSync(output)) fs.unlinkSync(output);
  fs.rmdirSync(directory);
}
