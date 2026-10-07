const path = require('path');
const { build, context } = require('esbuild');

const root = path.resolve(__dirname, '..');
require('./prepare-runtime.cjs').prepareRuntime();
const component = process.argv[2];
if (!['extension', 'mcp'].includes(component)) throw new Error('Choose extension or mcp');
const extra = process.argv.slice(3);
const watch = extra.includes('--watch');
const metafilePath = extra.find(value => value.startsWith('--metafile='))?.slice('--metafile='.length);
if (extra.some(value => value !== '--watch' && !value.startsWith('--metafile='))) throw new Error('Unsupported build argument');
const sdkEntrypoints = new Set([
  '@modelcontextprotocol/sdk/client/index.js',
  '@modelcontextprotocol/sdk/client/stdio.js',
  '@modelcontextprotocol/sdk/server/mcp.js',
  '@modelcontextprotocol/sdk/server/stdio.js',
]);
const options = {
  entryPoints: [path.join(root, component === 'extension' ? 'src/extension.ts' : 'src/mcp/server.ts')],
  outfile: path.join(root, component === 'extension' ? 'dist/extension.js' : 'dist/mcp-server.js'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node18', sourcemap: true,
  external: component === 'extension' ? ['vscode'] : ['playwright-core'],
  metafile: !!metafilePath,
  plugins: [{
    name: 'shared-mcp-runtime',
    setup(builder) {
      builder.onResolve({ filter: /^@modelcontextprotocol\/sdk\// }, args => {
        if (!sdkEntrypoints.has(args.path)) throw new Error(`Add this SDK entrypoint to the shared runtime before building: ${args.path}`);
        return { path: './runtime-dependencies.js', external: true };
      });
      if (metafilePath) builder.onEnd(result => {
        if (result.metafile) require('fs').writeFileSync(metafilePath, JSON.stringify(result.metafile));
      });
    },
  }],
};
(async () => {
  if (watch) await (await context(options)).watch();
  else await build(options);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
