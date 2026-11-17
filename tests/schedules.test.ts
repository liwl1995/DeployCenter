// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import { createHash } from 'node:crypto';
import { seed } from '../src/model';
import { createTask } from '../src/engine';
import { scheduleWindow, type ReleaseSchedule } from '../src/schedules';
import {
  ReleaseScheduler,
  scheduleConfiguration,
  schedulePins,
  validScheduleTime,
} from '../electron/scheduler';
import { Storage } from '../electron/storage';
import { Controller } from '../electron/controller';
import { Deployment } from '../electron/deployment';
import { snapshotJar } from '../electron/files';
import type { ControlMessage, WorkerInput, WorkerMessage } from '../electron/contracts';
import { fakeCapabilities } from './helpers/fakes';

const created: { store: Storage; dir: string }[] = [];
async function fixture() {
  await fs.mkdir(path.resolve('.test-data'), { recursive: true });
  const dir = await fs.mkdtemp(path.resolve('.test-data/schedules-'));
  const store = new Storage(dir, {
    encrypt: async (s) => Buffer.from(s),
    decrypt: async (b) => b.toString(),
  });
  created.push({ store, dir });
  const db = seed();
  db.history = [];
  db.taskHistory = {};
  db.services[0].root = dir;
  db.services[0].jarDir = '.';
  db.services[0].jarName = 'fixture.jar';
  db.targets[0].production = false;
  db.targets[0].mode = 'jar';
  db.servers.find((s) => s.id === db.targets[0].serverId)!.auth = 'alias';
  store.saveConfig(db);
  const task = createTask(db, db.services[0], [db.targets[0]], {}, 'existing');
  task.preparation = true;
  const plan: ReleaseSchedule = {
    id: 'SP-fixture',
    createdAt: 1,
    scheduledAt: 1000000,
    state: 'ready',
    reason: '',
    preparationId: task.id,
    task,
    approval: { productionWord: '', allowWeak: false, protectCurrent: true },
    configuration: scheduleConfiguration(db, task),
    pins: schedulePins(task, {}),
  };
  return { store, dir, task, plan };
}
afterEach(async () => {
  for (const { store, dir } of created.splice(0)) {
    await store.settle();
    store.close();
    if (!path.resolve(dir).startsWith(path.resolve('.test-data') + path.sep))
      throw new Error('测试目录越界');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
function scheduler(store: Storage, now = 1000000) {
  const clock = { now, elapsed: now };
  const busy = { value: false };
  const start = vi.fn(async (plan: ReleaseSchedule) => {
    plan.state = 'executing';
    store.saveSchedule(plan);
  });
  const cancel = vi.fn();
  const controller = {
    active: () => false,
    startScheduled: start,
    cancel,
  } as unknown as Controller;
  const changed = vi.fn();
  return {
    clock,
    busy,
    start,
    cancel,
    changed,
    scheduler: new ReleaseScheduler(
      store,
      controller,
      () => busy.value,
      changed,
      () => clock.now,
      () => clock.elapsed,
    ),
  };
}
describe('定时调度与持久化', () => {
  it('时间校验拒绝过去、非整数与超过一年，按时间及创建顺序逐个认领', async () => {
    expect(() => validScheduleTime(100, 100)).toThrow();
    expect(() => validScheduleTime(1.5, 0)).toThrow();
    expect(() => validScheduleTime(367 * 86400000, 0)).toThrow();
    const { store, plan } = await fixture();
    store.saveSchedule({ ...plan, id: 'second', createdAt: 2 });
    store.saveSchedule(plan);
    const run = scheduler(store);
    await run.scheduler.tick();
    expect(run.start.mock.calls.map(([p]) => p.id)).toEqual([plan.id]);
    await run.scheduler.tick();
    expect(run.start.mock.calls.map(([p]) => p.id)).toEqual([plan.id, 'second']);
  });
  it('执行槽占用时等待，15 分钟内释放后只启动一次', async () => {
    const { store, plan } = await fixture();
    store.saveSchedule(plan);
    const run = scheduler(store);
    run.busy.value = true;
    await run.scheduler.tick();
    expect(store.schedules()[0].state).toBe('waiting');
    expect(run.start).not.toHaveBeenCalled();
    run.clock.now += 60000;
    run.clock.elapsed += 60000;
    run.busy.value = false;
    await Promise.all([run.scheduler.tick(), run.scheduler.tick()]);
    await run.scheduler.tick();
    expect(run.start).toHaveBeenCalledTimes(1);
  });
  it('超出窗口不执行，准备超时请求取消', async () => {
    const { store, plan } = await fixture();
    store.saveSchedule({ ...plan, state: 'preparing' });
    const run = scheduler(store, plan.scheduledAt + scheduleWindow + 1);
    await run.scheduler.tick();
    expect(store.schedules()[0].state).toBe('missed');
    expect(run.cancel).toHaveBeenCalledWith(plan.preparationId);
    expect(run.start).not.toHaveBeenCalled();
  });
  it('未到时间不启动；取消的计划不会被触发', async () => {
    const { store, plan } = await fixture();
    store.saveSchedule(plan);
    const run = scheduler(store, plan.scheduledAt - 1);
    await run.scheduler.tick();
    expect(run.start).not.toHaveBeenCalled();
    plan.state = 'cancelled';
    store.saveSchedule(plan);
    run.clock.now += 2;
    run.clock.elapsed += 2;
    await run.scheduler.tick();
    expect(run.start).not.toHaveBeenCalled();
  });
  it('恢复时到期计划标记错过，未来准备中计划要求重新确认', async () => {
    const { store, plan } = await fixture();
    store.saveSchedule(plan);
    store.saveSchedule({
      ...plan,
      id: 'future',
      state: 'preparing',
      scheduledAt: plan.scheduledAt + 60000,
    });
    const run = scheduler(store);
    run.scheduler.restore();
    expect(store.schedules().find((p) => p.id === plan.id)?.state).toBe('missed');
    expect(store.schedules().find((p) => p.id === 'future')?.state).toBe('confirmation');
    expect(run.start).not.toHaveBeenCalled();
  });
  it('启动交接曾中断时不创建第二个任务', async () => {
    const { store, plan, task } = await fixture();
    task.status = 'interrupted';
    store.claimSchedule({ ...plan, state: 'executing', taskId: task.id }, task);
    const run = scheduler(store);
    run.scheduler.restore();
    await run.scheduler.tick();
    expect(store.schedules()[0].state).toBe('failed');
    expect(run.start).not.toHaveBeenCalled();
    expect(store.schedules()[0].taskId).toBe(task.id);
  });
  it('休眠跨过发布时间不补发，未来计划继续等待', async () => {
    const { store, plan } = await fixture();
    store.saveSchedule(plan);
    const run = scheduler(store, plan.scheduledAt - 1000);
    run.scheduler.suspend();
    run.clock.now += 2000;
    run.clock.elapsed += 2000;
    await run.scheduler.tick();
    expect(run.start).not.toHaveBeenCalled();
    run.scheduler.resume();
    expect(store.schedules()[0].state).toBe('missed');
  });
  it('系统时间跳变暂停计划，不因改时钟突然发布', async () => {
    const { store, plan } = await fixture();
    store.saveSchedule(plan);
    const run = scheduler(store, plan.scheduledAt - 1000);
    await run.scheduler.tick();
    run.clock.now += 120000;
    run.clock.elapsed += 1000;
    await run.scheduler.tick();
    expect(store.schedules()[0].state).toBe('confirmation');
    expect(run.start).not.toHaveBeenCalled();
  });
  it('命令变化暂停计划；仅线上记录与 Git 状态变化不误判', async () => {
    const { store, plan, task } = await fixture();
    const db = store.database();
    db.targets[0].currentHash = 'd'.repeat(64);
    db.targets[0].version = 'other';
    db.services[0].git.dirty = true;
    expect(scheduleConfiguration(db, task)).toBe(plan.configuration);
    db.targets[0].start += ' --new-option';
    store.saveConfig(db);
    store.saveSchedule(plan);
    const run = scheduler(store);
    await run.scheduler.tick();
    expect(store.schedules()[0].state).toBe('confirmation');
  });
  it('相关主机信任变化暂停，锁重试间隔未到不连接', async () => {
    const { store, plan } = await fixture();
    plan.task.targets[0].server.auth = 'password';
    const db = store.database();
    db.servers.find((s) => s.id === plan.task.targets[0].server.id)!.auth = 'password';
    store.saveConfig(db);
    plan.configuration = scheduleConfiguration(db, plan.task);
    plan.pins = 'changed';
    store.saveSchedule(plan);
    const run = scheduler(store);
    await run.scheduler.tick();
    expect(store.schedules()[0].state).toBe('confirmation');
    plan.state = 'waiting';
    plan.nextAttemptAt = plan.scheduledAt + 10000;
    store.saveSchedule(plan);
    await run.scheduler.tick();
    expect(run.start).not.toHaveBeenCalled();
  });
  it('准备任务不更新线上版本、不进入部署历史，计划不在配置导出数据中', async () => {
    const { store, task, plan } = await fixture();
    store.saveSchedule(plan);
    const before = store.database();
    task.status = 'success';
    task.targets[0].status = 'success';
    store.complete(task);
    expect(store.database().history).toEqual([]);
    expect(store.database().targets).toEqual(before.targets);
    expect(store.summaries()).toEqual([]);
    expect(JSON.stringify(store.database())).not.toContain('SP-fixture');
  });
  it('所有清理策略保护待发布快照，取消后释放且不阻止无关清理', async () => {
    const { store, dir, task, plan } = await fixture();
    const file = path.join(dir, 'fixture.jar');
    const zip = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
    await zip.add('META-INF/MANIFEST.MF', new TextReader('Manifest-Version: 1.0\r\n'));
    await fs.writeFile(file, Buffer.from(await (await zip.close()).arrayBuffer()));
    task.artifact = await snapshotJar(file, task.id, dir);
    task.status = 'success';
    task.targets[0].status = 'success';
    plan.task = task;
    store.claimSchedule(plan, task);
    for (const kind of ['policy', 'artifacts', 'legacy-success'] as const) {
      const preview = store.artifacts.preview(kind);
      expect(preview.bytes).toBe(0);
    }
    const preview = store.artifacts.preview('artifacts');
    await expect(store.artifacts.apply(preview.token, true)).resolves.toMatchObject({ bytes: 0 });
    plan.state = 'cancelled';
    store.saveSchedule(plan);
    task.status = 'interrupted';
    task.endedAt = Date.now();
    store.saveTask(task);
    expect(store.artifacts.preview('artifacts').bytes).toBeGreaterThan(0);
  });
});

function deployment(kind: WorkerInput['kind'], baseline = 'b'.repeat(64)) {
  const db = seed();
  const target = { ...db.targets[0], mode: 'jar' as const };
  const task = createTask(
    db,
    db.services[0],
    [target],
    {},
    kind === 'schedule-prepare' ? 'rebuild' : 'existing',
  );
  task.targets[0].server.auth = 'password';
  task.preparation = true;
  task.scheduleId = 'SP-test';
  task.artifact.sha256 = 'a'.repeat(64);
  task.scheduleBaselines = { [target.id]: 'b'.repeat(64) };
  const input: WorkerInput = {
    kind,
    task,
    dataDir: 'fixture',
    jdks: db.jdks,
    allowMavenNonzero: true,
    credentials: {},
    pins: {},
    allowWeak: false,
  };
  const fake = fakeCapabilities(input);
  const original = fake.deps.remote;
  fake.deps.remote = (...args) => {
    const session = original(...args);
    const exec = session.exec;
    session.exec = async (command, options) => {
      if (options?.input?.includes('DC_BASELINE=')) {
        fake.commands.push(options.input);
        return baseline === 'locked'
          ? { code: 1, stdout: '', stderr: 'SCHEDULE_LOCKED: 已有任务锁' }
          : { code: 0, stdout: 'DC_BASELINE=' + baseline + '\n', stderr: '' };
      }
      return exec(command, options);
    };
    return session;
  };
  const messages: WorkerMessage[] = [];
  const engine = new Deployment(
    input,
    (message) => messages.push(message),
    async () => false,
    fake.deps,
    async () => {},
    async () => {},
  );
  return { input, fake, engine, messages };
}
describe('准备与定时执行边界', () => {
  it('准备只构建一次、生成快照和读取基线，不上传、不运行远端写入脚本', async () => {
    const { engine, fake } = deployment('schedule-prepare');
    await engine.run();
    expect(fake.builds).toBe(1);
    expect(fake.uploads).toEqual([]);
    expect(fake.commands.every((command) => command.includes('DC_BASELINE='))).toBe(true);
    expect(engine.task.status).toBe('success');
    expect(engine.task.preparation).toBe(true);
    expect(engine.task.scheduleBaselines).toEqual({
      [engine.task.targets[0].target.id]: 'b'.repeat(64),
    });
  });
  it('到点使用原快照，完全跳过构建与 Git 查询，成功后进入现有部署流程', async () => {
    const { engine, fake } = deployment('schedule-deploy');
    fake.deps.commands.gitInfo = async () => {
      throw new Error('不应读取 Git');
    };
    await engine.run();
    expect(fake.builds).toBe(0);
    expect(fake.uploads).toHaveLength(1);
    expect(engine.task.preparation).toBe(false);
    expect(engine.task.status).toBe('success');
  });
  it('线上版本变化或锁占用时，没有任何上传和替换', async () => {
    for (const baseline of ['c'.repeat(64), 'locked']) {
      const { engine, fake } = deployment('schedule-deploy', baseline);
      await engine.run();
      expect(fake.uploads).toEqual([]);
      expect(engine.task.preparation).toBe(true);
      expect(engine.task.scheduleCheck).toBe(baseline === 'locked' ? 'locked' : 'changed');
    }
  });
  it('全部目标预检完成前不会上传第一个目标', async () => {
    const run = deployment('schedule-deploy');
    const second = structuredClone(run.input.task.targets[0]);
    second.target.id = 'second';
    run.input.task.targets.push(second);
    run.input.task.scheduleBaselines!.second = 'c'.repeat(64);
    const engine = new Deployment(
      run.input,
      () => {},
      async () => false,
      run.fake.deps,
    );
    await engine.run();
    expect(run.fake.uploads).toEqual([]);
    expect(engine.task.scheduleCheck).toBe('changed');
  });
  it('快照篡改或已过最晚启动时间时不上传', async () => {
    const run = deployment('schedule-deploy');
    run.input.task.artifact.sha256 = 'c'.repeat(64);
    const engine = new Deployment(
      run.input,
      () => {},
      async () => false,
      run.fake.deps,
    );
    await engine.run();
    expect(run.fake.uploads).toEqual([]);
    expect(engine.task.status).toBe('failed');
    const expired = deployment('schedule-deploy');
    expired.input.scheduleDeadline = 1;
    const late = new Deployment(
      expired.input,
      () => {},
      async () => false,
      expired.fake.deps,
    );
    await late.run();
    expect(expired.fake.uploads).toEqual([]);
    expect(late.task.scheduleCheck).toBe('expired');
  });
  it('取得锁后发现版本变化时停止，不上传后续目标', async () => {
    const { engine, fake } = deployment('schedule-deploy');
    const original = fake.deps.remote;
    fake.deps.remote = (...args) => {
      const session = original(...args),
        exec = session.exec;
      session.exec = async (command, options) => {
        const result = await exec(command, options);
        if (command.includes('/preflight'))
          result.stdout = result.stdout.replace('b'.repeat(64), 'c'.repeat(64));
        return result;
      };
      return session;
    };
    await engine.run();
    expect(fake.uploads).toEqual([]);
    expect(engine.task.scheduleCheck).toBe('changed');
  });
});

describe('主进程定时入口', () => {
  it('复用生产确认与有效 token，准备保存后才启动 worker，口令不进入计划', async () => {
    const { store, dir } = await fixture();
    const db = store.database();
    db.targets[0].production = true;
    store.saveConfig(db);
    const zip = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
    await zip.add('META-INF/MANIFEST.MF', new TextReader('Manifest-Version: 1.0\r\n'));
    await fs.writeFile(
      path.join(dir, 'fixture.jar'),
      Buffer.from(await (await zip.close()).arrayBuffer()),
    );
    const sent: ControlMessage[] = [];
    let report!: (message: WorkerMessage) => void;
    const controller = new Controller(
      store,
      (onMessage) => {
        report = onMessage;
        return { send: (message) => sent.push(message), close() {} };
      },
      () => {},
    );
    const prepared = await controller.prepare({
      serviceId: db.services[0].id,
      targetIds: [db.targets[0].id],
      build: 'existing',
      overrides: {},
      failurePolicy: 'stop',
    });
    const approval = {
      productionWord: '',
      productionNames: {},
      allowWeak: false,
      protectCurrent: true,
    };
    await expect(
      controller.start(prepared.token, {}, approval, { at: Date.now() + 60000 }),
    ).rejects.toThrow('环境名称');
    approval.productionNames = { [db.targets[0].id]: db.targets[0].name };
    const task = await controller.start(prepared.token, {}, approval, { at: Date.now() + 60000 });
    expect(store.schedules()).toHaveLength(1);
    expect(store.schedules()[0].state).toBe('preparing');
    expect(sent[0].kind === 'begin' && sent[0].value.kind).toBe('schedule-prepare');
    const completed = structuredClone(task);
    completed.status = 'success';
    completed.scheduleBaselines = { [db.targets[0].id]: 'absent' };
    report({ kind: 'done', task: completed });
    expect(store.schedules()[0].state).toBe('ready');
    expect(store.database().history).toEqual([]);
    expect(JSON.stringify(store.schedules())).not.toContain('credentials');
  });
  it('每次询问口令的服务器不能创建无人值守计划', async () => {
    const { store } = await fixture();
    const db = store.database();
    const server = db.servers.find((s) => s.id === db.targets[0].serverId)!;
    server.auth = 'password';
    server.credentialMode = 'ask';
    store.saveConfig(db);
    const controller = new Controller(
      store,
      () => {
        throw new Error('不应启动');
      },
      () => {},
      {
        resolveBuild: async () => ({
          tool: 'mvn',
          args: [],
          cwd: '.',
          env: { JAVA_HOME: '.', PATH: '' },
          jdkPath: '.',
          java: 'java',
          run: async () => ({ code: 0, stdout: '', stderr: '', successMarker: true }),
        }),
      },
    );
    const prepared = await controller.prepare({
      serviceId: db.services[0].id,
      targetIds: [db.targets[0].id],
      build: 'rebuild',
      overrides: {},
      failurePolicy: 'stop',
    });
    await expect(
      controller.start(
        prepared.token,
        { [server.id]: 'secret' },
        { productionWord: '', allowWeak: false, protectCurrent: true },
        { at: Date.now() + 60000 },
      ),
    ).rejects.toThrow('Windows');
    expect(store.schedules()).toHaveLength(0);
  });
});

it('认领期间取消计划后，凭据读取失败不能把已取消状态覆盖为失败', async () => {
  const { store, plan } = await fixture();
  store.saveSchedule(plan);
  const controller = {
    active: () => false,
    cancel: vi.fn(),
    startScheduled: async () => {
      store.saveSchedule({ ...plan, state: 'cancelled' });
      throw new Error('credential failed');
    },
  } as unknown as Controller;
  const scheduler = new ReleaseScheduler(
    store,
    controller,
    () => false,
    () => {},
    () => plan.scheduledAt,
  );
  await scheduler.tick();
  expect(store.schedules()[0].state).toBe('cancelled');
});
it('远端锁重试复用唯一任务，非交互发布拒绝主机信任弹窗', async () => {
  const { store, plan } = await fixture();
  plan.scheduledAt = Date.now() - 1;
  store.saveSchedule(plan);
  const sent: ControlMessage[] = [];
  let report!: (message: WorkerMessage) => void;
  const controller = new Controller(
    store,
    (onMessage) => {
      report = onMessage;
      return { send: (m) => sent.push(m), close() {} };
    },
    () => {},
  );
  await controller.startScheduled(plan);
  const begin = sent[0];
  if (begin.kind !== 'begin') throw new Error('缺少开始消息');
  report({
    kind: 'trust',
    key: 'new-key',
    request: {
      id: 'request',
      server: 'fixture',
      endpoint: '127.0.0.1:12345',
      fingerprint: 'SHA256:new',
      changed: false,
    },
  });
  expect(sent.at(-1)).toEqual({ kind: 'trust-result', id: 'request', accepted: false });
  expect(controller.trust.current()).toBeUndefined();
  report({
    kind: 'done',
    task: { ...begin.value.task, status: 'failed', preparation: true, scheduleCheck: 'locked' },
  });
  expect(store.schedules()[0].state).toBe('waiting');
  const taskId = store.schedules()[0].taskId;
  await controller.startScheduled(store.schedules()[0]);
  const last = sent.at(-1)!;
  if (last.kind !== 'begin') throw new Error('缺少重试消息');
  expect(last.value.task.id).toBe(taskId);
  const dispatch = { ...last.value.task, preparation: false };
  report({ kind: 'schedule-dispatch', task: dispatch });
  expect(store.task(taskId!)?.preparation).toBe(false);
  expect(sent.at(-1)).toEqual({ kind: 'schedule-dispatch-result', error: undefined });
  const completed = structuredClone(last.value.task);
  completed.preparation = false;
  completed.status = 'success';
  completed.targets[0].status = 'unverified';
  report({ kind: 'done', task: completed });
  expect(store.schedules()[0].state).toBe('completed');
  expect(store.database().history).toHaveLength(1);
});
it('到点缺少已保存密码时，不启动 worker，也不等待用户输入', async () => {
  const { store, plan } = await fixture();
  const db = store.database();
  db.servers.find((s) => s.id === plan.task.targets[0].server.id)!.auth = 'password';
  store.saveConfig(db);
  Object.assign(plan.task.targets[0].server, { auth: 'password', credentialMode: 'windows' });
  plan.configuration = scheduleConfiguration(db, plan.task);
  plan.pins = schedulePins(plan.task, {});
  plan.scheduledAt = Date.now() - 1;
  store.saveSchedule(plan);
  const factory = vi.fn();
  const controller = new Controller(store, factory, () => {});
  const scheduler = new ReleaseScheduler(
    store,
    controller,
    () => false,
    () => {},
  );
  await scheduler.tick();
  expect(store.schedules()[0].state).toBe('failed');
  expect(factory).not.toHaveBeenCalled();
});
it('SSH 别名的有效配置变化时暂停发布，即使数据库配置未变化', async () => {
  const run = deployment('schedule-deploy');
  run.input.task.targets[0].server.auth = 'alias';
  run.input.task.scheduleAliases = { [run.input.task.targets[0].server.id]: 'old-config-hash' };
  run.fake.deps.commands.run = async () => ({
    code: 0,
    stdout: 'hostname changed-host\nuser deploy\nport 22\n',
    stderr: '',
    successMarker: false,
  });
  const engine = new Deployment(
    run.input,
    () => {},
    async () => false,
    run.fake.deps,
  );
  await engine.run();
  expect(engine.task.scheduleCheck).toBe('changed');
  expect(run.fake.uploads).toEqual([]);
});

it('迁移暂停数据库期间不调度，列表可读，休眠错过时间在恢复后处理', async () => {
  const { store, plan } = await fixture();
  store.saveSchedule(plan);
  const run = scheduler(store, plan.scheduledAt - 1);
  store.pause();
  expect(store.schedules()[0].id).toBe(plan.id);
  await run.scheduler.tick();
  expect(run.start).not.toHaveBeenCalled();
  run.scheduler.suspend();
  run.clock.now += 2;
  run.clock.elapsed += 2;
  run.scheduler.resume();
  store.resume();
  await run.scheduler.tick();
  expect(store.schedules()[0].state).toBe('missed');
  expect(run.start).not.toHaveBeenCalled();
});

it('SSH 别名按有效配置和实际主机指纹固定，信任文件换成新主机后也要求确认', async () => {
  const run = deployment('schedule-prepare');
  run.input.task.targets[0].server.auth = 'alias';
  const config = 'hostname 127.0.0.1\nuser fixture\nport 2222\n';
  let fingerprint = 'SHA256:first';
  run.fake.deps.commands.run = async (_file, args) => ({
    code: 0,
    stdout: args.includes('-G') ? config : 'DEPLOY_CENTER_SCHEDULE_IDENTITY',
    stderr: args.includes('-G') ? '' : 'debug1: Server host key: ssh-ed25519 ' + fingerprint + '\n',
    successMarker: false,
  });
  const prepare = new Deployment(
    run.input,
    () => {},
    async () => false,
    run.fake.deps,
  );
  await prepare.run();
  expect(prepare.task.status).toBe('success');
  expect(prepare.task.scheduleAliases?.[run.input.task.targets[0].server.id]).toBe(
    createHash('sha256').update(config).digest('hex'),
  );
  fingerprint = 'SHA256:second';
  const execute = new Deployment(
    { ...run.input, kind: 'schedule-deploy', task: prepare.task },
    () => {},
    async () => false,
    run.fake.deps,
  );
  await execute.run();
  expect(execute.task.scheduleCheck).toBe('changed');
  expect(run.fake.uploads).toEqual([]);
});

it('未收到持久化启动许可之前不能上传，许可失败只结束准备阶段', async () => {
  const run = deployment('schedule-deploy');
  let release!: () => void;
  let requested = false;
  const permit = new Promise<void>((resolve) => {
    release = resolve;
  });
  const engine = new Deployment(
    run.input,
    () => {},
    async () => false,
    run.fake.deps,
    async () => {},
    async () => {
      requested = true;
      await permit;
    },
  );
  const finished = engine.run();
  await vi.waitFor(() => expect(requested).toBe(true));
  expect(run.fake.uploads).toEqual([]);
  release();
  await finished;
  expect(run.fake.uploads).toHaveLength(1);
  const rejected = deployment('schedule-deploy');
  const refused = new Deployment(
    rejected.input,
    () => {},
    async () => false,
    rejected.fake.deps,
    async () => {},
    async () => {
      throw new Error('无法持久化');
    },
  );
  await refused.run();
  expect(rejected.fake.uploads).toEqual([]);
  expect(refused.task.preparation).toBe(true);
  expect(refused.task.status).toBe('failed');
});

it('到点远端实际指纹变化时要求重新确认，不请求人工信任或上传', async () => {
  const run = deployment('schedule-deploy');
  const original = run.fake.deps.remote;
  run.fake.deps.remote = (server, options) => {
    const session = original(server, options);
    session.connect = async () => {
      const accepted = await options.trust(
        {
          id: 'new-host',
          endpoint: '127.0.0.1:2222',
          server: 'fixture',
          fingerprint: 'SHA256:new',
          changed: true,
        },
        'new-key',
      );
      if (!accepted) throw new Error('Host key verification failed');
    };
    return session;
  };
  const prompt = vi.fn(async () => true);
  const engine = new Deployment(run.input, () => {}, prompt, run.fake.deps);
  await engine.run();
  expect(engine.task.scheduleCheck).toBe('changed');
  expect(prompt).not.toHaveBeenCalled();
  expect(run.fake.uploads).toEqual([]);
});
