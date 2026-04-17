import * as vscode from 'vscode';

export type FiberKind =
  | 'function'
  | 'class'
  | 'forwardRef'
  | 'memo'
  | 'provider'
  | 'consumer'
  | 'suspense'
  | 'lazy'
  | 'profiler'
  | 'strictMode'
  | 'other';

export interface ReactComponentNode {
  name: string;
  kind: FiberKind;
  filePath?: string;
  line?: number;
  key?: string | null;
  children: ReactComponentNode[];
}

interface EvalResult {
  roots?: ReactComponentNode[];
  error?: 'NO_REACT' | 'EVAL_FAILED';
  message?: string;
}

/**
 * Evaluate an expression in the page and return its value. When `cacheKey` is
 * provided, the session-side handler may compile the expression once (keyed by
 * `cacheKey`) and reuse the compiled script on subsequent calls — avoiding
 * repeated parse+compile of the same large walker expression.
 */
export type Evaluator = (expression: string, cacheKey?: string) => Promise<unknown>;

const WALKER_CACHE_KEY = 'reactComponentTree';

/**
 * Expression evaluated inside the page. Must be self-contained and return a
 * JSON-serializable object. The CDP Runtime.evaluate path we use requires
 * returnByValue, so all output must be plain data — no functions, no cycles.
 *
 * Strategy:
 *  1. Prefer React DevTools hook (`__REACT_DEVTOOLS_GLOBAL_HOOK__`) when available.
 *  2. Fall back to DOM scan for `__reactContainer$*` (React 18+) or
 *     `_reactRootContainer` (React 17).
 *  3. Walk each fiber's `child`/`sibling` chain, keeping only components
 *     (function/class/forwardRef/memo/provider/consumer/...) and hoisting
 *     children through host elements (divs, spans, fragments).
 */
