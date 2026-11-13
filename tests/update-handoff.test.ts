// @vitest-environment node
import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { installerScript } from '../electron/update-installer';

it.skipIf(process.platform !== 'win32')(
  'Windows 助手在父进程存活时不启动，正常退出后只启动无害测试脚本',
  async () => {
    const base = path.resolve('.test-data');
    await fs.mkdir(base, { recursive: true });
    const dir = await fs.mkdtemp(path.join(base, 'update-handoff-'));
    const marker = path.join(dir, 'launched.txt');
    const file = path.join(dir, 'setup-fixture.cmd');
    const payload = Buffer.from('@echo off\r\necho launched>"%~dp0launched.txt"\r\n', 'ascii');
    await fs.writeFile(file, payload);
    const parent = spawn(
      process.execPath,
      ['-e', "process.stdin.once('data', () => process.exit(0));"],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] },
    );
    await once(parent, 'spawn');
    const script = installerScript(
      file,
      createHash('sha256').update(payload).digest('hex'),
      path.join(dir, "中文 空格 ' $目录"),
      path.join(dir, 'helper.log'),
      parent.pid!,
    );
    const helper = spawn(
      path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const finished = once(helper, 'exit');
    try {
      await new Promise<void>((resolve, reject) => {
        let text = '';
        const timer = setTimeout(() => reject(new Error('助手未就绪')), 20000);
        helper.stdout.on('data', (data) => {
          text += String(data);
          if (text.includes('UPDATE_READY')) {
            clearTimeout(timer);
            resolve();
          }
        });
        helper.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        helper.stderr.on('data', () => {});
      });
      expect(
        await fs
          .stat(marker)
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
      parent.stdin.end('exit');
      expect((await finished)[0], await fs.readFile(path.join(dir, 'helper.log'), 'utf8').catch(() => '没有助手错误日志')).toBe(0);
      await expect
        .poll(async () => fs.readFile(marker, 'utf8').catch(() => ''))
        .toContain('launched');
    } finally {
      if (parent.exitCode === null) parent.kill();
      if (helper.exitCode === null) helper.kill();
      if (path.dirname(dir) !== base) throw new Error('测试目录越界');
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
  40000,
);
