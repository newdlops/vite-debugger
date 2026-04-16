import { DebugProtocol } from '@vscode/debugprotocol';
import { RemoteObject } from '../cdp/CdpTypes';
import { CdpClient } from '../cdp/CdpClient';
import { VariableManager } from './VariableManager';
import { logger } from '../util/Logger';

export class EvalHandler {
  constructor(
    private cdp: CdpClient,
    private variableManager: VariableManager,
  ) {}

  async evaluate(
    expression: string,
    frameId?: number,
    callFrameId?: string,
    context?: 'watch' | 'repl' | 'hover' | 'clipboard',
  ): Promise<DebugProtocol.EvaluateResponse['body']> {
    const silent = context === 'hover';

    try {
      let result: RemoteObject;

      if (callFrameId) {
        result = await this.cdp.evaluateOnCallFrame(callFrameId, expression, silent);
      } else {
        result = await this.cdp.evaluate(expression, silent);
      }

      const variable = this.variableManager.convertRemoteObject('result', result);

      return {
        result: variable.value,
        type: variable.type,
        variablesReference: variable.variablesReference,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.debug(`Evaluate failed: ${message}`);
      return {
        result: message,
        variablesReference: 0,
      };
    }
  }
}
