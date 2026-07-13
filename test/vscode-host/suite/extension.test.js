/* eslint-disable */
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

// The extension normally activates onStartupFinished so every project window
// can publish its own MCP bridge. Tests still activate explicitly to avoid
// depending on host startup timing.

const EXTENSION_ID = 'newdlops.vite-debugger';
const FIXTURE_VITE_PORT = 43991;
const FIXTURE_CHROME_PORT = 49333;

function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const result = await predicate();
        if (result) return resolve(result);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${description}`));
      setTimeout(poll, 50);
    };
    void poll();
  });
}

async function findFixtureBridge(workspaceRoot) {
  const canonicalRoot = fs.realpathSync.native(workspaceRoot);
  return waitFor(() => {
    const directory = path.join(os.tmpdir(), 'vite-debugger-mcp');
    if (!fs.existsSync(directory)) return undefined;
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith('.json')) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        if (manifest.schemaVersion === 1 && Array.isArray(manifest.roots) &&
            manifest.roots.some((root) => fs.realpathSync.native(root) === canonicalRoot)) {
          return manifest;
        }
      } catch {
        // A heartbeat may atomically rotate a manifest while the test scans it.
      }
    }
    return undefined;
  }, 10_000, 'the fixture MCP bridge manifest');
}

function sendBridgeRequests(manifest, requests) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: manifest.port });
    const responses = new Map();
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for MCP bridge start responses'));
    }, 10_000);
    const finish = (error) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(requests.map((request) => responses.get(request.id)));
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      for (const request of requests) {
        socket.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          method: request.method || 'startDebugging',
          params: {
            token: manifest.token,
            workspaceRoot: manifest.roots[0],
            ...(request.method === 'debugStartStatus'
              ? { operationId: request.operationId }
              : request.method === 'listSessions'
                ? {}
              : {
                configurationName: request.configurationName || 'VS Code Host MCP Start',
                operationId: request.operationId,
              }),
          },
        })}\n`);
      }
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const response = JSON.parse(line);
        if (response.error) return finish(new Error(response.error.message));
        responses.set(response.id, response.result);
        if (responses.size === requests.length) return finish();
      }
    });
    socket.on('error', finish);
  });
}

