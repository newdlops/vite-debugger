import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ViteDebugSession } from './adapter/ViteDebugSession';
import { detectViteServers, formatViteServerDescription, formatViteServerInfo } from './vite/ViteServerDetector';
import { isChromeDebuggable } from './cdp/ChromeDiscovery';
import { initLogger, logger, LogLevel } from './util/Logger';
import { ViteInlineValuesProvider } from './providers/InlineValuesProvider';
import { ReactComponentTreeProvider } from './react/ReactComponentTreeProvider';
import { BridgeServer } from './mcp/BridgeServer';
import { SessionRegistry } from './mcp/SessionRegistry';
import {
  AgentConfigurationError,
  AgentMcpLaunch,
  CLAUDE_CONFIGURATION_PATH,
  CODEX_CONFIGURATION_PATH,
  ConfigurationChange,
  mergeClaudeConfiguration,
  mergeCodexConfiguration,
  renderCodexMcpBlock,
} from './mcp/AgentConfiguration';
import {
  assertSafeConfigurationParent,
  FileConfigurationUpdate,
  prepareStableMcpLauncher,
  readConfiguration,
  withFileLock,
  writeConfigurationTransaction,
} from './mcp/AgentConfigurationFiles';

class ViteDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  constructor(private readonly sessions: SessionRegistry) {}

  createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    _executable: vscode.DebugAdapterExecutable | undefined
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    this.sessions.register(session);
    return new vscode.DebugAdapterInlineImplementation(new ViteDebugSession());
  }
}

class ViteDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  async resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    _token?: vscode.CancellationToken
  ): Promise<vscode.DebugConfiguration | undefined> {
    // If no config at all (e.g., user pressed F5 with no launch.json), provide defaults
    if (!config.type && !config.request && !config.name) {
      config.type = 'vite';
      config.request = 'launch';
      config.name = 'Debug Vite App';
    }

    if (!config.webRoot && folder) {
      config.webRoot = folder.uri.fsPath;
    }

    return config;
  }
}

let statusBarItem: vscode.StatusBarItem;

type AgentClient = 'codex' | 'claude';

interface PendingConfiguration extends FileConfigurationUpdate {
  client: AgentClient;
  change: ConfigurationChange;
}

interface WorkspaceSelectionOptions {
  noFolderMessage: string;
  placeHolder: string;
}

async function selectLocalWorkspaceFolder(
  options: WorkspaceSelectionOptions,
): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders?.filter((folder) => folder.uri.scheme === 'file') ?? [];
  if (folders.length === 0) {
    vscode.window.showWarningMessage(options.noFolderMessage);
    return undefined;
  }
  if (folders.length === 1) return folders[0];

  const selected = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder,
    })),
    { placeHolder: options.placeHolder },
  );
  return selected?.folder;
}

function pathComparisonKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLocaleLowerCase('en-US')
    : resolved;
}

async function comparisonKeys(filePath: string): Promise<Set<string>> {
  const keys = new Set([pathComparisonKey(filePath)]);
  try { keys.add(pathComparisonKey(await fs.realpath(filePath))); } catch { /* file may not exist yet */ }
  return keys;
}

async function assertConfigurationDocumentIsSaved(filePath: string): Promise<void> {
  const targetKeys = await comparisonKeys(filePath);
  for (const document of vscode.workspace.textDocuments) {
    if (!document.isDirty || document.uri.scheme !== 'file') continue;
    const documentKeys = await comparisonKeys(document.uri.fsPath);
    if ([...documentKeys].some((key) => targetKeys.has(key))) {
      throw new AgentConfigurationError(`Save ${filePath} before running MCP setup.`);
    }
  }
}

function formatConfiguredClients(configurations: readonly PendingConfiguration[]): string {
  const labels = configurations.map((configuration) =>
    configuration.client === 'codex' ? 'Codex' : 'Claude Code');
  return labels.join(' and ');
}

