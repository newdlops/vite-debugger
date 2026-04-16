import { DebugProtocol } from '@vscode/debugprotocol';
import { CallFrame, Scope } from '../cdp/CdpTypes';

export interface ManagedScope {
  dapScope: DebugProtocol.Scope;
  cdpScope: Scope;
}

export class ScopeManager {
  private scopeRefCounter = 0;
  private scopeMap = new Map<number, Scope>();

  resolveScopesForFrame(cdpFrame: CallFrame): ManagedScope[] {
    const scopes: ManagedScope[] = [];

    for (const cdpScope of cdpFrame.scopeChain) {
      const ref = ++this.scopeRefCounter;
      this.scopeMap.set(ref, cdpScope);

      let name: string;
      let expensive = false;

      switch (cdpScope.type) {
        case 'local':
          name = 'Local';
          break;
        case 'closure':
          name = `Closure (${cdpScope.name ?? ''})`;
          break;
        case 'catch':
          name = 'Catch';
          break;
        case 'block':
          name = 'Block';
          break;
        case 'script':
          name = 'Script';
          break;
        case 'eval':
          name = 'Eval';
          break;
        case 'module':
          name = 'Module';
          break;
        case 'global':
          name = 'Global';
          expensive = true;
          break;
        case 'with':
          name = 'With';
          break;
        default:
          name = cdpScope.type;
      }

      const dapScope: DebugProtocol.Scope = {
        name,
        variablesReference: ref,
        expensive,
      };

      scopes.push({ dapScope, cdpScope });
    }

    return scopes;
  }

  getCdpScope(variablesReference: number): Scope | undefined {
    return this.scopeMap.get(variablesReference);
  }

  getObjectId(variablesReference: number): string | undefined {
    const scope = this.scopeMap.get(variablesReference);
    return scope?.object.objectId;
  }

  clear(): void {
    this.scopeMap.clear();
    this.scopeRefCounter = 0;
  }

  get nextRefBase(): number {
    return this.scopeRefCounter;
  }
}
