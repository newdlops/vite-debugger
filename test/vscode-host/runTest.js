/* eslint-disable */
// Entry for the VSCode host smoke test. Downloads a matching VSCode version
// (once, cached under .vscode-test/), launches it with our fixture workspace
// and extension loaded, and runs the mocha suite under `suite/`.
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');
  const workspacePath = path.resolve(__dirname, 'fixture-workspace');

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspacePath,
        '--disable-extensions',
        '--disable-workspace-trust',
      ],
    });
  } catch (err) {
    console.error('VSCode host test failed:', err);
    process.exit(1);
  }
}

main();