const PAGE_EXPRESSION = `(() => {
  try {
    var MAX_DEPTH = 500;
    var MAX_NODES = 5000;
    var nodeCount = 0;

    function typeOfSymbol(type) {
      if (!type) return null;
      var sym = type.$$typeof;
      if (!sym) return null;
      var desc;
      try { desc = sym.toString(); } catch (e) { desc = ''; }
      if (desc.indexOf('forward_ref') !== -1) return 'forwardRef';
      if (desc.indexOf('memo') !== -1) return 'memo';
      if (desc.indexOf('provider') !== -1) return 'provider';
      if (desc.indexOf('context') !== -1) return 'consumer';
      if (desc.indexOf('lazy') !== -1) return 'lazy';
      if (desc.indexOf('profiler') !== -1) return 'profiler';
      if (desc.indexOf('strict_mode') !== -1) return 'strictMode';
      if (desc.indexOf('suspense') !== -1) return 'suspense';
      return 'other';
    }

    function fiberKind(fiber) {
      var type = fiber.type;
      if (type == null) return 'other';
      if (typeof type === 'function') {
        return (type.prototype && type.prototype.isReactComponent) ? 'class' : 'function';
      }
      if (typeof type === 'string') return 'host';
      if (typeof type === 'object') {
        var k = typeOfSymbol(type);
        if (k) return k;
        return 'other';
      }
      return 'other';
    }

    function componentName(fiber) {
      var type = fiber.type;
      if (typeof type === 'string') return type;
      if (typeof type === 'function') {
        return type.displayName || type.name || 'Anonymous';
      }
      if (type && typeof type === 'object') {
        if (type.displayName) return type.displayName;
        // forwardRef
        if (type.render) return type.render.displayName || type.render.name || 'ForwardRef';
        // memo
        if (type.type) {
          var inner = type.type;
          var innerName = (typeof inner === 'function')
            ? (inner.displayName || inner.name)
            : (inner && inner.displayName);
          return innerName ? 'Memo(' + innerName + ')' : 'Memo';
        }
        // context provider/consumer
        if (type._context) {
          var ctxName = type._context.displayName || 'Context';
          var k = typeOfSymbol(type);
          if (k === 'provider') return ctxName + '.Provider';
          if (k === 'consumer') return ctxName + '.Consumer';
          return ctxName;
        }
      }
      // Fragments, suspense, etc. use tag-based fallback
      var tag = fiber.tag;
      if (tag === 7) return 'Fragment';
      if (tag === 13) return 'Suspense';
      if (tag === 18) return 'Profiler';
      if (tag === 8) return 'StrictMode';
      return null;
    }

    function sourceFromFiber(fiber) {
      var src = fiber._debugSource;
      if (src && src.fileName) {
        return { filePath: src.fileName, line: src.lineNumber };
      }
      // Some renderers expose source on elementType
      var elType = fiber.elementType;
      if (elType && elType._source && elType._source.fileName) {
        return { filePath: elType._source.fileName, line: elType._source.lineNumber };
      }
      return null;
    }

    function isComponentKind(kind) {
      return kind === 'function' || kind === 'class' || kind === 'forwardRef'
        || kind === 'memo' || kind === 'provider' || kind === 'consumer'
        || kind === 'suspense' || kind === 'lazy' || kind === 'profiler'
        || kind === 'strictMode';
    }

    function walk(fiber, depth) {
      if (!fiber || depth > MAX_DEPTH || nodeCount >= MAX_NODES) return [];

      // Recurse into children first; we may hoist these through host nodes.
      var childNodes = [];
      var child = fiber.child;
      while (child) {
        try {
          var hoisted = walk(child, depth + 1);
          for (var i = 0; i < hoisted.length; i++) childNodes.push(hoisted[i]);
        } catch (e) { /* skip broken subtree */ }
        child = child.sibling;
      }

      var kind;
      try { kind = fiberKind(fiber); } catch (e) { kind = 'other'; }
      if (isComponentKind(kind)) {
        nodeCount++;
        var node = {
          name: 'Anonymous',
          kind: kind,
          children: childNodes,
        };
        try { node.name = componentName(fiber) || 'Anonymous'; } catch (e) {}
        try { if (fiber.key != null) node.key = String(fiber.key); } catch (e) {}
        try {
          var src = sourceFromFiber(fiber);
          if (src) { node.filePath = src.filePath; node.line = src.line; }
        } catch (e) {}
        return [node];
      }

      // Host element, fragment, or root — hoist children so the visible tree
      // only shows user components.
      return childNodes;
    }

    function collectHookRoots(fiberRoots) {
      var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook) return;
      try {
        if (typeof hook.getFiberRoots === 'function' && hook.renderers) {
          var keys = typeof hook.renderers.keys === 'function'
            ? Array.from(hook.renderers.keys())
            : Object.keys(hook.renderers);
          for (var i = 0; i < keys.length; i++) {
            var roots = hook.getFiberRoots(keys[i]);
            if (!roots) continue;
            var iter = (typeof roots.forEach === 'function') ? roots : null;
            if (iter) {
              iter.forEach(function (root) {
                if (root && root.current) fiberRoots.push(root.current);
              });
            }
          }
        }
      } catch (e) { /* ignore */ }
    }

    function collectDomRoots(fiberRoots) {
      var seenRoots = new Set();
      var candidates = document.querySelectorAll('*');
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        var keys = Object.keys(el);
        for (var j = 0; j < keys.length; j++) {
          var key = keys[j];
          if (key.indexOf('__reactContainer$') === 0) {
            // React 18: container value is a FiberNode (HostRoot).
            // Its stateNode is the FiberRootNode whose .current is the root fiber.
            var container = el[key];
            var rootFiber = (container && container.stateNode && container.stateNode.current)
              ? container.stateNode.current
              : container;
            if (rootFiber && !seenRoots.has(rootFiber)) {
              seenRoots.add(rootFiber);
              fiberRoots.push(rootFiber);
            }
          } else if (key === '_reactRootContainer') {
            // React 17 legacy mode
            var legacy = el[key];
            var internal = legacy && (legacy._internalRoot || legacy);
            if (internal && internal.current && !seenRoots.has(internal.current)) {
              seenRoots.add(internal.current);
              fiberRoots.push(internal.current);
            }
          }
        }
      }
    }

    var fiberRoots = [];
    collectHookRoots(fiberRoots);
    if (fiberRoots.length === 0) collectDomRoots(fiberRoots);

    if (fiberRoots.length === 0) {
      return { error: 'NO_REACT' };
    }

    var roots = [];
    for (var i = 0; i < fiberRoots.length; i++) {
      var walked = walk(fiberRoots[i], 0);
      for (var j = 0; j < walked.length; j++) roots.push(walked[j]);
    }
    return { roots: roots };
  } catch (e) {
    return { error: 'EVAL_FAILED', message: (e && e.message) ? e.message : String(e) };
  }
})()`;

