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
- **Agent debugging** — let Codex or Claude inspect debugger state and drive the same Chrome through MCP + Playwright

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

## Agent debugging with MCP + Playwright

The extension starts a private, authenticated bridge for each VS Code window. A project-scoped MCP sidecar connects to that window's active Vite debug session, while Playwright connects over CDP to the same Chrome. This keeps projects separated when several VS Code windows are open.

```text
Codex / Claude <--stdio MCP--> project sidecar <--private bridge--> VS Code debugger
                                  |
                                  +----Playwright CDP----> debug Chrome
```

Playwright runs in the sidecar, not in the VS Code Extension Host. The VSIX includes `playwright-core`, but does not download or launch another browser; it controls the Chrome already owned by the Vite debug session.

The private bridge and Chrome CDP connection both use loopback. Consequently, the agent-launched MCP sidecar, the Vite Debugger Extension Host, and the debug Chrome must run in the same operating-system environment (the same local host, SSH host, container, or WSL distribution).

### Set up an agent

1. Open the project in its own VS Code window.
2. Run **Vite Debugger: Set Up Agent MCP Automatically** from the Command Palette.
3. Choose Codex, Claude Code, or both. The extension safely creates or updates `.codex/config.toml` and/or `.mcp.json` while preserving unrelated MCP servers and comments.
4. Restart the agent session so it loads the project MCP server. Codex must trust the project before it loads project configuration; Claude Code asks you to approve the project server (you can also inspect it with `/mcp`).
5. Start a Vite debug session, then use the MCP tools from the agent.

A `launch` session guarantees that the detected Vite URL is open in its debug Chrome, even when it reuses a window that previously contained only a new tab. An `attach` session leaves existing tabs untouched. If the managed app tab is later closed, `browser_navigate` reopens it automatically for a same-origin route; pass `openIfMissing=false` when that recovery side effect is not wanted.

Running setup again is safe and refreshes only the Vite Debugger entry. In a multi-root window, setup asks which project to bind; the generated `--workspace` argument routes that agent to the matching VS Code window and debug session. The older **Copy Agent MCP Configuration** command remains available as a manual fallback.

Use **Vite Debugger: Diagnose Agent MCP** at any time (or choose **Diagnose MCP** after setup) to launch the exact stable stdio command and verify the agent configuration, MCP handshake, all 20 tools, private VS Code bridge, and `debug_status` path. The bounded PASS/WARN/FAIL report appears in the Vite Debugger output channel; having no active debug session is reported as a warning rather than a broken MCP installation.

The generated launcher, bridge, and workspace paths are specific to the machine or remote environment in which the Vite Debugger Extension Host is running. Review the files before committing them to source control.

When developing this repository itself, `npm run build` produces `dist/mcp-server.js`, and the checked-in local Codex/Claude configurations already point to it.

The normal agent workflow is:

1. `debug_status`
2. `browser_tabs` if a target must be selected
3. `browser_snapshot`
4. Use a browser action, then `browser_wait_for` when the result is asynchronous
5. If a breakpoint is hit, `debug_snapshot`, then `debug_control`

### MCP tools

The server exposes 20 project-scoped tools:

| Tool | Purpose |
| --- | --- |
| `debug_status` | List/select Vite debug sessions and report targets, pause state, and debugger status. |
| `debug_snapshot` | Read the paused target's reason, bounded call stack, scopes, and variable previews. |
| `debug_control` | Pause, continue, step over/into/out, or reload a managed target. |
| `debug_evaluate` | Evaluate an expression in a paused frame; expressions with possible side effects require `allowSideEffects=true`. |
| `debug_replace_breakpoints` | Atomically replace the agent-owned breakpoints for one source without changing user breakpoints. |
| `browser_tabs` | List the Vite pages available to Playwright and their stable `targetId` values. |
| `browser_snapshot` | Return an AI-oriented accessibility snapshot with refs for later actions. |
| `browser_navigate` | Navigate to a relative route or same-origin URL, reopening the managed Vite page if every app tab was closed. |
| `browser_click` | Click an element selected by snapshot ref, selector, role, text, label, or test id. |
| `browser_fill` | Replace the value of an input-like element. |
| `browser_press` | Press a key or shortcut on an element. |
| `browser_wait_for` | Wait for an element, URL, load state, console message, request, or response, while handing debugger pauses back promptly. |
| `browser_hover` | Hover an element and surface any breakpoint reached by its handlers. |
| `browser_select` | Select one or more values in a `<select>` element. |
| `browser_check` | Set a checkbox or radio control to a requested checked state. |
| `browser_upload` | Set a file input from regular, non-symlink files inside the project (10 files, 10 MiB each, 25 MiB total). |
| `browser_trace` | Explicitly start, inspect, or stop a bounded Playwright trace. |
| `browser_screenshot` | Return a PNG screenshot as MCP image content, up to 8 MiB. |
| `browser_console_messages` | Read bounded console and uncaught page-error history collected by this MCP process. |
| `browser_network_requests` | Read bounded request/response/failure metadata; bodies, cookies, and headers are not captured. |

