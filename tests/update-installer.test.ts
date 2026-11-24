// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchInstallerAfterExit } from '../electron/update-installer';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const base = path.resolve('.test-data');
const dirs: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) {
    if (path.dirname(dir) !== base) throw new Error('测试目录越界');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
async function fixture() {
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'update-launch-'));
  dirs.push(dir);
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    unref: vi.fn(),
  });
  const spawned = vi.mocked(spawn);
  spawned.mockReturnValue(child as never);
  const helper = path.join(dir, 'update-helper.exe');
  await fs.writeFile(helper, 'trusted fixture helper');
  const ready = launchInstallerAfterExit(
    'fixture.exe',
    '0'.repeat(64),
    dir,
    dir,
    helper,
    path.join(dir, 'Runtime'),
  );
  await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(1));
  return { dir, child, ready, spawned };
}
it('独立 Windows 助手隐藏窗口并脱离父进程，收到完整就绪信号才释放管道', async () => {
  const f = await fixture();
  const helper = String(f.spawned.mock.calls[0][0]);
  expect(path.dirname(helper)).toBe(path.join(f.dir, 'Runtime'));
  expect(path.basename(helper)).toMatch(/^update-handoff-[a-f0-9]{64}\.exe$/);
  expect(await fs.readFile(helper, 'utf8')).toBe('trusted fixture helper');
  expect(f.spawned.mock.calls[0][2]).toEqual({
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  f.child.stdout.write('UPDATE_');
  expect(f.child.unref).not.toHaveBeenCalled();
  f.child.stdout.write('READY\r\n');
  await f.ready;
  expect(f.child.unref).toHaveBeenCalledTimes(1);
  expect(f.child.kill).not.toHaveBeenCalled();
  expect(f.child.stdout.destroyed).toBe(true);
  expect(f.child.stderr.destroyed).toBe(true);
});
it('助手就绪前以零退出仍拒绝交接，并保存退出码与错误输出供排查', async () => {
  const f = await fixture();
  const rejected = expect(f.ready).rejects.toThrow('退出码 0');
  f.child.stderr.write('fixture helper diagnostic');
  f.child.emit('exit', 0, null);
  await rejected;
  const log = await fs.readFile(path.join(f.dir, 'update-install.log'), 'utf8');
  expect(log).toContain('退出码 0');
  expect(log).toContain('fixture helper diagnostic');
  expect(f.child.unref).not.toHaveBeenCalled();
});
it('系统拒绝启动助手时保持失败，保存具体系统原因', async () => {
  const f = await fixture();
  const rejected = expect(f.ready).rejects.toThrow('EACCES');
  f.child.emit('error', new Error('EACCES fixture'));
  await rejected;
  expect(await fs.readFile(path.join(f.dir, 'update-install.log'), 'utf8')).toContain(
    'EACCES fixture',
  );
  expect(f.child.unref).not.toHaveBeenCalled();
});
