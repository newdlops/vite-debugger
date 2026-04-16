import * as vscode from 'vscode';

export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
}

let outputChannel: vscode.OutputChannel | undefined;
let currentLevel = LogLevel.Info;

export function initLogger(channel: vscode.OutputChannel, level: LogLevel = LogLevel.Info): void {
  outputChannel = channel;
  currentLevel = level;
}

function log(level: LogLevel, prefix: string, message: string, ...args: unknown[]): void {
  if (level < currentLevel) return;
  const timestamp = new Date().toISOString().slice(11, 23);
  const formatted = args.length > 0
    ? `[${timestamp}] ${prefix} ${message} ${args.map(a => JSON.stringify(a)).join(' ')}`
    : `[${timestamp}] ${prefix} ${message}`;
  outputChannel?.appendLine(formatted);
}

export const logger = {
  debug: (message: string, ...args: unknown[]) => log(LogLevel.Debug, '[DEBUG]', message, ...args),
  info: (message: string, ...args: unknown[]) => log(LogLevel.Info, '[INFO]', message, ...args),
  warn: (message: string, ...args: unknown[]) => log(LogLevel.Warn, '[WARN]', message, ...args),
  error: (message: string, ...args: unknown[]) => log(LogLevel.Error, '[ERROR]', message, ...args),
};
