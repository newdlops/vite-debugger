# Changelog

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
