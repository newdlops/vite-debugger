# Runtime dependency security

Reviewed on 2026-10-07 for release 0.1.7016. The production registry dependency audit initially reported eight affected packages (one critical, four high, three moderate).

| Package | Previous registry version | Updated version | Product usage |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.29.0 | 1.32.1 | MCP server and diagnostic client use stdio. |
| `smol-toml` | 1.7.0 | 1.9.0 | Parses and merges project agent configuration in the extension. |
| `@hono/node-server` | 1.19.14 | 1.19.17 | SDK HTTP adapter; the product does not start an SDK HTTP server. |
| `fast-uri` | 3.1.3 | 3.1.8 | SDK schema validation. |
| `hono` | 4.12.29 | 4.13.13 | SDK dependency; absent from the original extension and sidecar bundle outputs. |
| `ip-address` | 10.2.0 | 10.7.3 | SDK dependency and Playwright proxy support. |
| `proxy-addr` | 2.0.7 | 2.0.8 | Express dependency; absent from the original extension and sidecar bundle outputs. |
| `qs` | 6.15.3 | 6.16.0 | Express dependency; absent from the original extension and sidecar bundle outputs. |

The Hono adapter stays on its patched 1.x release to retain its Node 18 runtime support. The SDK explicitly accepts this release line. Development and host testing require Node 22.13+ on the 22.x line, Node 24, or Node 26+.

## Reachability

The [SDK credential advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h) concerns OAuth clients over HTTP and excludes stdio clients and MCP servers. Inspection of `src/mcp/server.ts` and `src/mcp/McpDiagnostics.ts` found only stdio transports and no OAuth providers. The project bridge uses its own authenticated loopback socket. This is a code-path assessment, not a claim that every SDK feature is unaffected.

The [TOML EOF-comment advisory](https://github.com/squirrelchat/smol-toml/security/advisories/GHSA-7w5x-hrqm-74c2) and [quadratic parsing advisory](https://github.com/squirrelchat/smol-toml/security/advisories/GHSA-r4xh-jqrq-34v2) apply to the actual configuration parser. Both unfinished-array and unfinished-inline-table probes timed out when run against the previous bundled parser in disposable processes. The updated parser rejects these inputs; a separate bounded probe merges 128,000 flat settings while preserving them.

The [proxy trust advisory](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h) requires proxy trust evaluation. The product does not configure an Express proxy-trust server, and esbuild output contributions showed no `proxy-addr` code in the original extension or sidecar. Its registry dependency is still updated.

## Playwright copies and package verification

`npm audit` does not inspect code already inlined into another package. Playwright 1.61.1 contains additional old SDK 1.29.0, HTTP adapter 1.19.11, URI 3.1.2 and IP 10.2.0 copies in `lib/utilsBundle.js`. Inspection of Playwright 1.63.0 found affected copies there too, so a version-only upgrade would not address them.

`scripts/prepare-runtime.cjs` accepts only the pinned Playwright version and original source SHA-256. It removes those four groups (39 module sections) and binds their entry points to `dist/runtime-dependencies.js`, compiled from the updated installed dependencies. The existing utility export names and SDK export types are verified before the rebuilt bundle is written. Unexpected upstream changes or unsupported dependency versions stop the build.

`scripts/build.cjs` sends the extension and sidecar SDK imports to the same runtime file. The Playwright utilities resolve that file relative to the extension root, so its SDK classes share one module instance with the sidecar. New tests exercise a handshake and tool request through these rebuilt classes, reject ambiguous IPv4 addresses, and check the complete IPv6 link-local range.

Build receipts are packaged at `node_modules/playwright-core/lib/vite-debugger-vendor.json`. They record the original checksum, removed module counts, replacement versions, export names, and output checksums. Original source backups live outside the packaged Playwright directory. Existing license notices are preserved for retained code; updated runtime notices are emitted to `dist/runtime-dependencies.NOTICES.txt`.

Reproduce with:

```sh
npm ci
npm run audit:runtime
npm run test:all
npm run package
```

The runtime audit command covers production registry dependencies.

## Development and test dependencies

Reviewed separately on 2026-10-07. The full registry audit initially reported 18 affected development/test packages: two critical, twelve high, three moderate, and one low.

After a clean `npm ci`, both `npm run audit:all` and `npm run audit:runtime` report zero vulnerabilities. Runtime package versions are unchanged by this development-tool update.

| Tool | Previous installed version | Updated version |
| --- | --- | --- |
| Vitest | 1.6.1 | 5.0.3 |
| Vite | 5.4.21 | 6.4.4 |
| Mocha | 10.8.2 | 12.0.3 |
| esbuild | 0.20.2 | 0.28.2 |
| glob | 11.0.0 | 13.0.6 |
| ESLint | 8.57.1 | 10.12.0 |
| React Vite plugin (Babel) | 4.3.4 | 5.2.0 |
| React Vite plugin (SWC) | 3.7.2 | 4.3.3 |
| Node type definitions | 20.19.39 | 22.20.5 |

Vitest 5 removes the affected Tinypool dependency and includes the fixes for the [Vitest UI advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp). Mocha 12 replaces its old Chokidar/Braces chain and updates the JavaScript serializer. esbuild is updated beyond its [development-server disclosure advisory](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99). Compatible patches also refresh Babel, browser mapping, brace expansion, Browserslist, YAML, Nano ID, PostCSS, and source-map-js in the lockfile.

Vite is now an explicit test dependency. The existing Babel, compact-source-map, and SWC fixture modes remain available. Vitest uses its current [file parallelism](https://vitest.dev/config/fileparallelism.html) and [worker limit](https://vitest.dev/config/maxworkers.html) settings to run files sequentially with isolation. Test typechecking uses the bundler module resolver for modern ESM package exports; the extension's CommonJS/Node build configuration is unchanged.

Run `npm ci`, `npm run audit:all`, `npm run audit:runtime`, `npm run test:all`, and `npm run package` to reproduce the dependency, compatibility, and artifact checks. Registry audit results describe the installed dependency graph at the time of the check; they do not cover arbitrary inlined third-party copies. The separate Playwright verification above continues to cover its replaced runtime copies.

ESLint now uses its native flat configuration and the supported 10.x line. Updating ESLint and glob removes the deprecated 7.x/11.x glob copies, old Rimraf/InFlight chain, and legacy Humanwhocodes config packages. The lockfile contains no deprecated package entries. GitHub Actions performs the full registry audit and existing complete test pipeline on pull requests and `main` pushes.
