import {
  artifactFor,
  backupPath,
  localJar,
  snapshotService,
  snapshotTarget,
  snapshotServer,
  type Backup,
  type Database,
  type History,
  type Service,
  type Step,
  type Target,
  type Task,
} from './model';
import { healthLabels } from './presentation';
export type Clock = () => number;
export function targetSteps(t: Target, b: Backup, rollback = false): Step[] {
  const steps: Step[] = [{ key: 'connect', label: '检查连接、目录、权限与可用空间' }];
  if (t.mode === 'docker')
    steps.push({
      key: 'mount',
      label: `检查${t.mount === 'file' ? '单文件' : '目录'}绑定路径；停止后替换，启动后核验哈希`,
    });
  steps.push(
    { key: 'upload', label: rollback ? '准备历史备份并核验记录' : '上传临时 JAR' },
    { key: 'verify', label: '校验大小与 SHA-256' },
    {
      key: 'backup',
      label:
        b.enabled && t.hasOldJar
          ? '备份当前版本并校验'
          : t.hasOldJar
            ? '未启用备份，跳过'
            : '首次部署，无旧 JAR，跳过备份',
    },
    {
      key: 'stop',
      label:
        t.mode === 'docker' ? '停止容器' : t.hasOldJar ? '停止旧服务' : '首次部署，跳过停止旧服务',
      critical: true,
    },
    {
      key: 'replace',
      label: t.mode === 'docker' ? '校验后原子 mv 替换宿主机 JAR' : '原子替换 JAR',
      critical: true,
    },
  );
  if (t.mode === 'jar' && t.chmod)
    steps.push({ key: 'chmod', label: '设置 chmod +x', critical: true });
  steps.push({
    key: 'start',
    label:
      t.mode === 'docker'
        ? '启动容器并按路径重新挂载'
        : t.restart
          ? '执行重启命令'
          : '执行启动命令',
    critical: true,
  });
  if (t.mode === 'docker')
    steps.push(
      { key: 'containerHash', label: '校验容器内 JAR 哈希（最终判据）', critical: true },
      { key: 'stability', label: '检查运行时长、重启次数与 Docker Healthcheck', critical: true },
    );
  steps.push({
    key: 'health',
    label:
      t.health.type === 'none'
        ? '未配置健康检查，标记未验证'
        : `${healthLabels[t.health.type]} 应用健康检查`,
    critical: true,
  });
  return steps.map((s) => ({ ...s, elapsed: 0, status: 'pending' }));
}
export function buildContext(db: Database, s: Service): Task['buildContext'] {
  const absolute = (p: string) => /^[a-zA-Z]:[\\/]|^\\\\/.test(p);
  const workDir =
    s.workDir === '.' ? s.root : absolute(s.workDir) ? s.workDir : `${s.root}\\${s.workDir}`;
  const tool = s.tool === 'maven' ? s.mavenPath || 'mvn.cmd' : `${s.root}\\mvnw.cmd`;
  return {
    tool: s.tool === 'auto' ? `${tool}（自动模式：Wrapper 优先，原型不探测）` : tool,
    command: `"${tool}" ${s.args}${s.profiles ? ' -P' + s.profiles : ''}`,
    workDir,
    jdk: s.jdk,
    jdkPath: db.jdks.find((j) => j.name === s.jdk)?.path || '未配置 JDK 路径',
    jarPath: localJar(s),
  };
}
export function createTask(
  db: Database,
  service: Service,
  targets: Target[],
  overrides: Record<string, Backup>,
  build: Task['build'],
  artifact = artifactFor(service),
  rollback?: History,
  clock: Clock = Date.now,
): Task {
  const now = clock();
  const id = 'DC-' + now.toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 7);
  const task: Task = {
    id,
    operation: rollback ? 'rollback' : 'deploy',
    service: structuredClone(service),
    artifact: structuredClone(artifact),
    build: rollback ? 'existing' : build,
    targets: targets.map((t) => {
      const b = structuredClone(overrides[t.id] || t.backup);
      return {
        target: structuredClone(t),
        server: structuredClone(db.servers.find((s) => s.id === t.serverId)!),
        backup: b,
        plannedBackupPath: backupPath(t, b, id, new Date(now)),
        backupCreated: false,
        status: 'pending',
        phase: 0,
        steps: targetSteps(t, b, !!rollback),
        logs: [],
        fail: false,
        hashMismatch: false,
        elapsed: 0,
        upload: { total: artifact.size, bytes: 0, percent: 0, speed: 0 },
      };
    }),
    failurePolicy: db.settings.failurePolicy,
    status: 'running',
    buildPhase: 0,
    buildSteps: [
      { key: 'environment', label: '检查本地环境，JDK 仅设置到构建进程' },
      {
        key: 'build',
        label: rollback
          ? '跳过构建，读取历史备份'
          : build === 'rebuild'
            ? 'Maven 构建成功，仅执行一次'
            : '使用现有 JAR，跳过构建',
      },
      { key: 'artifact', label: '生成不可变产物快照并计算 SHA-256' },
    ].map((s) => ({ ...s, elapsed: 0, status: 'pending' })),
    buildContext: buildContext(db, service),
    buildLogs: ['[模拟] 本任务不执行本地命令，也不连接真实服务器。'],
    active: 0,
    started: new Date(now).toISOString(),
    startedAt: now,
    updatedAt: now,
    elapsed: 0,
    sourceBackup: rollback?.backupPath,
    protectCurrent: true,
  };
  startStep(task.buildSteps[0], now);
  return task;
}
/** 确认窗口的停留不计入任务耗时。 */
export function startTask(input: Task, clock: Clock = Date.now): Task {
  const task = structuredClone(input),
    now = clock();
  task.startedAt = task.updatedAt = now;
  task.started = new Date(now).toISOString();
  task.buildSteps[0].startedAt = now;
  return task;
}
const ended = (t: Task) => !['running', 'cancelling'].includes(t.status);
function startStep(s: Step, now: number) {
  s.startedAt = now;
  s.elapsed = 0;
  s.status = 'running';
}
function endStep(s: Step, now: number, status: Step['status'] = 'success') {
  s.endedAt = now;
  s.elapsed = Math.max(0, now - (s.startedAt ?? now)) / 1000;
  s.status = status;
}
function startTarget(t: Task, now: number) {
  const r = t.targets[t.active];
  if (r && r.startedAt === undefined) {
    r.startedAt = now;
    startStep(r.steps[0], now);
  }
}
function finish(t: Task, now: number) {
  const failures = t.targets.some((r) => ['failed', 'rolledback'].includes(r.status)),
    successes = t.targets.some((r) => ['success', 'unverified'].includes(r.status));
  t.status = failures ? (successes ? 'partial' : 'failed') : 'success';
  t.endedAt = now;
  return t;
}
function advance(t: Task, failed: boolean, now: number) {
  t.targets[t.active].endedAt = now;
  if (t.status === 'cancelling' || (failed && t.failurePolicy === 'stop')) {
    for (let i = t.active + 1; i < t.targets.length; i++) t.targets[i].status = 'skipped';
    if (t.status === 'cancelling') {
      t.status = 'cancelled';
      t.endedAt = now;
      return t;
    }
    return finish(t, now);
  }
  t.active++;
  if (t.active === t.targets.length) return finish(t, now);
  startTarget(t, now);
  return t;
}
export function tick(input: Task, clock: Clock = Date.now): Task {
  if (ended(input)) return input;
  const t = structuredClone(input),
    now = Math.max(clock(), t.updatedAt);
  t.updatedAt = now;
  t.elapsed = Math.max(0, now - t.startedAt) / 1000;
  if (t.buildPhase < t.buildSteps.length) {
    const step = t.buildSteps[t.buildPhase];
    step.elapsed = (now - (step.startedAt ?? now)) / 1000;
    if (t.status === 'cancelling') {
      endStep(step, now, 'skipped');
      t.targets.forEach((r) => (r.status = 'skipped'));
      t.status = 'cancelled';
      t.endedAt = now;
      t.buildLogs.push('[取消] 已结束构建，清理任务快照。');
      return t;
    }
    endStep(step, now);
    t.buildLogs.push('[模拟] ' + step.label);
    t.buildPhase++;
    if (t.buildPhase < t.buildSteps.length) startStep(t.buildSteps[t.buildPhase], now);
    else {
      if (t.operation === 'deploy' && t.build === 'rebuild') {
        t.artifact.modified = new Date(now).toISOString();
        t.artifact.source = 'sample';
      }
      startTarget(t, now);
    }
    return t;
  }
  const r = t.targets[t.active];
  if (!r) return finish(t, now);
  startTarget(t, now);
  r.elapsed = (now - r.startedAt!) / 1000;
  const step = r.steps[r.phase];
  step.elapsed = (now - (step.startedAt ?? now)) / 1000;
  if (r.status === 'rollingback') {
    endStep(step, now);
    r.phase++;
    r.status = 'rolledback';
    r.recovery = '已恢复备份，按原配置重新启动并执行检查';
    r.logs.push(
      '[回滚] 恢复已校验备份，旧版本启动' +
        (r.target.health.type === 'none' ? '成功；未配置应用健康检查。' : '并通过配置的健康检查。'),
    );
    return advance(t, true, now);
  }
  // 服务切换期间不强制中断，完成检查或恢复后再停止后续目标。
  if (t.status === 'cancelling' && !step.critical) {
    endStep(step, now, 'skipped');
    r.status = 'cancelled';
    r.endedAt = now;
    r.logs.push('[取消] 清理本任务临时上传文件，未修改运行版本。');
    for (let i = t.active + 1; i < t.targets.length; i++) t.targets[i].status = 'skipped';
    t.status = 'cancelled';
    t.endedAt = now;
    return t;
  }
  r.status = 'running';
  const fail =
    (r.hashMismatch && step.key === 'containerHash') ||
    (r.fail &&
      ((step.key === 'health' && r.target.health.type !== 'none') ||
        (step.key === 'start' && r.target.health.type === 'none')));
  if (fail) {
    endStep(step, now, 'failed');
    r.error =
      step.key === 'containerHash'
        ? '模拟故障：容器内 JAR 哈希不一致'
        : r.target.health.type === 'none'
          ? '模拟故障：启动命令执行失败'
          : '模拟故障：新版本健康检查超时';
    r.logs.push('[错误] ' + r.error);
    r.steps.slice(r.phase + 1).forEach((s) => (s.status = 'skipped'));
    if (r.backupCreated && r.backupPath && r.backup.autoRollback) {
      r.status = 'rollingback';
      r.logs.push('[回滚] 开始恢复本次已验证备份。');
      r.steps.push({ key: 'rollback', label: '恢复备份并重新启动、检查', critical: true });
      r.phase = r.steps.length - 1;
      startStep(r.steps[r.phase], now);
      return t;
    }
    r.status = 'failed';
    r.recovery = '未自动回滚。请查看日志、复制排查命令，或选择其他有效历史备份恢复。';
    return advance(t, true, now);
  }
  if (step.key === 'upload') {
    r.upload.bytes = Math.min(
      r.upload.total,
      r.upload.bytes + Math.max(1, Math.ceil(r.upload.total / 3)),
    );
    r.upload.percent = r.upload.total ? Math.round((r.upload.bytes / r.upload.total) * 100) : 100;
    r.upload.speed = step.elapsed > 0 ? r.upload.bytes / step.elapsed : 0;
    if (r.upload.bytes < r.upload.total) return t;
  }
  // 回滚资格来自成功执行的结构化备份结果，文案和日志不参与判断。
  if (step.key === 'backup' && r.backup.enabled && r.target.hasOldJar) {
    r.backupCreated = true;
    r.backupPath = r.plannedBackupPath;
  }
  endStep(step, now);
  r.logs.push(
    '[模拟] ' +
      step.label +
      (step.key === 'health' && r.target.health.type !== 'none'
        ? `：${r.target.health.value}`
        : ''),
  );
  r.phase++;
  if (r.phase === r.steps.length) {
    r.status = r.target.health.type === 'none' ? 'unverified' : 'success';
    return advance(t, false, now);
  }
  startStep(r.steps[r.phase], now);
  return t;
}
export function cancelTask(task: Task): Task {
  return ended(task) ? task : { ...task, status: 'cancelling' };
}
export function requestFailure(
  task: Task,
  kind: 'application' | 'containerHash' = 'application',
): Task {
  const t = structuredClone(task),
    r = t.targets[t.active];
  if (r) {
    if (kind === 'containerHash') r.hashMismatch = true;
    else r.fail = true;
  }
  return t;
}
export function toHistory(task: Task): History[] {
  // 未修改运行版本的取消和跳过只留在当前任务视图，不生成版本历史。
  return task.targets
    .filter((r) => ['success', 'unverified', 'failed', 'rolledback', 'unknown'].includes(r.status))
    .map((r, i) => ({
      id: task.id + '-' + i,
      taskId: task.id,
      operation: task.operation,
      service: snapshotService(task.service),
      target: snapshotTarget(r.target),
      server: snapshotServer(r.server),
      artifact: structuredClone(task.artifact),
      build: task.build,
      status: r.status,
      time: task.started,
      elapsed: r.elapsed,
      backupCreated: r.backupCreated,
      backupCreatedAt: r.backupCreatedAt,
      backupRemoved: r.backupRemoved,
      backupHash: r.backupHash,
      backupSize: r.backupSize,
      backupVersion: r.backupVersion,
      backupPath: r.backupCreated ? r.backupPath : undefined,
      steps: structuredClone(r.steps),
      logs: [...r.logs],
      error: r.error,
      recovery: r.recovery,
      note: task.note,
      deployedCommit: task.deployedCommit,
    }));
}
