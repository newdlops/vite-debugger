import { DebugProtocol } from '@vscode/debugprotocol';
import { RemoteObject, PropertyDescriptor } from '../cdp/CdpTypes';
import { CdpClient } from '../cdp/CdpClient';
import { logger } from '../util/Logger';

export class VariableManager {
  private refCounter: number;
  private objectIdMap = new Map<number, string>();
  private syntheticVariables = new Map<number, DebugProtocol.Variable[]>();

  constructor(private cdp: CdpClient, refStartOffset: number = 10000) {
    this.refCounter = refStartOffset;
  }

  registerSyntheticVariables(ref: number, variables: DebugProtocol.Variable[]): void {
    this.syntheticVariables.set(ref, variables);
  }

  registerObjectId(objectId: string): number {
    const ref = ++this.refCounter;
    this.objectIdMap.set(ref, objectId);
    return ref;
  }

  registerScopeObjectId(objectId: string, ref: number): void {
    this.objectIdMap.set(ref, objectId);
  }

  async getVariables(variablesReference: number): Promise<DebugProtocol.Variable[]> {
    const synthetic = this.syntheticVariables.get(variablesReference);
    if (synthetic) {
      return synthetic;
    }

    const objectId = this.objectIdMap.get(variablesReference);
    if (!objectId) {
      // This happens frequently when the debugger resumes and stale scope
      // references are requested — not a real error, just a race condition.
      logger.debug(`No object ID for variables reference ${variablesReference}`);
      return [];
    }

    try {
      const properties = await this.cdp.getProperties(objectId, true);
      return this.convertProperties(properties);
    } catch (e) {
      // Object may have been garbage collected after resume — expected.
      logger.debug(`Failed to get properties for ref ${variablesReference}: ${e}`);
      return [];
    }
  }

  private convertProperties(properties: PropertyDescriptor[]): DebugProtocol.Variable[] {
    const variables: DebugProtocol.Variable[] = [];

    for (const prop of properties) {
      if (!prop.value) continue;
      if (prop.name === '__proto__') continue;

      variables.push(this.convertRemoteObject(prop.name, prop.value));
    }

    return variables;
  }

  convertRemoteObject(name: string, obj: RemoteObject): DebugProtocol.Variable {
    let value: string;
    let variablesReference = 0;
    const type = obj.type;

    switch (obj.type) {
      case 'undefined':
        value = 'undefined';
        break;

      case 'boolean':
      case 'number':
      case 'bigint':
        value = String(obj.value);
        break;

      case 'string':
        value = JSON.stringify(obj.value);
        break;

      case 'symbol':
        value = obj.description ?? 'Symbol()';
        break;

      case 'function':
        value = obj.description?.split('\n')[0] ?? 'function()';
        break;

      case 'object':
        if (obj.subtype === 'null') {
          value = 'null';
        } else if (obj.subtype === 'array') {
          value = this.formatArrayPreview(obj);
          if (obj.objectId) {
            variablesReference = this.registerObjectId(obj.objectId);
          }
        } else if (obj.subtype === 'regexp') {
          value = obj.description ?? '/regex/';
        } else if (obj.subtype === 'date') {
          value = obj.description ?? 'Date';
        } else if (obj.subtype === 'error') {
          value = obj.description ?? 'Error';
        } else if (obj.subtype === 'promise') {
          value = 'Promise';
          if (obj.objectId) {
            variablesReference = this.registerObjectId(obj.objectId);
          }
        } else if (obj.subtype === 'map' || obj.subtype === 'set') {
          value = obj.description ?? (obj.subtype === 'map' ? 'Map' : 'Set');
          if (obj.objectId) {
            variablesReference = this.registerObjectId(obj.objectId);
          }
        } else {
          value = this.formatObjectPreview(obj);
          if (obj.objectId) {
            variablesReference = this.registerObjectId(obj.objectId);
          }
        }
        break;

      default:
        value = obj.description ?? String(obj.value ?? 'unknown');
    }

    return {
      name,
      value,
      type,
      variablesReference,
    };
  }

  private formatArrayPreview(obj: RemoteObject): string {
    if (obj.preview?.properties) {
      const items = obj.preview.properties
        .slice(0, 5)
        .map((p: { value?: string }) => p.value ?? '...');
      const suffix = (obj.preview.properties.length > 5 || obj.preview.overflow) ? ', ...' : '';
      return `(${obj.preview.properties.length}) [${items.join(', ')}${suffix}]`;
    }
    return obj.description ?? 'Array';
  }

  private formatObjectPreview(obj: RemoteObject): string {
    if (obj.preview?.properties) {
      const entries = obj.preview.properties
        .slice(0, 5)
        .map((p: { name: string; value?: string }) => `${p.name}: ${p.value ?? '...'}`);
      const suffix = (obj.preview.properties.length > 5 || obj.preview.overflow) ? ', ...' : '';
      return `{${entries.join(', ')}${suffix}}`;
    }
    return obj.description ?? obj.className ?? 'Object';
  }

  clear(): void {
    this.objectIdMap.clear();
    this.syntheticVariables.clear();
  }
}
