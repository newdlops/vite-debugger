# Changelog

## 0.1.7013 (2026-07-13)

### Fixed

- **HTTPS source maps** — loads external maps through the correct HTTP(S) transport. Self-signed certificates are accepted only after exclusive-loopback DNS verification and an IP-pinned retry; optimized dependency-map failures no longer create a retry storm.
- **Fast pause snapshots** — resolves call-stack frames concurrently and does not start slow dependency source-map fetches while publishing a pause, so agents receive the mapped user frame without waiting on library maps.
- **Zombie start cleanup** — publishes the MCP bridge only after every debug lifecycle hook is installed, releases a failed adapter's single-flight reservation immediately, and stops only the correlated session when readiness times out; a still-running `preLaunchTask` remains single-flight instead of being duplicated.
- **Project-owned launch Chrome** — agent launches no longer attach to transient Lighthouse/headless ports. Each project gets an opaque persistent Chrome profile and an OS-leased debug port, reused only when its `DevToolsActivePort` browser identity still matches.
- **Strict inherited launch settings** — MCP-started workspace configurations always enforce Vite-root matching, validate inherited application URLs as loopback-only, distinguish an explicit Chrome port from the schema default, and recheck configuration/URL conflicts after start races.

## 0.1.7012 (2026-07-13)

### Fixed

- **Direct agent launch for ambiguous projects** — `debug_start` accepts an optional local `viteUrl`, so an agent can select an already-running server such as `https://alphac:3004` without a Run and Debug click or a hand-written Vite launch configuration.
- **Separate module and browser origins** — `debug_start` and launch configurations accept `pageUrl` for backend-rendered/middleware apps, while source mapping stays on `viteUrl` and CDP/Playwright page isolation follows the application origin.
- **Non-root Vite documents** — recognizes projects that return 404 at `/` but serve a transformed app at `/index.html`; raw public/backend templates without a Vite or module bootstrap are no longer opened as false-ready blank pages.
- **Vite HTML negotiation** — page discovery sends a browser-style HTML `Accept` header, so SPA fallback and `createHtmlPlugin` middleware transform `/` instead of returning a misleading 404 or raw public template.
- **Modern source-map root discovery** — recovers a project root when transformed Vite/SWC output omits the source map `file` field, using validated absolute source metadata or generated `fileName` paths.
- **Failed-session cleanup** — launch/attach failures immediately evict and stop their correlated VS Code session, so a rejected adapter cannot remain as a zombie that later returns `No debugger available`.

### Security

- Agent-supplied `viteUrl` and `pageUrl` values must resolve exclusively to loopback. Vite detection pins every strict probe (including metadata requests) against DNS rebinding; credentials, external addresses, unsafe URL components, and cross-project servers are rejected.

## 0.1.7010 (2026-07-13)

### Added

- **Agent-started debugging** — adds `debug_start`, allowing Codex or Claude to start or reuse the project-scoped Vite debug session through the matching VS Code Extension Host without clicking Run and Debug.
- **Launch readiness** — waits for the adapter to connect and, for launch configurations, for the managed Vite browser target; long-running background `preLaunchTask` starts return an explicit starting state instead of encouraging duplicate sessions.
- **Reliable start lifecycle** — reports VS Code decline, adapter failure/termination, and closed-tab recovery; caller-generated operation IDs make transport retries and concurrent calls idempotent.
- **Project-scoped HTTP/HTTPS discovery** — matches a unique Vite source root below `webRoot`, restores forward-verified loopback aliases such as `alphac`, and supports local self-signed HTTPS detection with an MCP certificate warning.

### Security

- Only trusted workspaces and exact bridge-scoped workspace folders may start debugging. The agent can select only existing `type: "vite"` launch/attach configurations by name and cannot inject a raw task, command, environment, URL, or workspace path.
- User-authored Vite configurations are cloned after validation and started with dirty-editor autosave suppressed. When no Vite configuration exists, the fallback is a task-free generated launch that requires an already-running Vite server.
- Automatic server selection fails closed on unmatched or ambiguous project roots. Explicit URLs never fall back to a different process, and certificate relaxation is request-local, DNS-verified, and pinned to an exclusively loopback address; Chrome's global certificate checks remain enabled.

