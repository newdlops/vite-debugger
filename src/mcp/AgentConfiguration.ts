import { isDeepStrictEqual } from 'util';
import {
  applyEdits,
  modify,
  Node as JsonNode,
  parse,
  ParseError,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser/lib/esm/main.js';
import { parse as parseToml, stringify as stringifyToml, TomlTable } from 'smol-toml';

export const CODEX_CONFIGURATION_PATH = '.codex/config.toml';
export const CLAUDE_CONFIGURATION_PATH = '.mcp.json';

const CODEX_BLOCK_BEGIN = '# BEGIN VITE DEBUGGER MCP (managed by the Vite Debugger extension)';
const CODEX_BLOCK_END = '# END VITE DEBUGGER MCP';
const CODEX_SERVER_HEADER = /^\s*\[\s*(?:mcp_servers|["']mcp_servers["'])\s*\.\s*(?:vite_debugger|vite-debugger|["']vite_debugger["']|["']vite-debugger["'])\s*\]\s*(?:#.*)?$/;
const TOML_TABLE_HEADER = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;

export type ConfigurationChange = 'created' | 'updated' | 'unchanged';

export interface AgentMcpLaunch {
  launcherPath: string;
  workspacePath: string;
}

export interface ConfigurationMergeResult {
  content: string;
  change: ConfigurationChange;
}

export class AgentConfigurationError extends Error {}

function tomlString(value: string): string {
  const assignment = stringifyToml({ value }).trimEnd();
  const prefix = 'value = ';
  if (!assignment.startsWith(prefix)) {
    throw new AgentConfigurationError('Could not encode an MCP path as TOML.');
  }
  return assignment.slice(prefix.length);
}

function detectEol(source: string): '\n' | '\r\n' {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

function changeFor(existing: string | undefined, content: string): ConfigurationChange {
  if (existing === undefined) return 'created';
  return existing === content ? 'unchanged' : 'updated';
}

export function renderCodexMcpBlock(launch: AgentMcpLaunch, eol = '\n'): string {
  return [
    CODEX_BLOCK_BEGIN,
    '[mcp_servers.vite_debugger]',
    'command = "node"',
    `args = [${tomlString(launch.launcherPath)}, "--workspace", ${tomlString(launch.workspacePath)}]`,
    `cwd = ${tomlString(launch.workspacePath)}`,
    'startup_timeout_sec = 10',
    'tool_timeout_sec = 60',
    'enabled = true',
    'required = false',
    CODEX_BLOCK_END,
  ].join(eol);
}

function findLineIndexes(lines: readonly string[], predicate: (line: string) => boolean): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (predicate(lines[index])) indexes.push(index);
  }
  return indexes;
}

function joinCodexParts(before: readonly string[], block: readonly string[], after: readonly string[], eol: string): string {
  const combined = [...before];
  if (combined.length > 0 && combined[combined.length - 1].trim() !== '') combined.push('');
  combined.push(...block);
  if (after.length > 0) {
    if (after[0].trim() !== '') combined.push('');
    combined.push(...after);
  }
  const content = combined.join(eol);
  return after.length === 0 && !content.endsWith(eol) ? `${content}${eol}` : content;
}

function hasAmbiguousCodexDeclaration(lines: readonly string[]): boolean {
  let inMcpServersTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (TOML_TABLE_HEADER.test(line)) {
      inMcpServersTable = /^\s*\[\s*mcp_servers\s*\]\s*(?:#.*)?$/.test(line);
      continue;
    }

    if (/^\s*["']?mcp_servers["']?\s*=/.test(line)) {
      return true;
    }
    if (/^\s*mcp_servers\s*\.\s*(?:vite_debugger|vite-debugger|["']vite_debugger["']|["']vite-debugger["'])\s*(?:\.|=)/.test(line)) {
      return true;
    }
    if (inMcpServersTable && /^\s*(?:vite_debugger|vite-debugger|["']vite_debugger["']|["']vite-debugger["'])\s*=/.test(line)) {
      return true;
    }
  }
  return false;
}

function parseCodexDocument(source: string): TomlTable {
  try {
    return parseToml(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentConfigurationError(`.codex/config.toml is not valid TOML: ${message}`);
  }
}

function codexServerAliases(document: TomlTable): string[] {
  const servers = document.mcp_servers;
  if (!isRecord(servers)) return [];
  return ['vite_debugger', 'vite-debugger'].filter((key) =>
    Object.prototype.hasOwnProperty.call(servers, key));
}

function codexDocumentWithoutViteServer(document: TomlTable): Record<string, unknown> {
  const result: Record<string, unknown> = { ...document };
  if (!isRecord(document.mcp_servers)) return result;

  const servers: Record<string, unknown> = { ...document.mcp_servers };
  delete servers.vite_debugger;
  delete servers['vite-debugger'];
  if (Object.keys(servers).length === 0) delete result.mcp_servers;
  else result.mcp_servers = servers;
  return result;
}

export function mergeCodexConfiguration(
  existing: string | undefined,
  launch: AgentMcpLaunch,
): ConfigurationMergeResult {
  const source = existing ?? '';
  const documentBefore = parseCodexDocument(source);
  const aliasesBefore = codexServerAliases(documentBefore);
  if (aliasesBefore.length > 1) {
    throw new AgentConfigurationError(
      '.codex/config.toml defines both vite_debugger and vite-debugger MCP servers.',
    );
  }
  const eol = detectEol(source);
  const lines = source.length > 0 ? source.split(/\r?\n/) : [];
  const beginIndexes = findLineIndexes(lines, (line) => line.trim() === CODEX_BLOCK_BEGIN);
  const endIndexes = findLineIndexes(lines, (line) => line.trim() === CODEX_BLOCK_END);

  if (beginIndexes.length !== endIndexes.length || beginIndexes.length > 1) {
    throw new AgentConfigurationError(
      'The managed Vite Debugger block in .codex/config.toml is incomplete or duplicated.',
    );
  }

  const block = renderCodexMcpBlock(launch, eol).split(eol);
  const sectionIndexes = findLineIndexes(lines, (line) => CODEX_SERVER_HEADER.test(line));
  let content: string;

  if (beginIndexes.length === 1) {
    const start = beginIndexes[0];
    const end = endIndexes[0];
    if (end < start) {
      throw new AgentConfigurationError(
        'The managed Vite Debugger block in .codex/config.toml has invalid marker order.',
      );
    }
    if (sectionIndexes.some((index) => index < start || index > end)) {
      throw new AgentConfigurationError(
        'A second Vite Debugger MCP section exists outside the managed block in .codex/config.toml.',
      );
    }
    content = joinCodexParts(lines.slice(0, start), block, lines.slice(end + 1), eol);
  } else {
    if (sectionIndexes.length > 1) {
      throw new AgentConfigurationError(
        'More than one Vite Debugger MCP section exists in .codex/config.toml.',
      );
    }

    if (sectionIndexes.length === 1) {
      const start = sectionIndexes[0];
      let end = start + 1;
      while (end < lines.length && !TOML_TABLE_HEADER.test(lines[end])) end += 1;
      let preservedSuffix = end;
      while (
        preservedSuffix > start + 1 &&
        (lines[preservedSuffix - 1].trim() === '' || lines[preservedSuffix - 1].trimStart().startsWith('#'))
      ) {
        preservedSuffix -= 1;
      }
      content = joinCodexParts(lines.slice(0, start), block, lines.slice(preservedSuffix), eol);
    } else {
      if (aliasesBefore.length > 0 || hasAmbiguousCodexDeclaration(lines)) {
        throw new AgentConfigurationError(
          'A Vite Debugger MCP entry uses an unsupported inline or dotted TOML form. Remove that entry and run setup again.',
        );
      }
      content = joinCodexParts(lines, block, [], eol);
    }
  }

  const documentAfter = parseCodexDocument(content);
  const aliasesAfter = codexServerAliases(documentAfter);
  if (aliasesAfter.length !== 1 || aliasesAfter[0] !== 'vite_debugger') {
    throw new AgentConfigurationError(
      'The generated Codex configuration did not contain exactly one Vite Debugger MCP server.',
    );
  }
  if (!isDeepStrictEqual(
    codexDocumentWithoutViteServer(documentBefore),
    codexDocumentWithoutViteServer(documentAfter),
  )) {
    throw new AgentConfigurationError(
      'The existing TOML layout cannot be updated safely without changing unrelated settings. Use the copy command for manual setup.',
    );
  }

  return { content, change: changeFor(existing, content) };
}

export function createClaudeServerDefinition(launch: AgentMcpLaunch): Record<string, unknown> {
  return {
    type: 'stdio',
    command: 'node',
    args: [launch.launcherPath, '--workspace', launch.workspacePath],
  };
}

function jsonFormatting(source: string): {
  insertSpaces: boolean;
  tabSize: number;
  eol: string;
} {
  const eol = detectEol(source);
  const indentation = source.match(/(?:^|\r?\n)([\t ]+)"[^"\r\n]+"\s*:/)?.[1];
  if (indentation?.includes('\t')) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: indentation?.length || 2, eol };
}

function describeJsonError(source: string, error: ParseError): string {
  const before = source.slice(0, error.offset);
  const line = before.split(/\r?\n/).length;
  return `${printParseErrorCode(error.error)} at line ${line}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonPropertiesNamed(node: JsonNode | undefined, name: string): JsonNode[] {
  if (!node || node.type !== 'object') return [];
  return (node.children ?? []).filter((property) => (
    property.type === 'property' && property.children?.[0]?.value === name
  ));
}

function assertNoDuplicateClaudeKeys(root: JsonNode | undefined): void {
  const mcpServers = jsonPropertiesNamed(root, 'mcpServers');
  if (mcpServers.length > 1) {
    throw new AgentConfigurationError('.mcp.json contains more than one mcpServers property.');
  }
  if (mcpServers.length === 0) return;

  const serverObject = mcpServers[0].children?.[1];
  const viteDebuggerServers = jsonPropertiesNamed(serverObject, 'vite-debugger');
  if (viteDebuggerServers.length > 1) {
    throw new AgentConfigurationError(
      '.mcp.json contains more than one vite-debugger entry inside mcpServers.',
    );
  }
}

export function mergeClaudeConfiguration(
  existing: string | undefined,
  launch: AgentMcpLaunch,
): ConfigurationMergeResult {
  const original = existing ?? '';
  const eol = detectEol(original);
  const hasByteOrderMark = original.startsWith('\uFEFF');
  const withoutByteOrderMark = hasByteOrderMark ? original.slice(1) : original;
  const source = withoutByteOrderMark.trim().length === 0 ? '{}' : withoutByteOrderMark;
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: true, disallowComments: false });

  if (errors.length > 0) {
    throw new AgentConfigurationError(
      `.mcp.json is not valid JSON/JSONC: ${describeJsonError(source, errors[0])}.`,
    );
  }
  if (!isRecord(parsed)) {
    throw new AgentConfigurationError('.mcp.json must contain a JSON object at its root.');
  }
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    throw new AgentConfigurationError('The mcpServers property in .mcp.json must be a JSON object.');
  }
  const treeErrors: ParseError[] = [];
  const tree = parseTree(source, treeErrors, { allowTrailingComma: true, disallowComments: false });
  if (treeErrors.length > 0) {
    throw new AgentConfigurationError(
      `.mcp.json is not valid JSON/JSONC: ${describeJsonError(source, treeErrors[0])}.`,
    );
  }
  assertNoDuplicateClaudeKeys(tree);

  const edits = modify(
    source,
    ['mcpServers', 'vite-debugger'],
    createClaudeServerDefinition(launch),
    { formattingOptions: jsonFormatting(source) },
  );
  let content = `${hasByteOrderMark ? '\uFEFF' : ''}${applyEdits(source, edits)}`;
  if (existing === undefined && !content.endsWith(eol)) content += eol;

  return { content, change: changeFor(existing, content) };
}
