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

The Hono adapter stays on its patched 1.x release to retain its Node 18 runtime support. The SDK explicitly accepts this release line. Development and host testing continue to require Node 22.

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

The audit command covers production registry dependencies. Development-tool advisories are separate from this runtime review.
