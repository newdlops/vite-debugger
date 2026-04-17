/* eslint-disable */
// Mocha entry for the in-VSCode tests. Called by runTests() with the extension
// already activated (or activating). Discovers *.test.js files in this folder.
const path = require('path');
const Mocha = require('mocha');
const { glob } = require('glob');

async function run() {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 30_000 });
  const testsRoot = __dirname;

  const files = await glob('**/*.test.js', { cwd: testsRoot });
  for (const f of files) mocha.addFile(path.resolve(testsRoot, f));

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} test(s) failed.`));
        else resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { run };
