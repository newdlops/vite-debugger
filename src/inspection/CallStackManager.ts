import * as fs from 'fs';
import { DebugProtocol } from '@vscode/debugprotocol';
import { CallFrame } from '../cdp/CdpTypes';
import { SourceMapResolver } from '../sourcemap/SourceMapResolver';
import { ViteUrlMapper } from '../vite/ViteUrlMapper';
import { logger } from '../util/Logger';

export interface ResolvedCallFrame {
  dapFrame: DebugProtocol.StackFrame;
  cdpCallFrame: CallFrame;
  scriptId: string;
}

/** Callback to register a sourceReference → scriptId mapping */
export type SourceRefRegistrar = (scriptId: string) => number;

export class CallStackManager {
  private frameIdCounter = 0;
  private frameMap = new Map<number, CallFrame>();
  private fileExistsCache = new Map<string, boolean>();

  constructor(
    private sourceMapResolver: SourceMapResolver,
    private urlMapper: ViteUrlMapper,
  ) {}

  async resolveCallFrames(
    cdpFrames: CallFrame[],
    registerSourceRef?: SourceRefRegistrar,
  ): Promise<ResolvedCallFrame[]> {
    this.frameMap.clear();
    this.frameIdCounter = 0;

    const resolved: ResolvedCallFrame[] = [];

    for (const cdpFrame of cdpFrames) {
      const frameId = ++this.frameIdCounter;
      this.frameMap.set(frameId, cdpFrame);

      const { scriptId, lineNumber, columnNumber } = cdpFrame.location;
      let source: DebugProtocol.Source;
      let line: number;
      let column: number;
      let presentationHint: 'normal' | 'label' | 'subtle' | undefined;

      // Step 1: Determine the local file path from Vite URL (always available, no source map needed)
      const localPath = this.urlMapper.viteUrlToFilePath(cdpFrame.url);
      const isLocalFile = localPath ? this.fileExists(localPath) : false;
      const isNodeModules = localPath?.includes('/node_modules/') ?? cdpFrame.url.includes('/node_modules/');
      const isInternal = this.isInternalFrame(cdpFrame.url);

      // Step 2: Try source map for accurate line/column mapping
      const original = await this.sourceMapResolver.generatedToOriginal(
        scriptId, lineNumber, columnNumber ?? 0
      );

      if (original && !original.source.includes('/node_modules/')) {
        // Source map resolved to user code — use its line/column
        const onDisk = this.fileExists(original.source);
        source = { name: original.source.split('/').pop() ?? 'unknown' };
        line = original.line;
        column = original.column + 1;
        if (onDisk) {
          source.path = original.source;
        } else if (isLocalFile && localPath) {
          // Source map path doesn't exist but URL-based path does — use that
          source.path = localPath;
        }
        if (!isNodeModules && !isInternal && source.path) {
          logger.debug(
            `Frame ${frameId}: ${cdpFrame.functionName || '(anonymous)'} → ` +
            `${source.path}:${line}:${original.column} (gen ${lineNumber}:${columnNumber ?? 0})`
          );
        }
      } else if (isLocalFile && localPath && !isNodeModules && !isInternal) {
        // No source map (or maps to node_modules) but local file exists — show file with generated position
        source = { name: localPath.split('/').pop() ?? 'unknown', path: localPath };
        line = lineNumber + 1;
        column = (columnNumber ?? 0) + 1;
        logger.debug(
          `Frame ${frameId}: ${cdpFrame.functionName || '(anonymous)'} → ` +
          `${localPath}:${line}:${column} (from URL)`
        );
      } else {
        // node_modules, Vite internals, or truly unknown
        source = { name: cdpFrame.functionName || cdpFrame.url.split('/').pop() || 'unknown' };
        line = lineNumber + 1;
        column = (columnNumber ?? 0) + 1;
        presentationHint = 'subtle';
      }

      if (isNodeModules || isInternal) {
        presentationHint = 'subtle';
      }

      const dapFrame: DebugProtocol.StackFrame = {
        id: frameId,
        name: cdpFrame.functionName || '(anonymous)',
        source,
        line,
        column,
        presentationHint,
      };

      resolved.push({ dapFrame, cdpCallFrame: cdpFrame, scriptId });
    }

    return resolved;
  }

  getCdpFrame(dapFrameId: number): CallFrame | undefined {
    return this.frameMap.get(dapFrameId);
  }

  clear(): void {
    this.frameMap.clear();
    this.frameIdCounter = 0;
  }

  /** Check if path exists as a regular file (not a directory) */
  private fileExists(filePath: string): boolean {
    const cached = this.fileExistsCache.get(filePath);
    if (cached !== undefined) return cached;

    try {
      const stat = fs.statSync(filePath);
      const isFile = stat.isFile();
      this.fileExistsCache.set(filePath, isFile);
      return isFile;
    } catch {
      this.fileExistsCache.set(filePath, false);
      return false;
    }
  }

  private isInternalFrame(url: string): boolean {
    return url.includes('/@vite/') ||
           url.includes('/@react-refresh') ||
           url.includes('node_modules/.vite/') ||
           url.includes('__vite_') ||
           url.includes('vite/dist/client');
  }
}