export class ReactComponentTreeProvider implements vscode.TreeDataProvider<ReactComponentNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ReactComponentNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _onDidChangeStatus = new vscode.EventEmitter<string | null>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  private roots: ReactComponentNode[] = [];
  private nameIndex = new Map<string, ReactComponentNode>();
  private evaluator: Evaluator | null = null;
  private statusMessage: string | null = 'Start a Vite debug session to inspect components.';
  private refreshInFlight = false;

  setEvaluator(evaluator: Evaluator | null): void {
    this.evaluator = evaluator;
    if (!evaluator) {
      this.roots = [];
      this.setStatus('Start a Vite debug session to inspect components.');
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  getStatus(): string | null {
    return this.statusMessage;
  }

  private setStatus(message: string | null): void {
    this.statusMessage = message;
    this._onDidChangeStatus.fire(message);
  }

  async refresh(): Promise<void> {
    if (this.refreshInFlight) return;
    if (!this.evaluator) {
      this.roots = [];
      this.setStatus('Start a Vite debug session to inspect components.');
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    this.refreshInFlight = true;
    try {
      const raw = await this.evaluator(PAGE_EXPRESSION, WALKER_CACHE_KEY);
      const result = raw as EvalResult | null | undefined;

      if (!result || typeof result !== 'object') {
        this.roots = [];
        this.setStatus('Could not read React state from the page.');
      } else if (result.error === 'NO_REACT') {
        this.roots = [];
        this.setStatus('No React app detected. Is the app mounted?');
      } else if (result.error === 'EVAL_FAILED') {
        this.roots = [];
        this.setStatus(`React inspection failed: ${result.message ?? 'unknown error'}`);
      } else if (Array.isArray(result.roots)) {
        this.roots = result.roots;
        this.rebuildNameIndex();
        this.setStatus(result.roots.length === 0 ? 'React mounted but no components rendered yet.' : null);
      } else {
        this.roots = [];
        this.setStatus('Unexpected response from the page.');
      }
    } catch (e) {
      this.roots = [];
      const message = e instanceof Error ? e.message : String(e);
      this.setStatus(`Failed to evaluate in page: ${message}`);
    } finally {
      this.refreshInFlight = false;
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  clear(): void {
    this.roots = [];
    this.nameIndex.clear();
    this.evaluator = null;
    this.setStatus('Start a Vite debug session to inspect components.');
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Build a flat name→first-node map so findComponent is O(1). */
  private rebuildNameIndex(): void {
    this.nameIndex.clear();
    const visit = (nodes: ReactComponentNode[]): void => {
      for (const node of nodes) {
        if (!this.nameIndex.has(node.name)) {
          this.nameIndex.set(node.name, node);
        }
        if (node.children.length > 0) visit(node.children);
      }
    };
    visit(this.roots);
  }

  getTreeItem(element: ReactComponentNode): vscode.TreeItem {
    const hasChildren = element.children.length > 0;
    const label = element.key != null ? `<${element.name} key="${element.key}">` : `<${element.name}>`;
    const item = new vscode.TreeItem(
      label,
      hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );

    item.contextValue = 'reactComponent';

    if (element.filePath) {
      const fileName = element.filePath.split('/').pop() ?? element.filePath;
      item.description = `${fileName}:${element.line ?? '?'}`;
      item.tooltip = `${element.filePath}:${element.line ?? '?'}`;
      // Clicking opens the source file
      item.command = {
        command: 'vite-debugger.goToComponent',
        title: 'Go to Source',
        arguments: [element],
      };
    }

    item.iconPath = iconFor(element.kind);

    return item;
  }

  getChildren(element?: ReactComponentNode): ReactComponentNode[] {
    if (!element) return this.roots;
    return element.children;
  }

  getParent(_element: ReactComponentNode): ReactComponentNode | undefined {
    return undefined;
  }

  findComponent(name: string): ReactComponentNode | undefined {
    return this.nameIndex.get(name);
  }
}

function iconFor(kind: FiberKind): vscode.ThemeIcon {
  switch (kind) {
    case 'class': return new vscode.ThemeIcon('symbol-class');
    case 'function': return new vscode.ThemeIcon('symbol-function');
    case 'forwardRef': return new vscode.ThemeIcon('symbol-interface');
    case 'memo': return new vscode.ThemeIcon('symbol-constant');
    case 'provider': return new vscode.ThemeIcon('symbol-namespace');
    case 'consumer': return new vscode.ThemeIcon('symbol-reference');
    case 'suspense': return new vscode.ThemeIcon('watch');
    case 'lazy': return new vscode.ThemeIcon('cloud-download');
    case 'profiler': return new vscode.ThemeIcon('pulse');
    case 'strictMode': return new vscode.ThemeIcon('shield');
    default: return new vscode.ThemeIcon('symbol-misc');
  }
}
