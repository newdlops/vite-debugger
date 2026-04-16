# Changelog

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
