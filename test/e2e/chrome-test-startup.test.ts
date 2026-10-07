import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { launchTestChrome } from '../helpers/chrome';

const { Launcher } = createRequire(import.meta.url)('chrome-launcher') as typeof import('chrome-launcher');

describe('Chrome test startup ownership', () => {
  it('waits for a debug port that becomes available after the former five-second deadline', async () => {
    let processHandle: ChildProcess | undefined;
    let profile: string | undefined;
    const internals = Launcher.prototype as unknown as { spawnProcess(executable: string): Promise<number> };
    const start = vi.spyOn(internals, 'spawnProcess').mockImplementation(async function (this: InstanceType<typeof Launcher>) {
      profile = this.userDataDir;
      processHandle = this.chromeProcess = spawn(process.execPath, ['-e',
        "setTimeout(() => require('net').createServer(socket => socket.end()).listen(Number(process.argv[1]), '127.0.0.1'), 6000)",
        String(this.port),
      ], { detached: process.platform !== 'win32', stdio: 'ignore' });
      this.pid = processHandle.pid;
      await this.waitUntilReady();
      return processHandle.pid!;
    });
    let chrome: Awaited<ReturnType<typeof launchTestChrome>> | undefined;
    try {
      chrome = await launchTestChrome();
      expect(chrome.port).toBeGreaterThan(0);
      await chrome.kill();
      expect(fs.existsSync(profile!)).toBe(false);
    } finally {
      await chrome?.kill();
      processHandle?.kill('SIGKILL');
      if (profile) fs.rmSync(profile, { recursive: true, force: true });
      start.mockRestore();
    }
  });

  it('releases the spawned process and owned profile when readiness fails', async () => {
    let processHandle: ChildProcess | undefined;
    let profile: string | undefined;
    const failure = new Error('debug port never became ready');
    const start = vi.spyOn(Launcher.prototype, 'launch').mockImplementation(async function (this: InstanceType<typeof Launcher>) {
      profile = this.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-debugger-failed-start-'));
      processHandle = this.chromeProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: process.platform !== 'win32', stdio: 'ignore',
      });
      this.pid = processHandle.pid;
      throw failure;
    });
    try {
      await expect(launchTestChrome()).rejects.toBe(failure);
      expect(fs.existsSync(profile!)).toBe(false);
      await vi.waitFor(() => expect(() => process.kill(processHandle!.pid!, 0)).toThrow());
    } finally {
      processHandle?.kill('SIGKILL');
      if (profile) fs.rmSync(profile, { recursive: true, force: true });
      start.mockRestore();
    }
  });
});
