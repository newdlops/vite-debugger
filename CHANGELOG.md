# Changelog

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
