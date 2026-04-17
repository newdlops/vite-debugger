# Vite Debugger

Debug Vite applications directly in VS Code. Set breakpoints in your `.tsx`/`.ts`/`.vue`/`.svelte` source files and step through them — no browser DevTools needed.

## Features

- **Zero config** — auto-detects running Vite dev server and Chrome debug port
- **Breakpoints** — line, conditional, hit count, and logpoints
- **Smart stepping** — automatically skips Vite-injected code (HMR wrappers, React Refresh)
- **HMR-aware** — breakpoints survive hot module replacement
- **React inspection** — view component props, state, and individual hook values
- **Network breakpoints** — pause on fetch/XHR matching patterns (e.g., `GET /api/users`)
- **Step-in targets** — choose which function call to step into on a line
- **skipFiles** — configure glob patterns to skip files during stepping

## Quick Start

1. Start your Vite dev server (`npm run dev`)
2. Open the Run & Debug panel in VS Code
3. Select **"Attach to Vite App"** or **"Debug Vite App"**
4. Set breakpoints and debug

### launch.json

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      // Attach to an existing Chrome with a running Vite app
      "type": "vite",
      "request": "attach",
      "name": "Attach to Vite App",
      "webRoot": "${workspaceFolder}"
    },
    {
      // Launch a new Chrome window for debugging
      "type": "vite",
      "request": "launch",
      "name": "Debug Vite App",
      "webRoot": "${workspaceFolder}"
    }
  ]
}
```

## Configuration

| Property | Type | Default | Description |
|---|---|---|---|
| `viteUrl` | string | auto-detect | Vite dev server URL |
| `chromePort` | number | `9222` | Chrome remote debugging port |
| `webRoot` | string | `${workspaceFolder}` | Workspace root for source resolution |
| `skipFiles` | string[] | `[]` | Glob patterns for files to skip during stepping |
| `sourceMapPathOverrides` | object | `{}` | Custom source map path mappings |

### skipFiles

Skip files you don't want to step through:

```jsonc
{
  "type": "vite",
  "request": "attach",
  "name": "Attach to Vite App",
  "webRoot": "${workspaceFolder}",
  "skipFiles": [
    "**/styled-components/**",
    "**/node_modules/**"
  ]
}
```

## Network Breakpoints

Use **Function Breakpoints** in VS Code to pause on network requests:

- `GET /api/users` — pause on GET requests matching `/api/users`
- `POST /api/` — pause on any POST to `/api/`
- `/graphql` — pause on any method to `/graphql`
- `status:>=400` — pause on error responses

## How It Works

Vite Debugger connects to Chrome via the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) (CDP) and resolves Vite's on-demand source maps to map between your original source files and the transformed code running in the browser.

```
VS Code  <--DAP-->  Vite Debugger  <--CDP-->  Chrome  <--HTTP-->  Vite Dev Server
```

### Chrome Connection

The debugger finds a debuggable Chrome in this order:

1. Check the specified `chromePort` (default 9222)
2. Auto-discover any Chrome running with `--remote-debugging-port`
3. Launch a new debug Chrome instance (your normal Chrome stays untouched)

## Requirements

- VS Code 1.85+
- Node.js 18+
- A Vite-based project (React, Vue, Svelte, etc.)
- Chrome / Chromium browser

## Known Limitations

- Chrome allows only one debugger connection per tab. See [Chrome Debugging Limitation](docs/chrome-debugging-limitation.md) for details.
- Source maps for dynamically imported modules load on-demand — breakpoints in lazy-loaded files become active when the module is first imported.

## Testing

The repo ships with two layers of regression tests.

**Adapter-level E2E (`vitest`)** — boots a real Vite dev server + headless Chrome and drives `ViteDebugSession` via DAP. Covers launch, breakpoint set/hit/clear, stack/scopes/variables, evaluate, continue, and source-map resolution. No VSCode UI is required.

```sh
npm run test:e2e
```

**VSCode host smoke (`@vscode/test-electron` + mocha)** — launches a real VSCode, loads the extension, and asserts activation + contributed commands.

```sh
npm run test:vscode
```

**Both:**

```sh
npm run test:all
```

Environment variables:

- `VITE_DEBUGGER_TEST_LOG=1` — mirror the extension's internal logger + adapter `OutputEvent`s to stderr during `test:e2e`. Useful when a regression pauses in an unexpected location.

Fixtures live under `test/fixtures/sample-app/` (tiny React + Vite project with a deterministic breakpoint target at `src/math.ts:2`) and `test/vscode-host/fixture-workspace/`.

## License

[MIT](LICENSE)