Browser mutations are rejected while JavaScript is paused, navigation is limited to the Vite app's origin, and browser pages must belong to targets managed by the selected debug session.

### Remote SSH, Dev Containers, and WSL

Vite Debugger is a workspace extension, so a remote VS Code window runs the debugger and bridge in its Remote Extension Host. Automatic setup supports host-backed `file:` and `vscode-remote:` project folders, but the generated command assumes that the agent also starts its MCP process in that same environment.

| Project window | Automatic setup works when... |
| --- | --- |
| Local | The agent, MCP sidecar, Extension Host, and debug Chrome all run locally. |
| Remote SSH | The agent/MCP sidecar and a debuggable Chrome/Chromium run on the SSH host. |
| Dev Container | The agent/MCP sidecar and a debuggable Chrome/Chromium run inside the same container. |
| WSL | The agent/MCP sidecar and a debuggable Chrome/Chromium run inside the same WSL distribution. |
| Local agent with a remote project | Not configured automatically; a separately configured SSH, WSL, or container stdio executor must start the MCP sidecar remotely. |

Run Codex or Claude from the remote terminal/session for the supported remote cases. A desktop-local agent cannot execute the generated remote absolute paths, read the remote bridge manifest, or reach the remote Extension Host and Chrome through its own `127.0.0.1`. Likewise, a Chrome running only on the desktop is not visible to a sidecar inside an SSH host or container. The extension does not expose its private bridge over the network.

The VSIX supplies `playwright-core`, not a Chrome binary. A headless SSH host or container must provide a Chrome/Chromium instance that is reachable through a remote-debugging port in that same environment.

### Playwright traces

Tracing is opt-in. Use `browser_trace` with `action="start"`, `"status"`, and `"stop"`; screenshots and DOM snapshots default to enabled, while source capture defaults to disabled. Playwright traces can contain sensitive DOM contents, entered values, network activity, screenshots, and—when enabled—source files. Review a trace before sharing it.

Tracing operates on the whole Chrome browser context, not just one tab. To prevent unrelated pages from being captured, recording is rejected if that context contains any page outside the managed Vite app; a recording already in progress is invalidated and deleted if a new page opens or a traced page leaves the app. Only one trace can be active in an MCP process, and an un-stopped recording is discarded after five minutes.

A successful stop writes a private zip on the **MCP sidecar's filesystem** under `<system temporary directory>/vite-debugger-traces/<workspace-hash>/`. In Remote SSH, Dev Container, and WSL sessions, that is a remote path; the file is not copied to the desktop automatically. Trace directories/files use private permissions where supported, traces over 100 MiB are deleted, and older/excess traces are pruned on later saves using a ten-file/seven-day policy.

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

- Chrome must be started with a remote-debugging port and a separate debug profile. See [Chrome Debugging Limitation](docs/chrome-debugging-limitation.md) for details.
- Source maps for dynamically imported modules load on-demand — breakpoints in lazy-loaded files become active when the module is first imported.
- Automatic MCP setup does not create a local-to-remote executor. The agent-launched MCP sidecar, Extension Host, and debug Chrome must be co-located as described above.
- Virtual workspaces without a host-accessible filesystem path are not supported by the debugger or MCP setup.
- The VSIX does not include a browser; remote/headless environments must provide a debuggable Chrome or Chromium.

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
