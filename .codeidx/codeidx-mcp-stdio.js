#!/usr/bin/env node
'use strict';
const path = require('path');
const cli = "/Users/lky/.vscode/extensions/newdlops.intellij-styled-search-0.1.711/out/codeidxMcpCli.js";
const workspaceRoot = path.resolve(__dirname, '..');
function argIndex(names) {
  return process.argv.findIndex((arg, index) => index >= 2 && names.some((name) => arg === name || arg.startsWith(name + "=")));
}
function inlineValue(arg) {
  const index = arg.indexOf("=");
  return index === -1 ? undefined : arg.slice(index + 1);
}
const workspaceIndex = argIndex(["--workspace", "-w"]);
if (workspaceIndex >= 0) {
  const arg = process.argv[workspaceIndex];
  const value = inlineValue(arg);
  if (value === ".") {
    process.argv[workspaceIndex] = arg.slice(0, arg.indexOf("=") + 1) + workspaceRoot;
  } else if (value === undefined && process.argv[workspaceIndex + 1] === ".") {
    process.argv[workspaceIndex + 1] = workspaceRoot;
  }
} else if (argIndex(["--url", "--port", "--discovery-file"]) < 0) {
  process.argv.push("--workspace", workspaceRoot);
}
try {
  require(cli);
} catch (err) {
  const message = err && err.stack ? err.stack : String(err);
  process.stderr.write(`[codeidx-mcp] failed to load CLI ${cli}: ${message}\n`);
  process.exitCode = 1;
}
