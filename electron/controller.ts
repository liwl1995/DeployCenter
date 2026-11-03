import { randomBytes } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createTask, startTask, targetSteps } from '../src/engine';
import { canRollback } from '../src/records';
import { localJar, type Artifact, type Task } from '../src/model';
import type { Approval, DesktopEvent, TrustRequest } from '../src/platform';
import { inspectJar, resolveBuild, gitInfo } from './files';
import { Storage } from './storage';
import { parsePrepare, parseApproval, credentialsSchema, validateBackup } from './validate';
import type { ControlMessage, WorkerInput, WorkerMessage } from './contracts';

export type WorkerHandle = { send(value: ControlMessage): void; close(): void };
export type WorkerFactory = (
  onMessage: (message: WorkerMessage) => void,
  onExit: () => void,
) => WorkerHandle;
export class TrustBroker {
  private requests = new Map<
    string,
    { request: TrustRequest; key: string; resolve: (yes: boolean) => void; timer: NodeJS.Timeout }
  >();
  constructor(
    private storage: Storage,
    private emit: (event: DesktopEvent) => void,
  ) {}
  request(request: TrustRequest, key: string) {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.answer(request.id, false), 90000);
      this.requests.set(request.id, { request, key, resolve, timer });
      this.emit({ kind: 'trust', request });
    });
  }
  answer(id: string, accepted: boolean, confirmation = '') {
    const pending = this.requests.get(id);
    if (!pending) return;
    if (pending.request.changed && accepted)
      throw new Error('主机指纹不一致，禁止更新信任或忽略校验');
    void confirmation;
    clearTimeout(pending.timer);
    this.requests.delete(id);
    if (accepted)
      this.storage.trust(pending.request.endpoint, {
        key: pending.key,
        fingerprint: pending.request.fingerprint,
      });
    pending.resolve(accepted);
    this.emit({ kind: 'trust-closed', id });
  }
  current() {
    return [...this.requests.values()][0]?.request;
  }
  cancel() {
    for (const id of [...this.requests.keys()]) this.answer(id, false);
  }
}
export class Controller {
  private prepared = new Map<
    string,
    { task: Task; until: number; jdks: { name: string; path: string }[]; compatibility: boolean }
  >();
  private worker?: WorkerHandle;
  private current?: Task;
  private activeCredentials: Record<string, string> = {};
  readonly trust: TrustBroker;
  constructor(
    readonly storage: Storage,
    private factory: WorkerFactory,
    private emit: (event: DesktopEvent) => void,
  ) {
    this.trust = new TrustBroker(storage, emit);
  }
  active() {
    return !!this.worker;
  }
  async prepare(value: unknown) {
    if (this.storage.recovery) throw new Error('请先确认配置恢复，禁止覆盖原始数据');
    if (this.active()) throw new Error('请等待当前任务结束');
    const request = parsePrepare(value),
      db = this.storage.database();
    const history = request.historyId
      ? db.history.find((h) => h.id === request.historyId)
      : undefined;
    if (request.historyId && (!history || !canRollback(db, history)))
      throw new Error('历史记录没有有效备份，或目标配置已变化');
    const s = db.services.find((s) => s.id === request.serviceId);
    if (!s) throw new Error('服务不存在');
    const targets = request.targetIds.map((id) => {
      const target = db.targets.find((t) => t.id === id && t.serviceId === s.id);
      if (!target) throw new Error('部署目标不属于当前服务');
      return target;
    });
    if (history && (targets.length !== 1 || targets[0].id !== history.target.id))
      throw new Error('回滚必须使用历史记录对应的单个目标');
    for (const b of Object.values(request.overrides)) validateBackup(b);
    await mkdir(path.join(this.storage.dataDir, 'tmp'), { recursive: true });
    const service = structuredClone(s);
    service.git = history
      ? { ...history.service.git, commit: history.backupVersion || history.target.version }
      : await gitInfo(s.root);
    let artifact: Artifact;
    let resolved: Awaited<ReturnType<typeof resolveBuild>> | undefined;
    if (history) {
      if (!history.backupSize || (!history.backupHash && targets[0].hashPolicy !== 'size-confirm'))
        throw new Error('该历史备份缺少真实的大小或哈希记录，不能直接回滚');
      artifact = {
        name: path.posix.basename(history.backupPath!),
        path: history.backupPath!,
        size: history.backupSize,
        modified: new Date(0).toISOString(),
        exists: true,
        source: 'remote',
        sha256: history.backupHash,
      };
    } else if (request.build === 'existing')
      artifact = await inspectJar(request.jarPath || localJar(service));
    else {
      resolved = await resolveBuild(service, db.jdks, path.join(this.storage.dataDir, 'tmp'));
      const file = localJar(service);
      const info = await stat(file).catch(() => undefined);
      artifact = {
        name: service.jarName,
        path: file,
        size: info?.size || 0,
        modified: info?.mtime.toISOString() || new Date(0).toISOString(),
        exists: !!info,
        source: 'unknown',
      };
    }
    const task = createTask(
      db,
      service,
      targets,
      request.overrides,
      request.build,
      artifact,
      history,
    );
    task.failurePolicy = request.failurePolicy;
    task.dryRun = request.dryRun;
    if (resolved)
      task.buildContext = {
        ...task.buildContext,
        tool: resolved.tool,
        command:
          '"' +
          resolved.tool +
          '" ' +
          resolved.args.map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' '),
        workDir: resolved.cwd,
        jdkPath: resolved.jdkPath,
      };
    if (task.dryRun) {
      task.buildSteps = [
        {
          key: 'local',
          label: '检查本地目录、JDK 与构建工具（不执行构建）',
          status: 'pending',
          elapsed: 0,
        },
      ];
      for (const r of task.targets)
        r.steps = [
          { key: 'connect', label: '连接并验证服务器身份', status: 'pending', elapsed: 0 },
          {
            key: 'preflight',
            label: '只读检查目录、权限、空间和任务锁',
            status: 'pending',
            elapsed: 0,
          },
          ...(r.target.mode === 'docker'
            ? [
                {
                  key: 'mount',
                  label: '只读检查容器与挂载路径',
                  status: 'pending' as const,
                  elapsed: 0,
                },
              ]
            : []),
        ];
    } else
      for (const r of task.targets)
        r.steps.splice(
          r.steps.findIndex((s) => s.key === 'stop'),
          0,
          {
            key: 'permissions',
            label: '停机前设置并检查文件权限与属主',
            elapsed: 0,
            status: 'pending',
          },
        );
    const token = randomBytes(24).toString('hex');
    this.prepared.set(token, {
      task,
      until: Date.now() + 15 * 60000,
      jdks: structuredClone(db.jdks),
      compatibility: db.settings.allowMavenNonzero,
    });
    for (const [key, value] of this.prepared)
      if (value.until < Date.now()) this.prepared.delete(key);
    return { task, token };
  }
  private async credentials(task: Task, values: unknown) {
    const provided = credentialsSchema.parse(values);
    const result: Record<string, string> = {};
    for (const r of task.targets) {
      const s = r.server;
      if (s.auth === 'alias') continue;
      const value =
        provided[s.id] ||
        (s.credentialMode === 'windows' ? await this.storage.credential(s.id) : undefined) ||
        '';
      if (s.auth === 'password' && !value) throw new Error('请填写登录密码：' + s.name);
      result[s.id] = value;
      if (s.credentialMode === 'windows' && provided[s.id])
        await this.storage.saveCredential(s.id, value);
    }
    return result;
  }
  async start(token: string, values: unknown, rawApproval: unknown) {
    if (this.active()) throw new Error('已有任务正在执行');
    const pending = this.prepared.get(token);
    if (!pending || pending.until < Date.now()) throw new Error('确认已过期，请重新检查部署概要');
    const approval: Approval = parseApproval(rawApproval);
    const task = structuredClone(pending.task);
    if (
      !task.dryRun &&
      task.targets.some((r) => r.target.production) &&
      approval.productionWord !== 'DEPLOY'
    )
      throw new Error('正式环境必须输入 DEPLOY');
    if (
      !task.dryRun &&
      task.targets.some((r) => r.target.hashPolicy === 'size-confirm') &&
      !approval.allowWeak
    )
      throw new Error('请明确确认弱校验策略');
    if (task.operation === 'rollback')
      for (const r of task.targets) {
        r.backup.enabled = approval.protectCurrent;
        r.steps = targetSteps(r.target, r.backup, true);
        r.steps.splice(
          r.steps.findIndex((s) => s.key === 'stop'),
          0,
          {
            key: 'permissions',
            label: '停机前设置并检查文件权限与属主',
            elapsed: 0,
            status: 'pending',
          },
        );
      }
    task.protectCurrent = approval.protectCurrent;
    this.activeCredentials = await this.credentials(task, values);
    this.prepared.delete(token);
    const started = startTask(task);
    this.launch({
      kind: 'deploy',
      task: started,
      dataDir: this.storage.dataDir,
      jdks: pending.jdks,
      allowMavenNonzero: pending.compatibility,
      credentials: this.activeCredentials,
      pins: this.storage.pins(),
      allowWeak: approval.allowWeak,
    });
    return started;
  }
  async recover(taskId: string, values: unknown) {
    if (this.active()) throw new Error('请先结束当前任务');
    const task = this.storage.task(taskId);
    if (!task || task.status !== 'interrupted') throw new Error('没有对应的中断任务');
    const db = this.storage.database();
    for (const r of task.targets.filter((r) => r.remote && r.remote.phase !== 'complete')) {
      const current = db.servers.find((s) => s.id === r.server.id);
      if (
        !current ||
        current.host !== r.server.host ||
        current.port !== r.server.port ||
        current.alias !== r.server.alias ||
        current.user !== r.server.user
      )
        throw new Error('服务器身份已变化，请先恢复原连接配置再核实');
    }
    if (!task.targets.some((r) => r.remote && r.remote.phase !== 'complete')) {
      task.status = 'failed';
      task.endedAt = Date.now();
      for (const r of task.targets)
        if (!['success', 'unverified', 'rolledback', 'failed'].includes(r.status))
          r.status = 'skipped';
      this.storage.complete(task);
      this.emit({ kind: 'task', task });
      return task;
    }
    this.activeCredentials = await this.credentials(
      { ...task, targets: task.targets.filter((r) => r.remote && r.remote.phase !== 'complete') },
      values,
    );
    task.status = 'running';
    this.launch({
      kind: 'recover',
      task,
      dataDir: this.storage.dataDir,
      jdks: db.jdks,
      allowMavenNonzero: db.settings.allowMavenNonzero,
      credentials: this.activeCredentials,
      pins: this.storage.pins(),
      allowWeak: task.targets.some((r) => r.target.hashPolicy === 'size-confirm'),
    });
    return task;
  }
  private launch(input: WorkerInput) {
    this.current = input.task;
    this.storage.saveTask(input.task);
    this.emit({ kind: 'task', task: input.task });
    const finish = (task: Task) => {
      const worker = this.worker;
      this.worker = undefined;
      this.current = task;
      this.activeCredentials = {};
      this.trust.cancel();
      this.storage.complete(task);
      this.emit({ kind: 'task', task });
      this.emit({ kind: 'database', database: this.storage.database() });
      worker?.close();
    };
    this.worker = this.factory(
      (message) => {
        if (message.kind === 'snapshot') {
          this.current = message.task;
          this.storage.saveTask(message.task);
          this.emit({ kind: 'task', task: message.task });
        } else if (message.kind === 'log') {
          const offset = this.storage.appendLog(message.taskId, message.text, message.targetId);
          this.emit({ ...message, offset });
        } else if (message.kind === 'trust')
          void this.trust
            .request(message.request, message.key)
            .then((accepted) =>
              this.worker?.send({ kind: 'trust-result', id: message.request.id, accepted }),
            );
        else if (message.kind === 'done') finish(message.task);
        else if (message.kind === 'fatal') {
          const task = structuredClone(this.current!);
          task.status = 'interrupted';
          for (const r of task.targets)
            if (r.status === 'running' || r.status === 'rollingback') {
              r.status = 'unknown';
              r.error = message.error;
            }
          finish(task);
        }
      },
      () => {
        if (this.worker && this.current) {
          const task = structuredClone(this.current);
          task.status = 'interrupted';
          for (const r of task.targets)
            if (r.status === 'running' || r.status === 'rollingback') {
              r.status = 'unknown';
              r.error = '部署工作进程退出，不能确认远端结果';
            }
          finish(task);
        }
      },
    );
    this.worker.send({ kind: 'begin', value: input });
  }
  cancel(taskId: string) {
    if (!this.current || this.current.id !== taskId || !this.worker) return;
    this.trust.cancel();
    this.worker.send({ kind: 'cancel' });
  }
  credentialFor(serverId: string) {
    return this.activeCredentials[serverId];
  }
}