## 0.1.7009 (2026-07-13)

### Fixed

- **Reliable launch target** — `launch` now opens the exact detected Vite URL when it reuses a debuggable Chrome that contains only a new tab or unrelated pages, and waits until the page is managed before completing startup. `attach` continues to preserve existing browser state.
- **Closed-tab recovery** — `browser_navigate` reopens a missing managed Vite page through the debug adapter, reports whether it created the target, and uses a single-flight guard so concurrent recovery cannot create duplicate tabs.
- **Virtual loopback origins** — Chrome discovery, debugger target filtering, and Playwright same-origin checks now consistently recognize every `127/8` address alongside `localhost`, `127.0.0.1`, and IPv6 loopback without weakening protocol or port checks.
- **Actionable diagnostics** — a connected debugger with no managed Vite targets is now reported as a warning instead of a successful browser-ready state.

### Security

- Cross-origin navigation and stale explicit target requests are rejected before closed-tab recovery can create a page. Page recovery is also blocked while JavaScript is paused or a Playwright trace is active.

## 0.1.7008 (2026-07-13)

### Added

- **20 MCP tools** — adds paused-frame `debug_evaluate`, condition-aware `browser_wait_for`, hover, select, check/uncheck, workspace-bounded file upload, and explicit Playwright trace recording to the existing debugger and browser toolset.
- **MCP diagnostics** — a Command Palette action launches the exact configured stdio server and checks its handshake, complete tool surface, project bridge, debugger status, and agent configuration with bounded PASS/WARN/FAIL output.
- **Co-located remote execution** — Remote SSH, Dev Container, and WSL project folders can be configured when the agent-launched MCP sidecar, Vite Debugger Extension Host, and debug Chrome all run in that same environment.

### Security

- Passes the exact private bridge directory to the sidecar, restricts uploads to bounded regular non-symlink project files, blocks side-effecting evaluation unless explicitly allowed, and rejects trace recording when the Chrome context includes an unmanaged page.
- Invalidates and deletes an in-progress trace if its context opens a new page or navigates outside the managed Vite app.
- Bounds traces to five minutes and 100 MiB, stores them with private permissions in a workspace-hashed temporary directory on the sidecar host, and prunes older artifacts.
- MCP diagnostics use a shell-free child process, a shared deadline, bounded/redacted stderr, and guaranteed transport cleanup.

### Remote execution notes

- Automatic setup does not configure a desktop-local agent to enter an SSH host, container, or WSL distribution. Such agents require a separately configured remote stdio executor.
- `playwright-core` does not include Chrome. Remote environments must provide a debuggable Chrome/Chromium in the same environment; trace paths returned from remote MCP processes also remain remote and may contain sensitive DOM, network, screenshot, or source data.

## 0.1.7007 (2026-07-13)

### Added

- **Automatic agent MCP setup** — a Command Palette action now creates or updates project-scoped Codex and Claude Code MCP configuration, with a combined setup option for both agents.
- **Safe configuration merging** — preserves unrelated MCP servers, JSONC comments, indentation, and line endings; repeated setup is idempotent.

### Security

- Refuses untrusted workspaces, symbolic-link configuration targets, dirty editor buffers, oversized files, and malformed configuration; files are rechecked immediately before commit.
- Uses cross-window setup locks, a version-guarded stable launcher, atomic same-directory writes, and rollback if the combined Codex/Claude update fails.

## 0.1.7006 (2026-07-12)

### Added

- **Agent MCP server** — project/window-scoped debugger status, pause snapshots, execution control, and agent-owned source breakpoints for Codex and Claude.
- **Playwright browser control** — ARIA snapshots and refs, click/fill/press/navigation, screenshots, and bounded console/network history over the debug session's existing Chrome CDP port.
- **MCP setup command** — copies project-specific Codex or Claude Code configuration from the Command Palette.

