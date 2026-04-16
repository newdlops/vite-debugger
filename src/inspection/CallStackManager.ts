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

      // Try to resolve through source map
      const original = await this.sourceMapResolver.generatedToOriginal(
        scriptId, lineNumber, columnNumber ?? 0
      );

      let source: DebugProtocol.Source;
      let line: number;
      let column: number;
      let presentationHint: 'normal' | 'label' | 'subtle' | undefined;

      if (original) {
        const onDisk = this.fileExists(original.source);
        source = {
          name: original.source.split('/').pop() ?? 'unknown',
        };
        line = original.line;
        column = original.column + 1; // DAP columns are 1-based

        if (onDisk) {
          source.path = original.source;
        } else if (registerSourceRef) {
          // Not on disk — only use sourceReference, no path
          source.sourceReference = registerSourceRef(scriptId);
        }

        if (onDisk) {
          logger.debug(
            `Frame ${frameId}: ${cdpFrame.functionName || '(anonymous)'} → ` +
            `${original.source}:${line}`
          );
        }
      } else {
        // generatedToOriginal failed — try finding the nearest mapped location
        const nearest = await this.sourceMapResolver.nearestOriginalLocation(
          scriptId, lineNumber, columnNumber ?? 0, 20
        );

        if (nearest && !nearest.source.includes('/node_modules/')) {
          // Nearest mapping found in user code
          const onDisk = this.fileExists(nearest.source);
          source = {
            name: nearest.source.split('/').pop() ?? 'unknown',
          };
          line = nearest.line;
          column = nearest.column + 1;

          if (onDisk) {
            source.path = nearest.source;
            logger.debug(
              `Frame ${frameId}: ${cdpFrame.functionName || '(anonymous)'} → ` +
              `${nearest.source}:${line} (nearest mapping)`
            );
          } else if (registerSourceRef) {
            source.sourceReference = registerSourceRef(scriptId);
          }
        } else {
          // Nearest not found or is node_modules — use primarySource as fallback
          const primarySource = this.sourceMapResolver.getPrimarySourceForScript(scriptId);
          const isNodeModules = primarySource?.includes('/node_modules/') ?? true;
          const primaryOnDisk = primarySource ? this.fileExists(primarySource) : false;

          if (primaryOnDisk && !isNodeModules) {
            // Local user file — show file path (line 1 as best guess)
            source = {
              name: primarySource!.split('/').pop() ?? 'unknown',
              path: primarySource!,
            };
            line = 1;
            column = 1;
            logger.debug(
              `Frame ${frameId}: ${cdpFrame.functionName || '(anonymous)'} → ` +
              `${primarySource} (no exact mapping)`
            );
          } else {
            // node_modules or unknown — deemphasize
            source = {
              name: cdpFrame.functionName || cdpFrame.url.split('/').pop() || 'unknown',
            };
            if (registerSourceRef) {
              source.sourceReference = registerSourceRef(scriptId);
            }
            line = lineNumber + 1;
            column = (columnNumber ?? 0) + 1;
            presentationHint = 'subtle';
          }
        }
      }

      // Deemphasize Vite internal frames
      if (this.isInternalFrame(cdpFrame.url)) {
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
