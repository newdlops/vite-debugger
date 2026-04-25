import * as path from 'path';

export class ViteUrlMapper {
  private viteRoot: string;

  constructor(
    private viteUrl: string,
    private webRoot: string,
    viteRoot?: string,
  ) {
    // Normalize: remove trailing slash
    this.viteUrl = this.viteUrl.replace(/\/$/, '');
    this.webRoot = this.webRoot.replace(/\/$/, '');
    this.viteRoot = (viteRoot ?? webRoot).replace(/\/$/, '');
  }

  filePathToViteUrl(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');

    // Vite serves files relative to its project root (where vite.config lives),
    // not webRoot. For monorepos webRoot may be the outer workspace folder
    // (e.g. /Users/x/project) while viteRoot is a sub-package
    // (e.g. /Users/x/project/client) — using webRoot here would produce
    // /sub/src/foo.tsx which Vite returns 404 on.
    if (normalized.startsWith(this.viteRoot)) {
      const relative = normalized.slice(this.viteRoot.length);
      return `${this.viteUrl}${relative}`;
    }

    // Files outside the Vite project root use the /@fs/ prefix Vite reserves
    // for absolute filesystem paths (e.g. linked workspace deps).
    return `${this.viteUrl}/@fs${normalized}`;
  }

  viteUrlToFilePath(viteUrl: string): string | null {
    let urlPath: string;
    try {
      const parsed = new URL(viteUrl);
      urlPath = parsed.pathname;
    } catch {
      // If it's already just a path
      urlPath = viteUrl;
    }

    // /@fs/ absolute path mapping
    if (urlPath.startsWith('/@fs/')) {
      return urlPath.slice(4); // remove /@fs
    }

    // /@vite/ internal files — no file mapping
    if (urlPath.startsWith('/@vite/') || urlPath.startsWith('/@react-refresh') || urlPath.startsWith('/@')) {
      return null;
    }

    // Root path or no meaningful path — return null to avoid directory paths
    if (urlPath === '/' || urlPath === '') {
      return null;
    }

    // /node_modules/.vite/deps/ — pre-bundled deps
    if (urlPath.includes('/node_modules/.vite/deps/')) {
      return path.join(this.webRoot, urlPath);
    }

    // Normal project file: /src/App.tsx -> <viteRoot>/src/App.tsx
    return path.join(this.viteRoot, urlPath);
  }

  isViteInternalUrl(url: string): boolean {
    let urlPath: string;
    try {
      urlPath = new URL(url).pathname;
    } catch {
      urlPath = url;
    }
    return urlPath.startsWith('/@vite/') ||
           urlPath.startsWith('/@react-refresh') ||
           urlPath === '/node_modules/.vite/deps/chunk-' ||
           urlPath.includes('__vite');
  }
}