### Security

- Authenticated loopback bridge with private per-window manifests and exact workspace/session routing.
- Same-origin navigation, managed Vite-target allowlisting, paused-page mutation guards, bounded output, and credential redaction.
- Agent/project configuration and bridge credentials are excluded from VSIX packages.

## 0.1.4 (2026-04-17)

### Fixed

- **Debug UI stuck on pause** — breakpoints paused Chrome but VS Code never activated its debug UI (no stop-line arrow, step buttons disabled). `detectReactComponent` used `Runtime.evaluate` with `awaitPromise: true`, which hangs while the debugger is paused — `onPaused` never reached `StoppedEvent`. Now uses `Debugger.evaluateOnCallFrame` (paused-context safe), with an 800 ms timeout as a safety net so React detection can never block the stop event.

### Performance

- **Call-frame resolution**: original-position lookups run in parallel instead of serially per frame.
- **Breakpoint resolution on HMR / scriptParsed**: pipeline remove/re-set across all affected breakpoints in one `Promise.all` (was ~3×N CDP round-trips serialized).
- **Source-map cache**: LRU switched to intrusive doubly-linked list — `set()` past capacity is O(1) instead of O(n) linear scan. Capacity raised 200 → 500.
- **`originalToGenerated`**: pre-computes `resolved-path → source-name` at map-load time — O(1) lookup instead of an `eachMapping` scan per call.
- **React component tree walker**: expression (~6 KB) compiled once via `Runtime.compileScript` and reused — was re-parsed on every refresh.
- **Chrome discovery**: candidate ports probed in parallel. Launch uses exponential backoff (100 ms → 1 s, 15 s ceiling) instead of fixed 500 ms × 40.
- **Vite server detection**: `localhost` and `127.0.0.1` probed in parallel; entry-point fallback probes all candidates concurrently.
- **`loadedSources` / `scriptParsed`**: async `fs.stat` via a shared bounded `fileExistsCache` — no more sync stats blocking the event loop on large projects.
- **`skipFiles` globs**: precompiled to regex once at launch instead of per-step.

### Other

- **HMR URL normalization**: Vite's `?v=<hash>` / `?t=<ts>` cache-busters are stripped so the same logical file is recognized across HMR reloads (stale scriptId cleanup).
- **Smart-step logging**: only logs at step #1 and every 5th — was spamming on React internal loops.

## 0.1.0 (2026-04-16)

Initial release.

### Features

- **Auto-detect Vite dev server** — no manual URL configuration needed
- **Attach to Chrome** or **launch a debug Chrome** automatically
- **Source map resolution** for Vite's on-demand transformed modules
  - Retry logic for transient source map fetch failures
  - Lazy loading with eager background fetch
- **Breakpoints** — line, conditional, hit count, and logpoints
  - Pending breakpoints resolve automatically when scripts load
  - Accurate position via CDP `getPossibleBreakpoints` refinement
- **Smart stepping** — auto-skip Vite-injected code (`_s()`, `$RefreshSig$`, HMR wrappers)
- **skipFiles** — user-configurable glob patterns to skip files during stepping
- **HMR support** — breakpoints survive hot module replacement
- **React component inspection** — view props, state, and hooks in the Variables panel
  - Supports function components (via React DevTools hook) and class components
  - Individual hook values (useState, useRef, useMemo, etc.)
- **React component tree** — sidebar panel showing the component hierarchy
- **Network breakpoints** — pause on fetch/XHR matching URL or method patterns
- **Step-in targets** — choose which function call to step into on a line
- **Console output** — forwarded with original source locations
- **Loaded Sources** — browse all scripts loaded by the page
- **Library code blackboxing** — node_modules, @vite, @react-refresh auto-blackboxed
- **Inline values** — (experimental) show variable values inline during debugging
