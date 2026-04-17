import { CdpClient } from '../cdp/CdpClient';
import { FetchRequestPausedEvent } from '../cdp/CdpTypes';
import { logger } from '../util/Logger';

function compileUrlPattern(pattern: string): RegExp {
  return new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
}

interface NetworkBreakpointRule {
  id: number;
  name: string;
  type: 'fetch' | 'graphql' | 'xhr';
  pattern: string;
  /** Pre-compiled URL regex for fetch/xhr rules (undefined for graphql) */
  urlRegex?: RegExp;
  verified: boolean;
}

export class NetworkBreakpointManager {
  private rules: NetworkBreakpointRule[] = [];
  private onMatchCallback: ((rule: NetworkBreakpointRule, request: FetchRequestPausedEvent) => void) | null = null;

  constructor(private cdp: CdpClient) {}

  setRules(breakpointNames: string[]): NetworkBreakpointRule[] {
    this.rules = [];
    let id = 1;
    for (const name of breakpointNames) {
      const rule = this.parseBreakpointName(name, id++);
      if (rule) this.rules.push(rule);
    }
    return this.rules;
  }

  onMatch(callback: (rule: NetworkBreakpointRule, request: FetchRequestPausedEvent) => void): void {
    this.onMatchCallback = callback;
  }

  async handleRequest(params: FetchRequestPausedEvent): Promise<void> {
    const matchedRule = this.findMatchingRule(params);

    if (matchedRule) {
      logger.info(`Network breakpoint hit: ${matchedRule.name} (${params.request.url})`);
      // Let the request continue but pause JS execution
      if (this.onMatchCallback) {
        this.onMatchCallback(matchedRule, params);
      }
    }

    // Always continue the network request
    try {
      await this.cdp.continueFetchRequest(params.requestId);
    } catch (e) {
      logger.debug(`Failed to continue fetch request: ${e}`);
    }
  }

  private findMatchingRule(params: FetchRequestPausedEvent): NetworkBreakpointRule | null {
    for (const rule of this.rules) {
      if (rule.type === 'graphql') {
        if (this.matchGraphQL(params, rule.pattern)) return rule;
      } else if (rule.urlRegex && rule.urlRegex.test(params.request.url)) {
        return rule;
      }
    }
    return null;
  }

  private matchGraphQL(params: FetchRequestPausedEvent, operationName: string): boolean {
    if (!params.request.postData) return false;
    try {
      const body = JSON.parse(params.request.postData);
      // Support both single and batched queries
      const operations = Array.isArray(body) ? body : [body];
      return operations.some(op => op.operationName === operationName);
    } catch {
      return false;
    }
  }

  private parseBreakpointName(name: string, id: number): NetworkBreakpointRule | null {
    if (name.startsWith('graphql:')) {
      return { id, name, type: 'graphql', pattern: name.slice('graphql:'.length).trim(), verified: true };
    }
    if (name.startsWith('fetch:')) {
      const pattern = name.slice('fetch:'.length).trim();
      return { id, name, type: 'fetch', pattern, urlRegex: compileUrlPattern(pattern), verified: true };
    }
    if (name.startsWith('xhr:')) {
      const pattern = name.slice('xhr:'.length).trim();
      return { id, name, type: 'xhr', pattern, urlRegex: compileUrlPattern(pattern), verified: true };
    }
    return null;
  }

  getRules(): NetworkBreakpointRule[] {
    return this.rules;
  }

  clear(): void {
    this.rules = [];
  }
}
