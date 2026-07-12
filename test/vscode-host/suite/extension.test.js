/* eslint-disable */
const assert = require('assert');
const vscode = require('vscode');

// The extension normally activates onStartupFinished so every project window
// can publish its own MCP bridge. Tests still activate explicitly to avoid
// depending on host startup timing.

const EXTENSION_ID = 'newdlops.vite-debugger';

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
    assert.strictEqual(report.tools.length, 20, 'unexpected MCP tool count');
    assert.ok(report.tools.includes('debug_status'));
    assert.ok(report.tools.includes('browser_trace'));
  });
});
