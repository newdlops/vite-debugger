import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeClient } from './BridgeClient';
import { registerMcpTools } from './tools';

const SERVER_VERSION = '0.1.7013';

export function createMcpServer(bridge: BridgeClient): McpServer {
  const server = new McpServer({
    name: 'vite-debugger',
    version: SERVER_VERSION,
  }, {
    instructions:
      'This server is bound to one VS Code project window. Begin with debug_status; if no session is active, call debug_start. ' +
      'If multiple running Vite services share the project sources, pass their local origin as debug_start viteUrl. ' +
      'If a backend renders the browser page on another local origin, also pass that full route as debug_start pageUrl. ' +
      'When more than one session or browser target exists, pass the returned sessionId and targetId explicitly. ' +
      'browser_navigate can reopen the project Vite page when every managed tab was closed. ' +
      'When paused, use debug_snapshot and debug_control; browser mutation tools are intentionally blocked until resume. ' +
      'Use browser_snapshot refs for reliable browser actions.',
  });
  const tools = registerMcpTools(server, bridge);
  const closeTransport = server.close.bind(server);
  let closing: Promise<void> | undefined;
  server.close = () => {
    closing ??= (async () => {
      try {
        await tools.dispose();
      } finally {
        await closeTransport();
      }
    })();
    return closing;
  };
  return server;
}

export async function runMcpServer(argv = process.argv.slice(2)): Promise<void> {
  const workspace = BridgeClient.workspaceFromArgv(argv);
  const bridgeDirectory = BridgeClient.bridgeDirectoryFromArgv(argv);
  const bridge = await BridgeClient.forWorkspace(workspace, bridgeDirectory);
  const server = createMcpServer(bridge);
  const transport = new StdioServerTransport();

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    bridge.close();
    await server.close().catch((error) => logError('Failed to close MCP server', error));
  };

  process.once('SIGINT', () => void close().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void close().finally(() => process.exit(0)));
  process.stdin.once('end', () => void close());
  process.once('exit', () => bridge.close());

  await server.connect(transport);
}

function logError(message: string, error: unknown): void {
  // stdout is exclusively owned by StdioServerTransport.
  process.stderr.write(`[vite-debugger-mcp] ${message}: ${errorMessage(error)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

if (require.main === module) {
  runMcpServer().catch((error) => {
    logError('Startup failed', error);
    process.exitCode = 1;
  });
}
