/* eslint-disable */
const assert = require('assert');
const vscode = require('vscode');

// Activation is lazy — our extension declares `activationEvents: []`, so it
// activates only when one of its contributed commands / debug types is used.
// We force activation by getting the extension and calling `activate()`.

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
    if (!ext.isActive) {
      await ext.activate();
    }
    assert.strictEqual(ext.isActive, true, 'extension did not activate');
  });

  test('registers the documented commands', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    if (ext && !ext.isActive) await ext.activate();

    const commands = await vscode.commands.getCommands(true);
    const expected = [
      'vite-debugger.startDebug',
      'vite-debugger.detectViteServer',
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
    if (ext && !ext.isActive) await ext.activate();

    // We expect no exception — it either reports "not detected" or shows a
    // dialog; either path is acceptable for the smoke test.
    await vscode.commands.executeCommand('vite-debugger.detectViteServer');
  });
});
