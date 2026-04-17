import * as vscode from 'vscode';
import { ViteDebugSession } from './adapter/ViteDebugSession';
import { detectViteServers } from './vite/ViteServerDetector';
import { isChromeDebuggable } from './cdp/ChromeDiscovery';
import { initLogger, LogLevel } from './util/Logger';
import { ViteInlineValuesProvider } from './providers/InlineValuesProvider';
import { ReactComponentTreeProvider } from './react/ReactComponentTreeProvider';

class ViteDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(
    _session: vscode.DebugSession,
    _executable: vscode.DebugAdapterExecutable | undefined
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
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

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Vite Debugger');
  initLogger(outputChannel, LogLevel.Debug);

  // Register debug adapter factory
  const factory = new ViteDebugAdapterFactory();
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
            description: s.version ? `Vite ${s.version}` : undefined,
          })),
          { placeHolder: 'Select Vite server to debug' }
        );
        if (!picked) return;
        viteUrl = picked.label;
      }

      vscode.debug.startDebugging(
        vscode.workspace.workspaceFolders?.[0],
        {
          type: 'vite',
          request: 'launch',
          name: 'Debug Vite App',
          viteUrl,
          webRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
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
        const items = servers.map(s =>
          `${s.url}${s.version ? ` (Vite ${s.version})` : ''}`
        );
        vscode.window.showInformationMessage(
          `Found ${servers.length} Vite server(s): ${items.join(', ')}`
        );
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
