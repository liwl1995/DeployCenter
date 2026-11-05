// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import Sqlite from 'better-sqlite3';
import iconv from 'iconv-lite';
import { BlobWriter, ZipWriter, TextReader } from '@zip.js/zip.js';
import { seed } from '../src/model';
import { createTask } from '../src/engine';
import { Deployment } from '../electron/deployment';
import { Storage } from '../electron/storage';
import { inspectJar, resolveBuild } from '../electron/files';
import { runBatch, runProcess, splitArguments } from '../electron/process';
import { validateDatabase } from '../electron/validate';
import { dryRunScript, remotePaths, runnerScript } from '../electron/remote';
import { fakeCapabilities } from './helpers/fakes';
import type { WorkerInput, WorkerMessage } from '../electron/contracts';
const base = path.resolve('.test-data');
const temporary: string[] = [];
async function temp() {
  await fs.mkdir(base, { recursive: true });
  const value = await fs.mkdtemp(path.join(base, 'native-'));
  temporary.push(value);
  return value;
}
afterEach(async () => {
  for (const dir of temporary.splice(0)) {
    if (!path.resolve(dir).startsWith(base + path.sep)) throw new Error('测试目录越界');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
async function jar(file: string, manifest = true) {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  if (manifest)
    await writer.add('META-INF/MANIFEST.MF', new TextReader('Manifest-Version: 1.0\r\n'), {
      level: 0,
    });
  await writer.add('data.txt', new TextReader('hello deployment'), { level: 0 });
  await fs.writeFile(file, Buffer.from(await (await writer.close()).arrayBuffer()));
}
function input(count = 1): WorkerInput {
  const db = seed();
  const targets = db.targets.filter((t) => t.mode === 'jar');
  while (targets.length < count)
    targets.push({
      ...targets[0],
      id: 'extra' + targets.length,
      serverId: db.servers[targets.length % db.servers.length].id,
    });
  const task = createTask(db, db.services[0], targets.slice(0, count), {}, 'existing');
  return {
    kind: 'deploy',
    task,
    dataDir: 'fixture-data',
    jdks: [],
    allowMavenNonzero: true,
    credentials: { s72: 'password-not-for-storage' },
    pins: {},
    allowWeak: false,
  };
}
describe('真实引擎的假能力测试（不访问文件、进程或网络）', () => {
  it('顺序执行多个目标，只构建一次；增量日志脱敏', async () => {
    const value = input(3);
    value.task.build = 'rebuild';
    const fake = fakeCapabilities(value),
      events: WorkerMessage[] = [];
    const engine = new Deployment(
      value,
      (e) => events.push(e),
      async () => false,
      fake.deps,
    );
    await engine.run();
    expect(fake.builds).toBe(1);
    expect(fake.uploads).toHaveLength(3);
    expect(engine.task.targets.every((r) => r.status === 'unverified')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('password-not-for-storage');
    expect(engine.task.elapsed).toBeGreaterThan(0);
    expect(fake.deps.credentials.get('s72')).toBeUndefined();
  });
  it.each(['stop', 'continue'] as const)('失败策略 %s 作用于后续目标', async (policy) => {
    const value = input(2);
    value.task.failurePolicy = policy;
    const fake = fakeCapabilities(value, { failed: value.task.targets[0].target.id });
    const engine = new Deployment(
      value,
      () => {},
      async () => false,
      fake.deps,
    );
    await engine.run();
    expect(engine.task.targets[0].status).toBe('failed');
    expect(engine.task.targets[1].status).toBe(policy === 'stop' ? 'skipped' : 'unverified');
  });
  it.each([true, false])(
    '旧 JAR 哈希匹配=%s 时才沿用已记录提交，否则用真实哈希标识',
    async (known) => {
      const value = input();
      value.task.targets[0].target.version = 'commit-v1';
      value.task.targets[0].target.currentHash = known ? 'b'.repeat(64) : 'c'.repeat(64);
      const fake = fakeCapabilities(value);
      const engine = new Deployment(
        value,
        () => {},
        async () => false,
        fake.deps,
      );
      await engine.run();
      expect(engine.task.targets[0].backupVersion).toBe(known ? 'commit-v1' : 'b'.repeat(12));
    },
  );
  it('备份由远程结构化事件创建，存入真实大小和哈希', async () => {
    const value = input();
    const fake = fakeCapabilities(value);
    const engine = new Deployment(
      value,
      () => {},
      async () => false,
      fake.deps,
    );
    await engine.run();
    expect(engine.task.targets[0]).toMatchObject({
      backupCreated: true,
      backupSize: 99,
      backupHash: 'b'.repeat(64),
    });
  });
  it('切换后断线标记远端未知，不继续后续目标', async () => {
    const value = input(2),
      fake = fakeCapabilities(value, { disconnect: true });
    const engine = new Deployment(
      value,
      () => {},
      async () => false,
      fake.deps,
    );
    await engine.run();
    expect(engine.task.status).toBe('interrupted');
    expect(engine.task.targets.map((r) => r.status)).toEqual(['unknown', 'skipped']);
  });
  it('试运行不上传、不构建、不创建远程锁', async () => {
    const value = input();
    value.task.dryRun = true;
    value.task.buildSteps = [{ key: 'local', label: '本地检查' }];
    for (const r of value.task.targets)
      r.steps = [
        { key: 'connect', label: '连接' },
        { key: 'preflight', label: '预检' },
      ];
    const fake = fakeCapabilities(value);
    const engine = new Deployment(
      value,
      () => {},
      async () => false,
      fake.deps,
    );
    await engine.run();
    expect(fake.uploads).toHaveLength(0);
    expect(fake.builds).toBe(0);
    expect(fake.commands.join('\n')).not.toMatch(/mkdir|chmod|cp -p|mv -f|cat >/);
    expect(engine.task.status).toBe('success');
  });
  it('取消上传在停服前清理，不启动远端 runner', async () => {
    const value = input();
    let engine: Deployment;
    const fake = fakeCapabilities(value, { onUpload: () => void engine.cancel() });
    engine = new Deployment(
      value,
      () => {},
      async () => false,
      fake.deps,
    );
    await engine.run();
    expect(engine.task.status).toBe('cancelled');
    expect(fake.commands.join('\n')).not.toContain('nohup bash');
  });
});
describe('原生存储、文件和本地进程', () => {
  const crypto = {
    encrypt: async (v: string) => Buffer.from(v.split('').reverse().join('')),
    decrypt: async (v: Buffer) => v.toString().split('').reverse().join(''),
  };
  it('SQLite 使用空配置；口令只保存密文，不进入导出或日志摘要', async () => {
    const dir = await temp(),
      store = new Storage(dir, crypto);
    expect(store.database().services).toHaveLength(0);
    await store.saveCredential('server', 'plain-password');
    const raw = new Sqlite(path.join(dir, 'deploy-center.sqlite'));
    expect(
      String(
        (raw.prepare('SELECT encrypted FROM secrets').get() as { encrypted: Buffer }).encrypted,
      ),
    ).not.toContain('plain-password');
    raw.close();
    expect(await store.credential('server')).toBe('plain-password');
    const value = input();
    value.task.buildLogs = ['unique-log'];
    store.appendLog(value.task.id, 'unique-log\n');
    store.saveTask(value.task);
    expect(store.task(value.task.id)?.buildLogs).toEqual([]);
    store.close();
  });
  it('旧版本迁移先备份；重启中断任务不自动运行', async () => {
    const dir = await temp(),
      file = path.join(dir, 'deploy-center.sqlite');
    const old = new Sqlite(file);
    old.pragma('user_version=1');
    old.close();
    const store = new Storage(dir, crypto);
    expect((await fs.readdir(path.join(dir, 'backups'))).length).toBeGreaterThan(0);
    const value = input();
    value.task.targets[0].status = 'running';
    store.saveTask(value.task);
    store.markInterrupted();
    expect(store.task(value.task.id)?.status).toBe('interrupted');
    expect(store.task(value.task.id)?.targets[0].status).toBe('unknown');
    store.close();
  });
  it('损坏配置保留原文，确认之前不覆盖数据库', async () => {
    const dir = await temp();
    let store = new Storage(dir, crypto);
    store.close();
    const sql = new Sqlite(path.join(dir, 'deploy-center.sqlite'));
    sql.prepare('UPDATE config SET json=?').run('{broken');
    sql.close();
    store = new Storage(dir, crypto);
    expect(store.recovery?.raw).toBe('{broken');
    expect(() => store.saveConfig(seed())).toThrow();
    store.close();
    const check = new Sqlite(path.join(dir, 'deploy-center.sqlite'));
    expect((check.prepare('SELECT json FROM config').get() as { json: string }).json).toBe(
      '{broken',
    );
    check.close();
  });
  it('JAR 全部 CRC、Manifest 和 SHA256 检查；篡改内容被拒绝', async () => {
    const dir = await temp(),
      file = path.join(dir, 'test.jar');
    await jar(file);
    expect((await inspectJar(file)).sha256).toMatch(/^[a-f0-9]{64}$/);
    const data = await fs.readFile(file);
    data[data.indexOf('hello deployment')] = 72;
    await fs.writeFile(file, data);
    await expect(inspectJar(file)).rejects.toThrow(/完整性/);
    await jar(file, false);
    await expect(inspectJar(file)).rejects.toThrow(/Manifest|MANIFEST/);
  });
  it('JDK 缺失阻止重新构建；路径和配置做后端校验', async () => {
    const db = seed();
    await expect(resolveBuild(db.services[0], [], await temp())).rejects.toThrow('JDK');
    db.targets[0].directory = '/';
    expect(() => validateDatabase(db)).toThrow();
  });
  it.skipIf(process.platform !== 'win32')(
    '中文及空格 .cmd 路径，参数中的百分号和 & 原样传递（仅 Windows）',
    async () => {
      const dir = path.join(await temp(), '中文 & space');
      await fs.mkdir(dir);
      const batch = path.join(dir, '构建.cmd');
      await fs.writeFile(
        path.join(dir, 'capture.cjs'),
        'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),jdk:process.env.JAVA_HOME}));',
      );
      await fs.writeFile(
        batch,
        `@echo off\r\n"${process.execPath}" "%~dp0capture.cjs" %*\r\n`,
        'utf8',
      );
      const args = ['-Dpath=中文 空格', '-Dx=%PATH%', 'x&y'];
      const result = await runBatch(batch, args, dir, {
        cwd: dir,
        env: { ...process.env, JAVA_HOME: 'fixture-jdk' },
        encoding: 'utf8',
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        args,
        cwd: dir,
        jdk: 'fixture-jdk',
      });
    },
  );
  it('GBK 输出正确解码，成功标记跨数据块仍识别', async () => {
    const file = path.join(await temp(), 'output.cjs');
    await fs.writeFile(
      file,
      `process.stdout.write('[INFO] Maven banner\\n');setTimeout(()=>process.stdout.write(Buffer.from('${iconv.encode('构建成功\nBUILD SUCCESS', 'gb18030').toString('base64')}','base64')),30);`,
    );
    const result = await runProcess(process.execPath, [file], { encoding: 'auto' });
    expect(result.stdout).toContain('构建成功');
    expect(result.successMarker).toBe(true);
    expect(splitArguments('clean "-Dname=hello world"')).toEqual(['clean', '-Dname=hello world']);
    expect(() => splitArguments('"broken')).toThrow();
  });
  it('取消等待进程树退出后才完成', async () => {
    const abort = new AbortController();
    const running = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 100);
    await expect(running).rejects.toThrow('取消');
  });
  it('两种挂载的 runner 使用容器内 exec 哈希；所有路径统一转义', () => {
    const value = input();
    const r = value.task.targets[0];
    r.target.mode = 'docker';
    r.target.directory = "/tmp/中文 a'b";
    r.remote = remotePaths(value.task, r);
    const script = runnerScript(value.task, r, false);
    expect(script).toContain('docker exec');
    expect(script).toContain('容器内缺少 sha256sum');
    expect(script).toContain("'\\''");
    expect(dryRunScript(value.task, r)).not.toContain('mkdir');
  });
});
