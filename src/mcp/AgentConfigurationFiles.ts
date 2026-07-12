import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AgentConfigurationError } from './AgentConfiguration';

const MAX_CONFIGURATION_BYTES = 2 * 1024 * 1024;

export interface ExistingConfiguration {
  content: string | undefined;
  mode: number | undefined;
}

export interface FileConfigurationUpdate {
  workspacePath: string;
  filePath: string;
  original: ExistingConfiguration;
  content: string;
}

export interface ConfigurationTransactionHooks {
  assertDocumentSaved?(filePath: string): Promise<void>;
}

interface StagedConfiguration {
  configuration: FileConfigurationUpdate;
  temporaryPath: string;
}

export interface StableMcpLauncherOptions {
  storagePath: string;
  bundledServerPath: string;
  version: string;
  bridgeDirectoryPath?: string;
}

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isFileAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function withFileLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 5_000;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;

  while (!handle) {
    try {
      const candidate = await fs.open(lockPath, 'wx', 0o600);
      try {
        await candidate.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
        handle = candidate;
      } catch (writeError) {
        await candidate.close().catch(() => undefined);
        try { await fs.unlink(lockPath); } catch { /* best effort */ }
        throw writeError;
      }
    } catch (error) {
      if (!isFileAlreadyExists(error)) throw error;

      let stale = false;
      try {
        const stat = await fs.lstat(lockPath);
        if (stat.isSymbolicLink()) {
          throw new AgentConfigurationError(`Refusing symbolic-link MCP setup lock: ${lockPath}`);
        }
        try {
          const lock = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { pid?: unknown; createdAt?: unknown };
          stale = typeof lock.pid !== 'number' || !isProcessAlive(lock.pid) ||
            typeof lock.createdAt !== 'number' || Date.now() - lock.createdAt > 5 * 60_000;
        } catch {
          stale = Date.now() - stat.mtimeMs > 5 * 60_000;
        }
      } catch (readError) {
        if (readError instanceof AgentConfigurationError) throw readError;
        stale = isFileNotFound(readError);
      }

      if (stale) {
        try { await fs.unlink(lockPath); } catch (unlinkError) {
          if (!isFileNotFound(unlinkError)) throw unlinkError;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new AgentConfigurationError('Another Vite Debugger window is configuring MCP. Try again shortly.');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  try {
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    try { await fs.unlink(lockPath); } catch { /* stale cleanup handles leftovers */ }
  }
}

export async function readConfiguration(filePath: string): Promise<ExistingConfiguration> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (isFileNotFound(error)) return { content: undefined, mode: undefined };
    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new AgentConfigurationError(`Refusing to update symbolic link: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new AgentConfigurationError(`Configuration path is not a file: ${filePath}`);
  }
  if (stat.size > MAX_CONFIGURATION_BYTES) {
    throw new AgentConfigurationError(`Configuration is larger than 2 MiB: ${filePath}`);
  }
  return {
    content: await fs.readFile(filePath, 'utf8'),
    mode: stat.mode & 0o777,
  };
}

async function ensureSafeConfigurationDirectory(directoryPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(directoryPath);
    if (stat.isSymbolicLink()) {
      throw new AgentConfigurationError(`Refusing to use symbolic link: ${directoryPath}`);
    }
    if (!stat.isDirectory()) {
      throw new AgentConfigurationError(`Configuration parent is not a directory: ${directoryPath}`);
    }
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
    await fs.mkdir(directoryPath, { mode: 0o700 });
    const created = await fs.lstat(directoryPath);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new AgentConfigurationError(`Could not create a safe configuration directory: ${directoryPath}`);
    }
  }
}

export async function assertSafeConfigurationParent(
  filePath: string,
  workspacePath: string,
): Promise<void> {
  const directoryPath = path.dirname(filePath);
  if (path.resolve(directoryPath) === path.resolve(workspacePath)) return;

  try {
    const stat = await fs.lstat(directoryPath);
    if (stat.isSymbolicLink()) {
      throw new AgentConfigurationError(`Refusing to use symbolic link: ${directoryPath}`);
    }
    if (!stat.isDirectory()) {
      throw new AgentConfigurationError(`Configuration parent is not a directory: ${directoryPath}`);
    }
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
}

async function assertConfigurationUnchanged(
  configuration: FileConfigurationUpdate,
  hooks: ConfigurationTransactionHooks,
): Promise<void> {
  await hooks.assertDocumentSaved?.(configuration.filePath);
  const current = await readConfiguration(configuration.filePath);
  if (current.content !== configuration.original.content) {
    throw new AgentConfigurationError(
      `${configuration.filePath} changed while MCP setup was running. Setup stopped before updating that file.`,
    );
  }
}

async function createTemporarySibling(filePath: string, content: string, mode: number): Promise<string> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  await fs.writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode });
  return temporaryPath;
}

async function replaceWithTemporaryFile(temporaryPath: string, filePath: string): Promise<void> {
  await fs.rename(temporaryPath, filePath);
}

async function replaceFileAtomically(filePath: string, content: string, mode: number): Promise<void> {
  const temporaryPath = await createTemporarySibling(filePath, content, mode);
  try {
    await replaceWithTemporaryFile(temporaryPath, filePath);
  } catch (error) {
    try { await fs.unlink(temporaryPath); } catch { /* nothing to clean up */ }
    throw error;
  }
}

async function stageConfiguration(
  configuration: FileConfigurationUpdate,
  hooks: ConfigurationTransactionHooks,
): Promise<StagedConfiguration> {
  const directoryPath = path.dirname(configuration.filePath);
  if (path.resolve(directoryPath) !== path.resolve(configuration.workspacePath)) {
    await ensureSafeConfigurationDirectory(directoryPath);
  }
  await assertSafeConfigurationParent(configuration.filePath, configuration.workspacePath);
  await assertConfigurationUnchanged(configuration, hooks);
  return {
    configuration,
    temporaryPath: await createTemporarySibling(
      configuration.filePath,
      configuration.content,
      configuration.original.mode ?? 0o600,
    ),
  };
}

async function rollbackConfiguration(configuration: FileConfigurationUpdate): Promise<void> {
  await assertSafeConfigurationParent(configuration.filePath, configuration.workspacePath);
  const current = await readConfiguration(configuration.filePath);
  if (current.content !== configuration.content) {
    throw new AgentConfigurationError(
      `Refusing to roll back ${configuration.filePath} because it changed after setup wrote it.`,
    );
  }

  if (configuration.original.content === undefined) {
    await fs.unlink(configuration.filePath);
    return;
  }
  await replaceFileAtomically(
    configuration.filePath,
    configuration.original.content,
    configuration.original.mode ?? 0o600,
  );
}

export async function writeConfigurationTransaction(
  configurations: readonly FileConfigurationUpdate[],
  hooks: ConfigurationTransactionHooks = {},
): Promise<void> {
  const staged: StagedConfiguration[] = [];
  const committed: FileConfigurationUpdate[] = [];

  try {
    for (const configuration of configurations) {
      staged.push(await stageConfiguration(configuration, hooks));
    }
    for (const item of staged) {
      await assertSafeConfigurationParent(item.configuration.filePath, item.configuration.workspacePath);
      await assertConfigurationUnchanged(item.configuration, hooks);
    }
    for (const item of staged) {
      await assertSafeConfigurationParent(item.configuration.filePath, item.configuration.workspacePath);
      await assertConfigurationUnchanged(item.configuration, hooks);
      await replaceWithTemporaryFile(item.temporaryPath, item.configuration.filePath);
      committed.push(item.configuration);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const configuration of [...committed].reverse()) {
      try { await rollbackConfiguration(configuration); } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    if (rollbackErrors.length > 0) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AgentConfigurationError(
        `${message} Automatic rollback was incomplete: ${rollbackErrors.join('; ')}`,
      );
    }
    throw error;
  } finally {
    for (const item of staged) {
      try { await fs.unlink(item.temporaryPath); } catch { /* committed or already cleaned up */ }
    }
  }
}

function launcherTargetFromSource(source: string): string | undefined {
  const match = source.match(/const \{ runMcpServer \} = require\(("(?:[^"\\]|\\.)*")\);/);
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[1]);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function compareVersions(left: string, right: string): number {
  const parts = (value: string) => value.split(/[.+-]/).slice(0, 3).map((part) => Number(part) || 0);
  const leftParts = parts(left);
  const rightParts = parts(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function renderLauncherSource(
  bundledServerPath: string,
  version: string,
  bridgeDirectoryPath?: string,
): string {
  return [
    `// vite-debugger-version: ${version}`,
    "'use strict';",
    `const { runMcpServer } = require(${JSON.stringify(bundledServerPath)});`,
    'const args = process.argv.slice(2);',
    ...(bridgeDirectoryPath ? [
      "if (!args.some((value) => value === '--bridge-dir' || value.startsWith('--bridge-dir='))) {",
      `  args.push('--bridge-dir', ${JSON.stringify(bridgeDirectoryPath)});`,
      '}',
    ] : []),
    'runMcpServer(args).catch((error) => {',
    "  const message = error instanceof Error ? (error.stack || error.message) : String(error);",
    "  process.stderr.write('[vite-debugger-mcp] Startup failed: ' + message + '\\n');",
    '  process.exitCode = 1;',
    '});',
    '',
  ].join('\n');
}

export async function prepareStableMcpLauncher(options: StableMcpLauncherOptions): Promise<string> {
  await fs.access(options.bundledServerPath);
  await fs.mkdir(options.storagePath, { recursive: true, mode: 0o700 });
  const storageStat = await fs.lstat(options.storagePath);
  if (storageStat.isSymbolicLink() || !storageStat.isDirectory()) {
    throw new AgentConfigurationError(`Unsafe MCP launcher storage path: ${options.storagePath}`);
  }

  const launcherPath = path.join(options.storagePath, 'vite-debugger-mcp.cjs');
  const source = renderLauncherSource(
    options.bundledServerPath,
    options.version,
    options.bridgeDirectoryPath,
  );
  await withFileLock(`${launcherPath}.lock`, async () => {
    const existing = await readConfiguration(launcherPath);
    const existingVersion = existing.content?.match(/^\/\/ vite-debugger-version: ([^\r\n]+)/)?.[1];
    const existingTarget = existing.content ? launcherTargetFromSource(existing.content) : undefined;
    const existingTargetAvailable = existingTarget
      ? await fs.access(existingTarget).then(() => true, () => false)
      : false;
    if (existingVersion && compareVersions(existingVersion, options.version) > 0 && existingTargetAvailable) {
      return;
    }
    if (existing.content !== source) {
      await replaceFileAtomically(launcherPath, source, existing.mode ?? 0o600);
    }
  });
  return launcherPath;
}
