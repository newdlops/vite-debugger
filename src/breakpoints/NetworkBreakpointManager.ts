import { CdpClient } from '../cdp/CdpClient';
import { FetchRequestPausedEvent } from '../cdp/CdpTypes';
import { logger } from '../util/Logger';

interface NetworkBreakpointRule {
  id: number;
  name: string;
  type: 'fetch' | 'graphql' | 'xhr';
  pattern: string;
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
        // Match GraphQL operation name from POST body
        if (this.matchGraphQL(params, rule.pattern)) return rule;
      } else if (rule.type === 'fetch') {
        // Match URL pattern (support * wildcard)
        if (this.matchUrlPattern(params.request.url, rule.pattern)) return rule;
      } else if (rule.type === 'xhr') {
        if (this.matchUrlPattern(params.request.url, rule.pattern)) return rule;
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

  private matchUrlPattern(url: string, pattern: string): boolean {
    // Convert wildcard pattern to regex
    const regex = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return regex.test(url);
  }

  private parseBreakpointName(name: string, id: number): NetworkBreakpointRule | null {
    if (name.startsWith('graphql:')) {
      return { id, name, type: 'graphql', pattern: name.slice('graphql:'.length).trim(), verified: true };
    }
    if (name.startsWith('fetch:')) {
      return { id, name, type: 'fetch', pattern: name.slice('fetch:'.length).trim(), verified: true };
    }
    if (name.startsWith('xhr:')) {
      return { id, name, type: 'xhr', pattern: name.slice('xhr:'.length).trim(), verified: true };
    }
    // Not a network breakpoint
    return null;
  }

  getRules(): NetworkBreakpointRule[] {
    return this.rules;
  }

  clear(): void {
    this.rules = [];
  }
}
