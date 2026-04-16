import * as vscode from 'vscode';

export interface ReactComponentNode {
  name: string;
  filePath?: string;
  line?: number;
  children: ReactComponentNode[];
  fiberType: 'function' | 'class' | 'host' | 'other';
}

export class ReactComponentTreeProvider implements vscode.TreeDataProvider<ReactComponentNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ReactComponentNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: ReactComponentNode[] = [];
  private evaluator: ((expression: string) => Promise<any>) | null = null;

  setEvaluator(evaluator: ((expression: string) => Promise<any>) | null): void {
    this.evaluator = evaluator;
  }

  async refresh(): Promise<void> {
    if (!this.evaluator) {
      this.roots = [];
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    try {
      const result = await this.evaluator(`
        (() => {
          const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
          if (!hook || !hook.getFiberRoots) return null;

          function walkFiber(fiber, depth) {
            if (!fiber || depth > 50) return null;

            const node = { children: [] };

            if (fiber.type) {
              if (typeof fiber.type === 'function') {
                node.name = fiber.type.displayName || fiber.type.name || 'Anonymous';
                node.fiberType = fiber.type.prototype && fiber.type.prototype.isReactComponent ? 'class' : 'function';
                const src = fiber._debugSource;
                if (src) {
                  node.filePath = src.fileName;
                  node.line = src.lineNumber;
                }
              } else if (typeof fiber.type === 'string') {
                node.name = fiber.type;
                node.fiberType = 'host';
              } else {
                node.name = fiber.type.displayName || fiber.type.name || '?';
                node.fiberType = 'other';
              }
            } else {
              node.name = 'Fragment';
              node.fiberType = 'other';
            }

            // Walk children
            let child = fiber.child;
            while (child) {
              const childNode = walkFiber(child, depth + 1);
              if (childNode) {
                // Skip host elements and fragments in tree — include only components
                if (childNode.fiberType === 'function' || childNode.fiberType === 'class') {
                  node.children.push(childNode);
                } else {
                  // Hoist grandchildren
                  node.children.push(...childNode.children);
                }
              }
              child = child.sibling;
            }

            return node;
          }

          const roots = [];
          for (const [, rootSet] of hook.getFiberRoots ? [] : []) {}
          // Try renderers approach
          for (const [id, renderer] of hook.renderers || []) {
            const fiberRoots = hook.getFiberRoots ? hook.getFiberRoots(id) : null;
            if (fiberRoots) {
              for (const root of fiberRoots) {
                const tree = walkFiber(root.current, 0);
                if (tree) roots.push(...tree.children);
              }
            }
          }
          return roots.length > 0 ? roots : null;
        })()
      `);

      if (result && Array.isArray(result)) {
        this.roots = result;
      } else {
        this.roots = [];
      }
    } catch (e) {
      this.roots = [];
    }

    this._onDidChangeTreeData.fire(undefined);
  }

  clear(): void {
    this.roots = [];
    this.evaluator = null;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ReactComponentNode): vscode.TreeItem {
    const hasChildren = element.children.length > 0;
    const item = new vscode.TreeItem(
      `<${element.name}>`,
      hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );

    item.contextValue = (element.fiberType === 'function' || element.fiberType === 'class')
      ? 'reactComponent' : 'reactElement';

    if (element.filePath) {
      item.description = `${element.filePath.split('/').pop()}:${element.line ?? '?'}`;
      item.tooltip = `${element.filePath}:${element.line ?? '?'}`;
    }

    // Icon based on type
    if (element.fiberType === 'class') {
      item.iconPath = new vscode.ThemeIcon('symbol-class');
    } else if (element.fiberType === 'function') {
      item.iconPath = new vscode.ThemeIcon('symbol-function');
    }

    return item;
  }

  getChildren(element?: ReactComponentNode): ReactComponentNode[] {
    if (!element) return this.roots;
    return element.children;
  }

  getParent(_element: ReactComponentNode): ReactComponentNode | undefined {
    return undefined;  // Flat lookup not needed for basic tree
  }

  findComponent(name: string): ReactComponentNode | undefined {
    const search = (nodes: ReactComponentNode[]): ReactComponentNode | undefined => {
      for (const node of nodes) {
        if (node.name === name) return node;
        const found = search(node.children);
        if (found) return found;
      }
      return undefined;
    };
    return search(this.roots);
  }
}
