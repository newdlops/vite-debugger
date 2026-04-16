import * as vscode from 'vscode';

// Common JS/TS keywords to exclude from variable detection
const KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of',
  'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined',
  'var', 'void', 'while', 'with', 'yield', 'async', 'await', 'from', 'as', 'type',
  'interface', 'implements', 'package', 'private', 'protected', 'public', 'static',
  'readonly', 'abstract', 'declare', 'module', 'namespace', 'require',
]);

export class ViteInlineValuesProvider implements vscode.InlineValuesProvider {
  provideInlineValues(
    document: vscode.TextDocument,
    viewPort: vscode.Range,
    context: vscode.InlineValueContext,
    _token: vscode.CancellationToken
  ): vscode.InlineValue[] {
    const values: vscode.InlineValue[] = [];
    const seen = new Set<string>();

    // Only show inline values up to the stopped line
    const endLine = Math.min(viewPort.end.line, context.stoppedLocation.end.line);

    for (let lineNum = viewPort.start.line; lineNum <= endLine; lineNum++) {
      const line = document.lineAt(lineNum);
      const text = line.text;

      // Skip empty lines and comments
      const trimmed = text.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

      // Find identifiers in the line using regex
      // Match word boundaries for JS/TS identifiers (not starting with digit)
      const identifierRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
      let match;

      while ((match = identifierRegex.exec(text)) !== null) {
        const name = match[1];
        const col = match.index;

        // Skip keywords, short names that are likely loop vars in imports, etc.
        if (KEYWORDS.has(name)) continue;
        if (name.length < 2) continue;  // skip single-char vars like i, j

        // Skip if inside a string (basic heuristic: check quote counts before position)
        const before = text.slice(0, col);
        const singleQuotes = (before.match(/'/g) || []).length;
        const doubleQuotes = (before.match(/"/g) || []).length;
        const backticks = (before.match(/`/g) || []).length;
        if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0 || backticks % 2 !== 0) continue;

        // Skip duplicates on the same line
        const key = `${lineNum}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const range = new vscode.Range(lineNum, col, lineNum, col + name.length);
        values.push(new vscode.InlineValueVariableLookup(range, name));
      }
    }

    return values;
  }
}