async function prepareMcpLauncher(context: vscode.ExtensionContext): Promise<string> {
  if (context.globalStorageUri.scheme !== 'file') {
    throw new AgentConfigurationError('The stable MCP launcher requires a local extension storage directory.');
  }
  return prepareStableMcpLauncher({
    storagePath: context.globalStorageUri.fsPath,
    bundledServerPath: context.asAbsolutePath('dist/mcp-server.js'),
    version: String(context.extension.packageJSON.version ?? '0.0.0'),
  });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Vite Debugger');
  initLogger(outputChannel, LogLevel.Debug);

  const sessionRegistry = new SessionRegistry();
  const workspaceRoots = () => (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => folder.uri.fsPath);
  const bridge = new BridgeServer(sessionRegistry, workspaceRoots());
  const mcpLauncherPath = prepareMcpLauncher(context);
  void mcpLauncherPath.catch((error) => {
    logger.warn(`Could not prepare stable MCP launcher: ${(error as Error).message}`);
  });
  context.subscriptions.push(sessionRegistry, bridge);
  try {
    await bridge.start();
  } catch (error) {
    // Debugging remains fully usable if the optional local MCP bridge cannot
    // start (for example, because a hardened environment denies loopback).
    logger.warn(`MCP bridge is unavailable: ${(error as Error).message}`);
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      bridge.updateWorkspaceRoots(workspaceRoots());
    }),
  );

  // Register debug adapter factory
  const factory = new ViteDebugAdapterFactory(sessionRegistry);
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('vite', factory)
  );

  // Register debug configuration provider
  const configProvider = new ViteDebugConfigurationProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('vite', configProvider)
  );

  // Register inline values provider
  const inlineProvider = new ViteInlineValuesProvider();
  context.subscriptions.push(
    vscode.languages.registerInlineValuesProvider(
      [
        { language: 'javascript' },
        { language: 'typescript' },
        { language: 'javascriptreact' },
        { language: 'typescriptreact' },
        { language: 'vue' },
        { language: 'svelte' },
      ],
      inlineProvider
    )
  );

  // React Component Tree
  const reactTreeProvider = new ReactComponentTreeProvider();
  const treeView = vscode.window.createTreeView('viteDebugger.reactComponents', {
    treeDataProvider: reactTreeProvider,
    showCollapseAll: true,
  });
  treeView.message = reactTreeProvider.getStatus() ?? undefined;
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    reactTreeProvider.onDidChangeStatus((message) => {
      treeView.message = message ?? undefined;
    }),
    // When the user opens the React panel, refresh so the tree reflects the
    // current page state (it may have rendered after the session started).
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) reactTreeProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vite-debugger.refreshReactTree', () => {
      reactTreeProvider.refresh();
    }),
    vscode.commands.registerCommand('vite-debugger.breakOnRender', (node: any) => {
      if (node && node.filePath && node.line) {
        const uri = vscode.Uri.file(node.filePath);
        const position = new vscode.Position((node.line || 1) - 1, 0);
        const location = new vscode.Location(uri, position);
        vscode.debug.addBreakpoints([
          new vscode.SourceBreakpoint(location, true)
        ]);
        vscode.window.showInformationMessage(`Breakpoint set on <${node.name}> render`);
      } else {
        vscode.window.showWarningMessage(
          `No source location available for <${node?.name ?? 'component'}>. ` +
          `Ensure your Vite config enables JSX source info (default for @vitejs/plugin-react).`
        );
      }
    }),
    vscode.commands.registerCommand('vite-debugger.goToComponent', (node: any) => {
      if (node && node.filePath) {
        const uri = vscode.Uri.file(node.filePath);
        const position = new vscode.Position((node.line || 1) - 1, 0);
        vscode.window.showTextDocument(uri, { selection: new vscode.Range(position, position) });
      }
    })
  );

  // Status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'vite-debugger.startDebug';
  statusBarItem.text = '$(debug) Vite Debug';
  statusBarItem.tooltip = 'Start Vite Debug Session';
  context.subscriptions.push(statusBarItem);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('vite-debugger.startDebug', async () => {
      const folder = await selectLocalWorkspaceFolder({
        noFolderMessage: 'Open a local project folder before starting Vite debugging.',
        placeHolder: 'Select the project to debug',
      });
      if (!folder) return;

      const servers = await detectViteServers();
      if (servers.length === 0) {
        vscode.window.showWarningMessage(
          'No running Vite dev server found. Start Vite with `npm run dev` first.'
        );
        return;
      }

      let viteUrl: string;
      if (servers.length === 1) {
        viteUrl = servers[0].url;
      } else {
        const picked = await vscode.window.showQuickPick(
          servers.map(s => ({
            label: s.url,
            description: formatViteServerDescription(s),
          })),
          { placeHolder: 'Select Vite server to debug' }
        );
        if (!picked) return;
        viteUrl = picked.label;
      }

      vscode.debug.startDebugging(
        folder,
        {
          type: 'vite',
          request: 'launch',
          name: 'Debug Vite App',
          viteUrl,
          webRoot: folder.uri.fsPath,
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vite-debugger.detectViteServer', async () => {
      const servers = await detectViteServers();
      if (servers.length === 0) {
        vscode.window.showInformationMessage('No Vite dev servers detected.');
      } else {
        const items = servers.map(formatViteServerInfo);
        vscode.window.showInformationMessage(
          `Found ${servers.length} Vite server(s): ${items.join(', ')}`
        );
      }
    }),
    vscode.commands.registerCommand('vite-debugger.setupMcpConfiguration', async () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('Trust this workspace before configuring agent MCP.');
        return;
      }

      const folder = await selectLocalWorkspaceFolder({
        noFolderMessage: 'Open a local project folder before configuring agent MCP.',
        placeHolder: 'Select the project for this MCP server',
      });
      if (!folder) return;

      const target = await vscode.window.showQuickPick(
        [
          {
            label: 'Codex + Claude Code',
            description: 'Configure both project files',
            clients: ['codex', 'claude'] as AgentClient[],
          },
          {
            label: 'Codex',
            description: CODEX_CONFIGURATION_PATH,
            clients: ['codex'] as AgentClient[],
          },
          {
            label: 'Claude Code',
            description: CLAUDE_CONFIGURATION_PATH,
            clients: ['claude'] as AgentClient[],
          },
        ],
        { placeHolder: 'Select the agents to configure automatically' },
      );
      if (!target) return;

      try {
        const workspacePath = folder.uri.fsPath;
        const launch: AgentMcpLaunch = {
          launcherPath: await mcpLauncherPath,
          workspacePath,
        };
        const canonicalWorkspace = await fs.realpath(workspacePath).catch(() => path.resolve(workspacePath));
        const lockKey = process.platform === 'win32'
          ? canonicalWorkspace.toLocaleLowerCase('en-US')
          : canonicalWorkspace;
        const setupLock = path.join(
          context.globalStorageUri.fsPath,
          `mcp-setup-${crypto.createHash('sha256').update(lockKey).digest('hex').slice(0, 24)}.lock`,
        );
        const { configurations, changed } = await withFileLock(setupLock, async () => {
          const configurations: PendingConfiguration[] = [];

          if (target.clients.includes('codex')) {
            const filePath = path.join(workspacePath, CODEX_CONFIGURATION_PATH);
            await assertSafeConfigurationParent(filePath, workspacePath);
            await assertConfigurationDocumentIsSaved(filePath);
            const original = await readConfiguration(filePath);
            const merged = mergeCodexConfiguration(original.content, launch);
            configurations.push({
              client: 'codex',
              workspacePath,
              filePath,
              original,
              ...merged,
            });
          }

          if (target.clients.includes('claude')) {
            const filePath = path.join(workspacePath, CLAUDE_CONFIGURATION_PATH);
            await assertSafeConfigurationParent(filePath, workspacePath);
            await assertConfigurationDocumentIsSaved(filePath);
            const original = await readConfiguration(filePath);
            const merged = mergeClaudeConfiguration(original.content, launch);
            configurations.push({
              client: 'claude',
              workspacePath,
              filePath,
              original,
              ...merged,
            });
          }

          const changed = configurations.filter((configuration) => configuration.change !== 'unchanged');
          await writeConfigurationTransaction(changed, {
            assertDocumentSaved: assertConfigurationDocumentIsSaved,
          });
          return { configurations, changed };
        });

        const clients = formatConfiguredClients(configurations);
        const message = changed.length === 0
          ? `${clients} MCP is already configured for ${folder.name}.`
          : `${clients} MCP configured for ${folder.name}. Restart the agent session to load it.`;
        const action = await vscode.window.showInformationMessage(message, 'Open Configuration');
        if (action === 'Open Configuration') {
          let selected = configurations[0];
          if (configurations.length > 1) {
            const picked = await vscode.window.showQuickPick(
              configurations.map((configuration) => ({
                label: configuration.client === 'codex' ? 'Codex' : 'Claude Code',
                description: path.relative(workspacePath, configuration.filePath),
                configuration,
              })),
              { placeHolder: 'Select a configuration to open' },
            );
            if (!picked) return;
            selected = picked.configuration;
          }
          await vscode.window.showTextDocument(vscode.Uri.file(selected.filePath));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Could not configure agent MCP: ${message}`);
        const action = await vscode.window.showErrorMessage(
          `Could not configure agent MCP: ${message}`,
          'Copy Configuration Instead',
        );
        if (action === 'Copy Configuration Instead') {
          await vscode.commands.executeCommand('vite-debugger.copyMcpConfiguration');
        }
      }
    }),
    vscode.commands.registerCommand('vite-debugger.copyMcpConfiguration', async () => {
      const folder = await selectLocalWorkspaceFolder({
        noFolderMessage: 'Open a local project folder before copying agent MCP configuration.',
        placeHolder: 'Select the project for this MCP server',
      });
      if (!folder) return;

      const clients: Array<vscode.QuickPickItem & { format: 'codex' | 'claude' }> = [
        { label: 'Codex', description: '.codex/config.toml', format: 'codex' },
        { label: 'Claude Code', description: '.mcp.json', format: 'claude' },
      ];
      const client = await vscode.window.showQuickPick(
        clients,
        { placeHolder: 'Select the agent configuration format' },
      );
      if (!client) return;

      try {
        const launch: AgentMcpLaunch = {
          launcherPath: await mcpLauncherPath,
          workspacePath: folder.uri.fsPath,
        };
        const configuration = client.format === 'codex'
          ? renderCodexMcpBlock(launch)
          : mergeClaudeConfiguration(undefined, launch).content;

        await vscode.env.clipboard.writeText(configuration);
        vscode.window.showInformationMessage(
          `${client.label} MCP configuration copied. Add it to ${client.description}, then restart the agent.`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Could not prepare MCP configuration: ${message}`);
      }
    })
  );

  // Update status bar and React tree based on debug session state
  let autoRefreshTimer: NodeJS.Timeout | undefined;
  const scheduleAutoRefresh = (delayMs: number) => {
    if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
    autoRefreshTimer = setTimeout(() => reactTreeProvider.refresh(), delayMs);
  };

  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      if (session.type === 'vite') {
        sessionRegistry.register(session);
        statusBarItem.text = '$(debug-stop) Vite Debugging';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.debuggingBackground');
        statusBarItem.show();

        // Use the custom DAP request so values come back by value (not as
        // formatted preview strings from the Variables converter). `cacheKey`
        // lets the session persistently compile big expressions (React walker)
        // so we don't re-parse 6 KB on every refresh.
        reactTreeProvider.setEvaluator(async (expr, cacheKey) => {
          try {
            const result = await session.customRequest('viteDebugger.evalForValue', {
              expression: expr,
              cacheKey,
            });
            return result?.value ?? null;
          } catch {
            return null;
          }
        });

        // The app often mounts shortly after the session attaches. Retry a
        // couple of times so the tree populates once React is ready.
        scheduleAutoRefresh(1500);
        setTimeout(() => reactTreeProvider.refresh(), 4000);
      }
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.type === 'vite') {
        sessionRegistry.unregister(session);
        statusBarItem.text = '$(debug) Vite Debug';
        statusBarItem.backgroundColor = undefined;
        if (autoRefreshTimer) { clearTimeout(autoRefreshTimer); autoRefreshTimer = undefined; }
        reactTreeProvider.clear();
      }
    }),
    vscode.debug.onDidChangeActiveDebugSession(() => {
      if (vscode.debug.activeDebugSession?.type === 'vite') scheduleAutoRefresh(500);
    }),
  );

  // Observe DAP stopped/continued events via a tracker so the tree refreshes
  // at pause points — these are natural sync moments and avoid evaluating in
  // the middle of a render.
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('vite', {
      createDebugAdapterTracker(session) {
        return {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onDidSendMessage(message: any) {
            if (!message || message.type !== 'event') return;
            if (message.event === 'stopped' || message.event === 'continued') {
              if (session.type === 'vite') scheduleAutoRefresh(150);
            }
          },
        };
      },
    }),
  );

  // Show status bar if a Vite server is likely (workspace has vite.config)
  checkForViteProject().then(isVite => {
    if (isVite) statusBarItem.show();
  });
}

async function checkForViteProject(): Promise<boolean> {
  const files = await vscode.workspace.findFiles(
    '{vite.config.ts,vite.config.js,vite.config.mts,vite.config.mjs}',
    '**/node_modules/**',
    1
  );
  return files.length > 0;
}

export function deactivate(): void {
  statusBarItem?.dispose();
}
