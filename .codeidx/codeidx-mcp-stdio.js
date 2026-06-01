#!/usr/bin/env node
'use strict';
const cli = "/Users/lky/.vscode/extensions/newdlops.intellij-styled-search-0.1.707/out/codeidxMcpCli.js";
try {
  require(cli);
} catch (err) {
  const message = err && err.stack ? err.stack : String(err);
  process.stderr.write(`[codeidx-mcp] failed to load CLI ${cli}: ${message}\n`);
  process.exitCode = 1;
}
