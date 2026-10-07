const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const upstreamVersion = '1.61.1';
const upstreamHash = '1295945f0054d2504c9b751945b15aa3c672530ad5a340f3f9636e5e238f304a';
const revision = 1;
const supportedMinimums = {
  '@modelcontextprotocol/sdk': [1, 31, 0],
  '@hono/node-server': [1, 19, 15],
  'ip-address': [10, 7, 1],
  'fast-uri': [3, 1, 8],
};
const replacements = {
  '@modelcontextprotocol/sdk': 'node_modules/@modelcontextprotocol/sdk/dist/',
  '@hono/node-server': 'node_modules/@hono/node-server/',
  'ip-address': 'node_modules/ip-address/',
  'fast-uri': 'node_modules/fast-uri/',
};
const sdkExports = [
  'CallToolRequestSchema', 'Client', 'ListRootsRequestSchema', 'ListToolsRequestSchema',
  'PingRequestSchema', 'ProgressNotificationSchema', 'SSEClientTransport', 'SSEServerTransport',
  'Server', 'StdioClientTransport', 'StdioServerTransport',
  'StreamableHTTPClientTransport', 'StreamableHTTPServerTransport',
];

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function packageInfo(input) {
  let directory = path.dirname(path.resolve(root, input));
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest)) {
      const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (metadata.name && metadata.version) return { directory, ...metadata };
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Cannot identify runtime dependency: ${input}`);
}

function rewriteSource(source) {
  if (digest(source) !== upstreamHash) {
    throw new Error('Unrecognized Playwright utilsBundle source; review the vendor recipe before building.');
  }
  const removed = Object.fromEntries(Object.keys(replacements).map(name => [name, 0]));
  const retained = source.split(/(?=^\/\/ (?:node_modules\/|packages\/))/m).filter(chunk => {
    const header = chunk.split('\n', 1)[0].replace(/^\/\/ /, '');
    const entry = Object.entries(replacements).find(([, prefix]) => header.startsWith(prefix));
    if (!entry) return true;
    removed[entry[0]]++;
    return false;
  }).join('');
  if (Object.values(removed).some(count => count === 0)) throw new Error('Incomplete Playwright vendor replacement');
  const injection = [
    'var __viteRuntime = require("../../../dist/runtime-dependencies.js");',
    ...sdkExports.map(name => `var ${name} = __viteRuntime.${name};`),
    'var require_ip_address = () => __viteRuntime.ipAddress;',
    'var require_fast_uri = () => __viteRuntime.fastUri;',
    '',
  ].join('\n');
  // This checksum-locked helper only creates lazy CommonJS factories. Marking
  // those allocations pure lets esbuild discard the removed SDK's unused deps.
  const content = injection + retained.replace(/\b__commonJS\(\{/g, '/* @__PURE__ */ __commonJS({');
  return { content, removed };
}

function runtimeNotices(packages) {
  return Object.values(packages).sort((a, b) => a.name.localeCompare(b.name)).map(info => {
    const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']
      .map(name => path.join(info.directory, name)).find(file => fs.existsSync(file));
    if (!license) throw new Error(`Missing license for runtime dependency ${info.name}@${info.version}`);
    return `${info.name}@${info.version}\n${fs.readFileSync(license, 'utf8').trim()}\n`;
  }).join('\n');
}

function prepareRuntime() {
  const playwright = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/playwright-core/package.json'), 'utf8'));
  if (playwright.version !== upstreamVersion) throw new Error('Unsupported Playwright version; review the vendor recipe.');
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const runtime = buildSync({
    entryPoints: [path.join(__dirname, 'runtime-dependencies.mjs')],
    outfile: path.join(root, 'dist/runtime-dependencies.js'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node18',
    sourcemap: true, metafile: true, logLevel: 'silent',
  });
  const packages = {};
  const runtimeOutput = Object.values(runtime.metafile.outputs).find(output => output.entryPoint);
  for (const [input, contribution] of Object.entries(runtimeOutput.inputs)) {
    if (!input.includes('node_modules/') || contribution.bytesInOutput === 0) continue;
    const info = packageInfo(input);
    packages[`${info.name}@${info.version}`] = info;
  }
  for (const name of Object.keys(replacements)) {
    if (!Object.values(packages).some(info => info.name === name)) throw new Error(`Missing patched dependency: ${name}`);
  }
  fs.writeFileSync(path.join(root, 'dist/runtime-dependencies.NOTICES.txt'), runtimeNotices(packages));
  const versions = Object.fromEntries(Object.keys(replacements).map(name => {
    const info = Object.values(packages).find(info => info.name === name);
    return [name, info.version];
  }));
  for (const [name, version] of Object.entries(versions)) {
    const current = /^\d+\.\d+\.\d+$/.test(version) && version.split('.').map(Number);
    const minimum = supportedMinimums[name];
    const older = current && (current[1] < minimum[1] || (current[1] === minimum[1] && current[2] < minimum[2]));
    if (!current || current[0] !== minimum[0] || older) {
      throw new Error(`Unsafe or unsupported runtime dependency: ${name}@${version}`);
    }
  }

  const directory = path.join(root, 'node_modules/playwright-core/lib');
  const bundlePath = path.join(directory, 'utilsBundle.js');
  const recordPath = path.join(directory, 'vite-debugger-vendor.json');
  const cache = path.join(root, 'node_modules/.cache/vite-debugger-playwright');
  const originalPath = path.join(cache, 'utilsBundle.js');
  const noticePath = path.join(cache, 'utilsBundle.js.LICENSE');
  const source = fs.readFileSync(bundlePath, 'utf8');
  if (digest(source) === upstreamHash) {
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(originalPath, source);
    fs.copyFileSync(path.join(directory, 'utilsBundle.js.LICENSE'), noticePath);
  } else {
    const record = fs.existsSync(recordPath) && JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    if (!record || record.bundleSha256 !== digest(source) || record.upstreamSha256 !== upstreamHash) {
      throw new Error('Playwright vendor bundle changed outside the verified build recipe.');
    }
  }
  const original = fs.readFileSync(originalPath, 'utf8');
  const rewritten = rewriteSource(original);
  const vendor = buildSync({
    stdin: { contents: rewritten.content, resolveDir: directory, sourcefile: 'utilsBundle.vendor-source.js' },
    outfile: bundlePath, bundle: true, platform: 'node', format: 'cjs', target: 'node18',
    external: ['../../../dist/runtime-dependencies.js', 'fsevents', 'pnpapi'],
    write: false, logLevel: 'silent',
  }).outputFiles[0].contents;
  const probe = new Module(bundlePath, module);
  probe.filename = bundlePath;
  probe.paths = Module._nodeModulePaths(directory);
  probe._compile(Buffer.from(vendor).toString('utf8'), bundlePath);
  // The immutable original defines the public utilities contract. Parse its
  // export table instead of loading its old SDK into the build process.
  const table = original.match(/__export\(utilsBundle_exports, \{([\s\S]*?)\n\}\);/);
  if (!table) throw new Error('Playwright utility export table was not found');
  const expected = [...table[1].matchAll(/^  (\w+):/gm)].map(match => match[1]).sort();
  if (JSON.stringify(Object.keys(probe.exports).sort()) !== JSON.stringify(expected)) {
    throw new Error('Playwright utility exports changed during the vendor rebuild');
  }
  for (const name of sdkExports) {
    const schema = name.endsWith('Schema');
    if (schema ? typeof probe.exports[name]?.safeParse !== 'function' : typeof probe.exports[name] !== 'function') {
      throw new Error(`Invalid patched Playwright export: ${name}`);
    }
  }
  fs.writeFileSync(bundlePath, vendor);
  const originalNotices = fs.readFileSync(noticePath, 'utf8');
  const escaped = Object.keys(replacements).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const preserved = originalNotices
    .replace(new RegExp(`^- (?:${escaped})@[^\\n]*\\n`, 'gm'), '')
    .replace(new RegExp(`^%% ((?:${escaped})@[^\\n ]+) NOTICES AND INFORMATION BEGIN HERE[\\s\\S]*?^END OF \\1 NOTICES AND INFORMATION\\s*`, 'gm'), '');
  fs.writeFileSync(path.join(directory, 'utilsBundle.js.LICENSE'), preserved +
    '\nVite Debugger replaces the SDK, HTTP adapter, IP and URI code with the shared patched runtime.\n' +
    'See extension/dist/runtime-dependencies.NOTICES.txt for the exact versions and their license notices.\n');
  const record = {
    revision, playwrightVersion: upstreamVersion, upstreamSha256: upstreamHash,
    replacements: versions, removedModules: rewritten.removed,
    exports: expected, bundleSha256: digest(vendor),
    runtimeSha256: digest(fs.readFileSync(path.join(root, 'dist/runtime-dependencies.js'))),
  };
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
  console.log(`Patched Playwright ${upstreamVersion}: ${expected.length} exports; shared runtime ${JSON.stringify(versions)}`);
  return record;
}

module.exports = { prepareRuntime, rewriteSource };
if (require.main === module) {
  try { prepareRuntime(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
