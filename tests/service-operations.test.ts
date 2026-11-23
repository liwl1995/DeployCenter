// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import Sqlite from 'better-sqlite3';
import { emptyDatabase, newService, newTargetTemplate } from '../src/defaults';
import type { Server } from '../src/model';
import { ServiceOperations, operationCommands, operationScript } from '../electron/service-operations';
import { Storage } from '../electron/storage';
import { runProcess } from '../electron/process';
import type { Transport } from '../electron/ssh';

const root = path.resolve('.test-data');
const fixtures: { directory: string; store: Storage }[] = [];
afterEach(async () => {
  for (const { directory, store } of fixtures.splice(0)) {
    store.close();
    if (path.dirname(directory) === root) await fs.rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'operations-'));
  const store = new Storage(directory, { encrypt: async (value) => Buffer.from(value), decrypt: async (value) => value.toString() });
  fixtures.push({ directory, store });
  const service = { ...newService(), id: 'crm', name: 'CRM', code: 'crm', root: directory };
  const server: Server = { id: 'node', name: '测试服务器', auth: 'alias', alias: 'mock-only', host: '', port: 22, user: '', keyPath: '', note: '', credentialMode: 'ask' };
  const target = {
    ...newTargetTemplate(service.id, server.id), id: 'target', directory: '/opt/crm',
    name: '正式环境', production: true, start: './app.jar start', stop: './app.jar stop',
  };
  store.saveConfig({ ...emptyDatabase(), services: [service], servers: [server], targets: [target] });
  return { directory, store, target };
}

it('按动作生成命令，Docker 重启与普通 JAR 的显式启停分别处理', async () => {
  const { target } = await fixture();
  expect(operationCommands({ ...target, mode: 'jar', restart: './restart.sh' }, 'start')).toEqual(['./app.jar start']);
  expect(operationCommands({ ...target, mode: 'jar', restart: '' }, 'restart')).toEqual(['./app.jar stop', './app.jar start']);
  expect(() => operationCommands({ ...target, mode: 'jar', restart: '', stop: '' }, 'restart')).toThrow(/配置/);
  expect(operationCommands({ ...target, mode: 'docker', container: 'crm' }, 'restart')).toEqual([
    "docker stop --time 30 -- 'crm'", "docker start -- 'crm'",
  ]);
});

it('生产确认、配置变更、全局互斥和脱敏留痕', async () => {
  const { target, store } = await fixture();
  const started = vi.fn();
  const publish = vi.fn();
  const connect = vi.fn(async () => ({
    secret: 'secret-value',
    transport: {
      connect: async () => {}, close: () => {},
      channel: async () => {
        const input = new PassThrough(), output = new PassThrough(), error = new PassThrough();
        const done = new Promise<number>((resolve) => {
          input.once('data', (data) => {
            const marker = String(data).match(/MARKER='([^']+)'/)?.[1];
            output.write('运行 secret-'); output.write('value\n');
            output.end(marker + '\tsuccess\t操作已确认\n');
            error.end(); resolve(0);
          });
        });
        started();
        return { input, output, error, done, stop: () => {} };
      },
    } as unknown as Transport,
  }));
  const operations = new ServiceOperations(store, connect, () => undefined, publish);
  const plan = operations.prepare(target.id, 'start');
  await expect(operations.run(plan.token, '错误名称', false, '')).rejects.toThrow(/正式环境/);
  expect(connect).not.toHaveBeenCalled();
  const run = operations.run(plan.token, target.name, false, '');
  expect(() => operations.prepare(target.id, 'stop')).toThrow(/正在执行/);
  const record = await run;
  expect(started).toHaveBeenCalledTimes(1);
  expect(record.result).toBe('success');
  expect(record.logs).not.toContain('secret-value');
  expect(operations.list(target.id)[0]).toMatchObject({ id: record.id, result: 'success' });
  const next = operations.prepare(target.id, 'stop');
  const db = store.database();
  db.targets[0].stop = 'changed';
  store.saveConfig(db);
  await expect(operations.run(next.token, target.name, false, '')).rejects.toThrow(/配置已变化/);
  expect(connect).toHaveBeenCalledTimes(1);
});

it('远程无终态标记时留待核实，目标有锁时拒绝人工解除', async () => {
  const { target, store } = await fixture();
  let locked = true;
  const operations = new ServiceOperations(store, async () => ({
    secret: '',
    transport: {
      connect: async () => {}, close: () => {},
      exec: async () => ({ code: 0, stdout: 'not-found\t' + Number(locked) + '\t\t\t\t\t\n', stderr: '' }),
      channel: async () => ({
        input: new PassThrough(), output: new PassThrough(), error: new PassThrough(),
        stop: () => {}, done: Promise.resolve(-1),
      }),
    } as unknown as Transport,
  }), () => undefined, () => {});
  const plan = operations.prepare(target.id, 'start');
  const record = await operations.run(plan.token, target.name, true, '');
  expect(record.result).toBe('unknown');
  expect(() => operations.prepare(target.id, 'start')).toThrow(/待核实/);
  await expect(operations.settle(target.id, record.id, target.name, '')).rejects.toThrow(/目标锁/);
  locked = false;
  await expect(operations.settle(target.id, record.id, target.name, '')).resolves.toMatchObject({ result: 'unknown', settled: true });
  expect(operations.prepare(target.id, 'start').token).toBeTruthy();
});