function startFixtureViteServer(workspaceRoot) {
  const sourceMap = Buffer.from(JSON.stringify({
    version: 3,
    file: path.join(workspaceRoot, 'src', 'main.ts'),
    sources: [path.join(workspaceRoot, 'src', 'main.ts')],
    names: [],
    mappings: '',
  })).toString('base64');
  const server = http.createServer((request, response) => {
    if (request.url === '/@vite/client') {
      response.setHeader('content-type', 'application/javascript');
      response.end('const vite = true;');
      return;
    }
    if (request.url === '/src/main.ts') {
      response.setHeader('content-type', 'application/javascript');
      response.end(`export const ready = true;\n//# sourceMappingURL=data:application/json;base64,${sourceMap}`);
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<script type="module" src="/src/main.ts"></script>');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(FIXTURE_VITE_PORT, '127.0.0.1', () => resolve(server));
  });
}

function findChromeExecutable() {
  const candidates = process.platform === 'darwin'
    ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
    : process.platform === 'win32'
      ? [
        path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

async function startFixtureChrome() {
  const executable = findChromeExecutable();
  assert.ok(executable, 'Chrome/Chromium is required for the VS Code host integration test');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-debugger-host-chrome-'));
  const processHandle = childProcess.spawn(executable, [
    '--headless=new',
    `--remote-debugging-port=${FIXTURE_CHROME_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });
  processHandle.once('error', () => {});
  try {
    await waitFor(() => new Promise((resolve) => {
      const request = http.get(
        `http://127.0.0.1:${FIXTURE_CHROME_PORT}/json/version`,
        (response) => {
          response.resume();
          resolve(response.statusCode === 200);
        },
      );
      request.once('error', () => resolve(false));
      request.setTimeout(500, () => {
        request.destroy();
        resolve(false);
      });
    }), 15_000, 'headless Chrome CDP');
    return { processHandle, profile };
  } catch (error) {
    processHandle.kill('SIGTERM');
    fs.rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}

suite('vite-debugger extension (VSCode host)', function () {
  this.timeout(30_000);

  test('is present in the list of installed extensions', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} not found`);
  });

  test('activates without throwing', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'extension missing');
    await ext.activate();
    assert.strictEqual(ext.isActive, true, 'extension did not activate');
  });

  test('registers the documented commands', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    if (ext) await ext.activate();

    const commands = await vscode.commands.getCommands(true);
    const expected = [
      'vite-debugger.startDebug',
      'vite-debugger.detectViteServer',
      'vite-debugger.setupMcpConfiguration',
      'vite-debugger.diagnoseMcp',
      'vite-debugger.copyMcpConfiguration',
      'vite-debugger.refreshReactTree',
      'vite-debugger.breakOnRender',
      'vite-debugger.goToComponent',
    ];
    for (const cmd of expected) {
      assert.ok(commands.includes(cmd), `command not registered: ${cmd}`);
    }
  });

  test('detectViteServer command runs without throwing when no Vite server is up', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    if (ext) await ext.activate();

    // We expect no exception — it either reports "not detected" or shows a
    // dialog; either path is acceptable for the smoke test.
    await vscode.commands.executeCommand('vite-debugger.detectViteServer');
  });

  test('diagnoseMcp verifies the bundled stdio server and project bridge', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    if (ext) await ext.activate();

    const report = await vscode.commands.executeCommand('vite-debugger.diagnoseMcp');
    assert.ok(report, `diagnostic command did not return a report; trusted=${vscode.workspace.isTrusted}; ` +
      `folders=${(vscode.workspace.workspaceFolders || []).map((folder) => `${folder.uri.scheme}:${folder.uri.fsPath}`).join(',')}`);
    assert.ok(!report.error, report.error);
    assert.notStrictEqual(report.summary.status, 'fail', JSON.stringify(report.checks));
    assert.strictEqual(report.tools.length, 21, 'unexpected MCP tool count');
    assert.ok(report.tools.includes('debug_start'));
    assert.ok(report.tools.includes('debug_status'));
    assert.ok(report.tools.includes('browser_trace'));
  });

  test('bridge starts the real folder config once and preserves correlation through preLaunchTask', async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    if (ext) await ext.activate();
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    assert.ok(folder, 'fixture workspace folder missing');

    const markerPath = path.join(folder.uri.fsPath, '.vscode-host-prelaunch-marker');
    fs.rmSync(markerPath, { force: true });
    const viteServer = await startFixtureViteServer(folder.uri.fsPath);
    const chrome = await startFixtureChrome();
    let capturedSession;
    const sessionStarted = new Promise((resolve) => {
      const disposable = vscode.debug.onDidStartDebugSession((session) => {
        if (session.type !== 'vite' || session.name !== 'VS Code Host MCP Start') return;
        capturedSession = session;
        disposable.dispose();
        resolve(session);
      });
    });

    try {
      const manifest = await findFixtureBridge(folder.uri.fsPath);
      const operationId = '87654321-4321-4321-8321-cba987654321';
      const [first, duplicate] = await sendBridgeRequests(manifest, [
        { id: 101, operationId },
        { id: 102, operationId },
      ]);
      assert.strictEqual(first.operationId, operationId, 'bridge did not preserve the caller operation id');
      assert.strictEqual(first.operationId, duplicate.operationId, 'concurrent bridge starts were not coalesced');
      assert.strictEqual(first.configurationName, 'VS Code Host MCP Start');
      assert.strictEqual(first.preLaunchTask, true);

      let session;
      try {
        session = await Promise.race([
          sessionStarted,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Vite session did not start')), 15_000)),
        ]);
      } catch (error) {
        const [startStatus] = await sendBridgeRequests(manifest, [{
          id: 103,
          method: 'debugStartStatus',
          operationId,
        }]);
        const tasks = await vscode.tasks.fetchTasks();
        throw new Error(`${error.message}; bridge=${JSON.stringify(startStatus)}; ` +
          `tasks=${tasks.map((task) => task.name).join(',')}; marker=${fs.existsSync(markerPath)}`);
      }
      assert.strictEqual(session.configuration._viteDebuggerMcpStartId, first.operationId,
        'VS Code stripped the MCP correlation marker');
      assert.strictEqual(session.configuration._viteDebuggerMcpRequireWorkspaceMatch, true,
        'MCP start did not force workspace-root Vite matching for the configured viteUrl');
      assert.strictEqual(session.configuration._viteDebuggerMcpChromePortExplicit, true,
        'MCP start lost the launch configuration\'s explicit Chrome port ownership');
      assert.strictEqual(session.configuration.preLaunchTask, 'vite-debugger:test-prelaunch');

      const adapterStatus = await waitFor(async () => {
        try {
          const status = await session.customRequest('viteDebugger.mcp', {
            method: 'status',
            params: {},
          });
          return status && status.connected === true && Array.isArray(status.targets) &&
            status.targets.length > 0 ? status : undefined;
        } catch {
          // onDidStartDebugSession fires before the adapter has necessarily
          // answered launch; keep polling through that expected transition.
          return undefined;
        }
      }, 15_000, 'the debug adapter connection and managed Chrome page');
      assert.strictEqual(adapterStatus.connected, true);
      assert.strictEqual(adapterStatus.targets.length, 1,
        `expected one managed app target, got ${JSON.stringify(adapterStatus.targets)}`);
      assert.strictEqual(
        new URL(adapterStatus.targets[0].url).origin,
        `http://127.0.0.1:${FIXTURE_VITE_PORT}`,
      );

      await waitFor(() => fs.existsSync(markerPath), 10_000, 'the preLaunchTask marker');
      await new Promise((resolve) => setTimeout(resolve, 500));
      const runs = fs.readFileSync(markerPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      assert.strictEqual(runs.length, 1, `preLaunchTask ran ${runs.length} times`);
    } finally {
      if (capturedSession) await vscode.debug.stopDebugging(capturedSession);
      await new Promise((resolve) => viteServer.close(resolve));
      chrome.processHandle.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 100));
      fs.rmSync(chrome.profile, { recursive: true, force: true });
      fs.rmSync(markerPath, { force: true });
    }
  });

  test('failed adapter initialization is not retained as a reusable bridge session', async function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    if (ext) await ext.activate();
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    assert.ok(folder, 'fixture workspace folder missing');
    const manifest = await findFixtureBridge(folder.uri.fsPath);
    const operationId = '99999999-4321-4321-8321-cba987654321';

    const [started] = await sendBridgeRequests(manifest, [{
      id: 201,
      operationId,
      configurationName: 'VS Code Host MCP Failure',
    }]);
    assert.strictEqual(started.operationId, operationId);

    const terminal = await waitFor(async () => {
      const [status] = await sendBridgeRequests(manifest, [{
        id: 202,
        method: 'debugStartStatus',
        operationId,
      }]);
      return ['declined', 'failed', 'terminated'].includes(status.state) ? status : undefined;
    }, 15_000, 'failed Vite adapter operation');
    assert.ok(['declined', 'failed', 'terminated'].includes(terminal.state));

    await waitFor(async () => {
      const [listed] = await sendBridgeRequests(manifest, [{ id: 203, method: 'listSessions' }]);
      return Array.isArray(listed.sessions) && listed.sessions.length === 0;
    }, 5_000, 'failed Vite session registry cleanup');
  });
});