it('从 2.3.3 数据库升级时保留旧配置并初始化运维记录', async () => {
  const { target, directory, store } = await fixture();
  store.close();
  const old = new Sqlite(path.join(directory, 'deploy-center.sqlite'));
  try { old.exec('DROP TABLE service_operations; PRAGMA user_version=6;'); }
  finally { old.close(); }
  const backupBefore = (await fs.readdir(path.join(directory, 'backups'))).length;
  const reopened = new Storage(directory, { encrypt: async (value) => Buffer.from(value), decrypt: async (value) => value.toString() });
  fixtures[fixtures.length - 1].store = reopened;
  expect(reopened.database().targets[0]).toMatchObject({ id: target.id, start: target.start, production: true });
  expect(reopened.operations('isolated')).toEqual([]);
  expect((await fs.readdir(path.join(directory, 'backups'))).length).toBeGreaterThan(backupBefore);
});

const bash = process.env.DEPLOY_CENTER_TEST_BASH || (process.platform === 'win32'
  ? (spawnSync('where.exe', ['git.exe'], { encoding: 'utf8' }).stdout || '').split(/\r?\n/)
    .filter(Boolean).map((file) => path.resolve(path.dirname(file.trim()), '../bin/bash.exe')).find(existsSync)
  : '/bin/bash');
it('Docker 无健康检查仍显示运行，探测失败时保留脱敏后的原因', async () => {
  const { target, store } = await fixture();
  const db = store.database();
  db.targets[0] = { ...target, mode: 'docker', container: 'crm' };
  store.saveConfig(db);
  const exec = vi.fn()
    .mockResolvedValueOnce({ code: 0, stdout: 'running\t0\t\t\t0\tnone\t2026-01-01T00:00:00Z\n', stderr: '' })
    .mockResolvedValueOnce({ code: 0, stdout: 'unknown\t0\t\t\t\t\t\n', stderr: 'permission denied: secret-value\n' });
  const operations = new ServiceOperations(store, async () => ({
    secret: 'secret-value',
    transport: { connect: async () => {}, close: () => {}, exec } as unknown as Transport,
  }), () => undefined, () => {});
  await expect(operations.status(target.id, '')).resolves.toMatchObject({ state: 'running', health: 'none', restarts: 0 });
  expect(exec.mock.calls[0][1].input).toContain('with index .State "Health"');
  const failure = await operations.status(target.id, '');
  expect(failure.message).toContain('permission denied');
  expect(failure.message).not.toContain('secret-value');
});
it.skipIf(!bash)(
  '用真实 Bash 和模拟 Docker 执行运维脚本并核对远端锁',
  async () => {
    const { target, directory } = await fixture();
    const remote = directory.replace(/\\/g, '/').replace(/^([a-z]):/i, (_, drive: string) => '/' + drive.toLowerCase());
    const source = operationScript({ ...target, mode: 'docker', container: 'crm', directory: remote, stabilitySeconds: 0 }, 'DC-OPS-fixture', 'stop', false)
      .replace('run_operation\n', `
dc_proc() { printf 123; }
flock() { return 0; }
mkdir() { if [ "$1" = -m ]; then shift 2; fi; command mkdir "$@"; }
cat() { if [ "$1" = /proc/sys/kernel/random/boot_id ]; then printf 01234567-0123-0123-0123-012345678901; else command cat "$@"; fi; }
timeout() { if [[ "$1" = --* ]]; then shift; fi; shift; "$@"; }
docker() {
  if [ "$1" = stop ]; then touch "$DIR/stopped"; return 0; fi
  if [ -e "$DIR/stopped" ]; then printf 'false false exited 0 none 2026-01-01T00:00:00Z test-container';
  else printf 'true false running 0 healthy 2026-01-01T00:00:00Z test-container'; fi
}
run_operation
`);
    const file = path.join(directory, 'fixture.sh');
    await fs.writeFile(file, source);
    const exec = () => runProcess(bash!,
      [file.replace(/\\/g, '/')], { timeout: 10000 });
    await fs.mkdir(path.join(directory, '.deploy-center'));
    await fs.writeFile(path.join(directory, '.deploy-center', 'state'), 'RUNNING');
    const blocked = await exec();
    expect(blocked.stdout, blocked.stderr).toContain('blocked\t远程存在未收尾');
    await expect(fs.stat(path.join(directory, 'stopped'))).rejects.toThrow();
    await fs.unlink(path.join(directory, '.deploy-center', 'state'));
    const done = await exec();
    expect(done.stdout).toContain('success\t容器已停止');
    await expect(fs.stat(path.join(directory, '.deploy-center.lock'))).rejects.toThrow();
    await expect(fs.stat(path.join(directory, 'stopped'))).resolves.toBeDefined();
  },
);
