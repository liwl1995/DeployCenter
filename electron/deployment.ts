import path from 'node:path';
import { shellQuote as q, seconds, type RunTarget, type Step, type Task } from '../src/model';
import { acceptBuild } from '../src/validation';
import { jarPath } from './files';
import { nativeCapabilities } from './native-capabilities';
import type { EngineDependencies } from './capabilities';
import { localHealth } from './health';
import { mustExec, type Transport } from './ssh';
import {
  inspectDocker,
  preflightScript,
  runnerScript,
  remotePaths,
  writeRemoteFile,
  cleanupPrepared,
  dryRunScript,
  type DockerInfo,
} from './remote';
import { errorText, type WorkerInput, type WorkerMessage } from './contracts';
import type { TrustRequest } from '../src/platform';

const completed = (s: string) =>
  ['success', 'unverified', 'failed', 'rolledback', 'skipped', 'cancelled'].includes(s);
export class Deployment {
  task: Task;
  private cancelled = false;
  private controller = new AbortController();
  private transport?: Transport;
  private pendingLogs = new Map<string, string>();
  private lastSnapshot = 0;
  constructor(
    private input: WorkerInput,
    private send: (message: WorkerMessage) => void,
    private trust: (request: TrustRequest, key: string) => Promise<boolean>,
    private deps: EngineDependencies = nativeCapabilities(input.credentials),
  ) {
    this.task = structuredClone(input.task);
  }
  private redact(text: string) {
    return this.deps.credentials.redact(text);
  }
  private log(text: string, r?: RunTarget, flush = false) {
    const id = r?.target.id || 'build';
    const pending = (this.pendingLogs.get(id) || '') + text;
    const cut = flush ? pending.length : pending.lastIndexOf('\n') + 1;
    if (!cut) {
      this.pendingLogs.set(id, pending);
      return;
    }
    const safe = this.redact(pending.slice(0, cut));
    this.pendingLogs.set(id, pending.slice(cut));
    this.send({ kind: 'log', taskId: this.task.id, targetId: r?.target.id, text: safe });
    const list = r ? r.logs : this.task.buildLogs;
    list.push(...safe.replace(/\r/g, '').split('\n').filter(Boolean));
    if (list.length > 1500) list.splice(0, list.length - 1500);
  }
  private emit(force = false) {
    const now = this.deps.clock.now();
    this.task.updatedAt = now;
    this.task.elapsed = (now - this.task.startedAt) / 1000;
    const r = this.task.targets[this.task.active];
    if (r?.startedAt !== undefined && !completed(r.status)) r.elapsed = (now - r.startedAt) / 1000;
    for (const step of [...this.task.buildSteps, ...(r?.steps || [])])
      if (step.status === 'running' && step.startedAt !== undefined)
        step.elapsed = Math.max(0, now - step.startedAt) / 1000;
    if (force || now - this.lastSnapshot > 200) {
      this.lastSnapshot = now;
      const snapshot = structuredClone(this.task);
      snapshot.buildLogs = [];
      for (const target of snapshot.targets) target.logs = [];
      this.send({ kind: 'snapshot', task: snapshot });
    }
  }
  private start(step: Step) {
    step.status = 'running';
    step.startedAt = this.deps.clock.now();
    step.elapsed = 0;
    this.emit(true);
  }
  private finish(step: Step, status: Step['status'] = 'success') {
    step.status = status;
    step.endedAt = this.deps.clock.now();
    step.elapsed = (step.endedAt - (step.startedAt || step.endedAt)) / 1000;
    this.emit(true);
  }
  private async phase(r: RunTarget, key: string, action: () => Promise<void>) {
    const index = r.steps.findIndex((s) => s.key === key);
    if (index < 0) throw new Error('未知部署阶段：' + key);
    r.phase = index;
    const step = r.steps[index];
    this.start(step);
    try {
      await action();
      this.finish(step);
      r.phase = index + 1;
    } catch (e) {
      this.finish(
        step,
        this.cancelled && !r.remote?.phase.match(/running|launching/) ? 'skipped' : 'failed',
      );
      throw e;
    }
  }
  private makeTransport(r: RunTarget, cleanup = false) {
    return this.deps.remote(r.server, {
      credential: this.deps.credentials.get(r.server.id),
      signal: cleanup ? undefined : this.controller.signal,
      pins: this.input.pins,
      trust: this.trust,
    });
  }
  async cancel() {
    this.cancelled = true;
    this.task.status = 'cancelling';
    const r = this.task.targets[this.task.active];
    this.emit(true);
    if (r?.remote && ['running', 'launching'].includes(r.remote.phase)) {
      try {
        await mustExec(this.transport!, 'printf 1 > ' + q(r.remote.jobDir + '/cancel'));
        this.log('已向远端写入取消请求，等待安全边界。\n', r);
      } catch {
        this.log('取消标记暂未送达；不会强制杀死远端切换，需核实执行结果。\n', r);
      }
    } else this.controller.abort();
  }
  async run() {
    try {
      await this.deps.files.mkdir(path.join(this.input.dataDir, 'tmp'));
      if (this.task.dryRun) await this.dryRun();
      else if (this.input.kind === 'recover') await this.recover();
      else {
        await this.build();
        for (let i = 0; i < this.task.targets.length; i++) {
          this.task.active = i;
          const r = this.task.targets[i];
          if (this.cancelled) {
            r.status = 'skipped';
            continue;
          }
          await this.deployTarget(r);
          if (
            this.task.status === 'interrupted' ||
            this.cancelled ||
            ((r.status === 'failed' || r.status === 'rolledback') &&
              this.task.failurePolicy === 'stop')
          ) {
            for (let j = i + 1; j < this.task.targets.length; j++)
              this.task.targets[j].status = 'skipped';
            break;
          }
        }
      }
    } catch (e) {
      this.log(errorText(e) + '\n', undefined, true);
      if (this.task.buildPhase < 3) {
        const current = this.task.buildSteps[this.task.buildPhase];
        if (current) this.finish(current, this.cancelled ? 'skipped' : 'failed');
        for (const r of this.task.targets) if (r.status === 'pending') r.status = 'skipped';
        this.task.status = this.cancelled ? 'cancelled' : 'failed';
      } else {
        this.task.status = 'interrupted';
        for (const r of this.task.targets)
          if (
            r.remote &&
            r.remote.phase !== 'complete' &&
            ['running', 'rollingback'].includes(r.status)
          ) {
            r.status = 'unknown';
            r.error = errorText(e);
          }
      }
    } finally {
      this.transport?.close();
      this.log('', undefined, true);
      for (const r of this.task.targets) this.log('', r, true);
      if (this.task.status !== 'interrupted') {
        const failures = this.task.targets.some((r) => ['failed', 'rolledback'].includes(r.status));
        const successes = this.task.targets.some((r) =>
          ['success', 'unverified'].includes(r.status),
        );
        this.task.status = this.cancelled
          ? 'cancelled'
          : this.task.status === 'failed'
            ? 'failed'
            : failures
              ? successes
                ? 'partial'
                : 'failed'
              : successes
                ? 'success'
                : 'cancelled';
        this.task.endedAt = this.deps.clock.now();
      }
      this.emit(true);
      this.send({ kind: 'done', task: this.task });
      this.input.credentials = {};
      this.deps.credentials.clear();
    }
  }
  private async dryRun() {
    const t = this.task;
    this.start(t.buildSteps[0]);
    if (t.build === 'rebuild')
      await this.deps.commands.resolveBuild(
        t.service,
        this.input.jdks,
        path.join(this.input.dataDir, 'tmp'),
        { signal: this.controller.signal },
      );
    else {
      const file = t.artifact.path || jarPath(t.service);
      if (!(await this.deps.files.stat(file))) throw new Error('本地 JAR 不存在：' + file);
    }
    this.finish(t.buildSteps[0]);
    t.buildPhase = 3;
    for (let i = 0; i < t.targets.length; i++) {
      t.active = i;
      const r = t.targets[i];
      if (this.cancelled) {
        r.status = 'skipped';
        continue;
      }
      r.startedAt = this.deps.clock.now();
      r.status = 'running';
      this.transport = this.makeTransport(r);
      try {
        await this.phase(r, 'connect', () => this.transport!.connect());
        await this.phase(r, 'preflight', async () => {
          const checked = await this.transport!.exec('bash -s', { input: dryRunScript(t, r) });
          this.log(checked.stdout + checked.stderr, r, true);
          if (checked.code) throw new Error(checked.stderr || checked.stdout);
        });
        if (r.target.mode === 'docker')
          await this.phase(r, 'mount', async () => {
            await inspectDocker(this.transport!, r);
          });
        r.status = 'success';
        r.phase = r.steps.length;
      } catch (e) {
        r.status = this.cancelled ? 'cancelled' : 'failed';
        r.error = this.redact(errorText(e));
        this.log(r.error + '\n', r, true);
      } finally {
        r.endedAt = this.deps.clock.now();
        r.elapsed = (r.endedAt - r.startedAt!) / 1000;
        this.transport?.close();
        this.emit(true);
      }
      if (r.status === 'failed' && t.failurePolicy === 'stop') {
        for (let j = i + 1; j < t.targets.length; j++) t.targets[j].status = 'skipped';
        break;
      }
    }
  }
  private async build() {
    const t = this.task,
      temp = path.join(this.input.dataDir, 'tmp');
    this.start(t.buildSteps[0]);
    const git = await this.deps.commands.gitInfo(t.service.root);
    if (t.operation !== 'rollback') t.service.git = git;
    const resolved =
      t.operation === 'deploy' && t.build === 'rebuild'
        ? await this.deps.commands.resolveBuild(t.service, this.input.jdks, temp, {
            signal: this.controller.signal,
          })
        : undefined;
    if (resolved)
      t.buildContext = {
        ...t.buildContext,
        tool: resolved.tool,
        workDir: resolved.cwd,
        command: [resolved.tool, ...resolved.args].join(' '),
        jdkPath: resolved.jdkPath,
      };
    this.finish(t.buildSteps[0]);
    t.buildPhase = 1;
    this.start(t.buildSteps[1]);
    let artifactPath = t.artifact.path;
    if (t.operation === 'rollback') this.log('使用远端历史备份，跳过本地 Maven 和 JAR 构建。\n');
    else if (resolved) {
      const started = this.deps.clock.now();
      this.log('构建工作目录：' + resolved.cwd + '\n使用 JDK：' + resolved.jdkPath + '\n');
      const result = await resolved.run({
        signal: this.controller.signal,
        timeout: (t.service.buildTimeout || 1800) * 1000,
        encoding: t.service.logEncoding || 'auto',
        onData: (text) => {
          this.log(text);
          this.emit();
        },
      });
      this.log('', undefined, true);
      artifactPath = jarPath(t.service);
      const output = await this.deps.files.stat(artifactPath);
      if (
        !acceptBuild(
          {
            exitCode: result.code,
            successMarker: result.successMarker,
            validJar: !!output?.isFile() && output.size > 0,
            modified: output?.mtimeMs || 0,
            started,
          },
          this.input.allowMavenNonzero,
        )
      )
        throw new Error(
          `Maven 构建未通过（退出码 ${result.code}）。产物必须存在且晚于本次构建开始；若未更新请使用 clean 或明确选择现有 JAR。`,
        );
      if (result.code)
        this.log('警告：本次按兼容设置接受异常退出码；成功标记和新产物时间检查均通过。\n');
    } else this.log('跳过 Maven，使用已选择的本地 JAR。\n');
    this.finish(t.buildSteps[1]);
    t.buildPhase = 2;
    this.start(t.buildSteps[2]);
    if (t.operation !== 'rollback') {
      t.artifact = await this.deps.files.snapshot(
        artifactPath,
        t.id,
        this.input.dataDir,
        this.controller.signal,
      );
      t.deployedVersion =
        t.build === 'rebuild' && !git.dirty && !git.commit.includes('待计算')
          ? git.commit
          : t.artifact.sha256!.slice(0, 12);
      this.log('JAR 完整性校验通过，SHA-256：' + t.artifact.sha256 + '\n');
    } else {
      t.deployedVersion = t.service.git.commit;
      this.log('历史备份的实际文件大小和哈希将在远端校验。\n');
    }
    this.finish(t.buildSteps[2]);
    t.buildPhase = 3;
    this.emit(true);
  }
  private async deployTarget(r: RunTarget) {
    r.startedAt = this.deps.clock.now();
    r.status = 'running';
    this.transport = this.makeTransport(r);
    let docker: DockerInfo | undefined;
    try {
      await this.phase(r, 'connect', async () => {
        await this.transport!.connect();
        this.log('SSH 连接已建立：' + r.server.name + '\n', r);
      });
      if (this.task.operation === 'rollback') {
        if (!this.task.sourceBackup) throw new Error('缺少恢复来源');
        const size = Number(
          (await mustExec(this.transport!, 'stat -c%s -- ' + q(this.task.sourceBackup))).trim(),
        );
        if (!Number.isSafeInteger(size) || size <= 0 || size !== this.task.artifact.size)
          throw new Error('远端备份文件无效或大小与历史记录不一致');
      }
      r.remote = remotePaths(this.task, r);
      const checked = await this.transport.exec('bash -s', {
        input: preflightScript(this.task, r, this.input.allowWeak, docker),
        timeout: 120000,
      });
      this.log(checked.stdout + checked.stderr, r, true);
      if (checked.code) throw new Error('远端预检失败：' + checked.stderr.trim());
      const metadata = (
        await mustExec(this.transport, 'cat -- ' + q(r.remote.jobDir + '/preflight'))
      ).split('\n');
      const fields = Object.fromEntries(metadata.filter(Boolean).map((line) => line.split('=', 2)));
      r.target.hasOldJar = fields.old_exists === '1';
      if (r.target.mode === 'docker')
        await this.phase(r, 'mount', async () => {
          docker = await inspectDocker(this.transport!, r);
          r.target.mount = docker.mount;
          this.log(
            `检测到${docker.mount === 'file' ? '单文件' : '目录'}绑定：${docker.containerJar}。容器停止后原子替换。\n`,
            r,
          );
        });
      if (r.target.hasOldJar)
        r.backupVersion =
          fields.old_hash && fields.old_hash === r.target.currentHash
            ? r.target.version
            : fields.old_hash?.slice(0, 12) || '未知旧版本';
      if (fields.algorithm === 'none')
        this.log('警告：远端缺少哈希工具，本次经确认仅按字节数校验；此模式只允许普通 JAR。\n', r);
      await this.phase(r, 'upload', async () => {
        if (this.task.operation === 'rollback') {
          const source = this.task.sourceBackup!;
          const expected = this.task.artifact.sha256;
          const hash =
            fields.algorithm === 'none'
              ? ''
              : fields.algorithm === 'sha256sum'
                ? `sha256sum -- ${q(source)} | awk '{print $1}'`
                : fields.algorithm === 'shasum'
                  ? `shasum -a 256 -- ${q(source)} | awk '{print $1}'`
                  : `openssl dgst -sha256 ${q(source)} | awk '{print $NF}'`;
          if (expected && hash && (await mustExec(this.transport!, hash)).trim() !== expected)
            throw new Error('历史备份哈希与记录不一致，已阻止回滚');
          if (!expected && fields.algorithm !== 'none')
            throw new Error('历史备份缺少已记录哈希，不能静默信任更改过的文件');
          await mustExec(
            this.transport!,
            `test -f ${q(source)} && test ! -L ${q(source)} && cp -p -- ${q(source)} ${q(r.remote!.stagePath)}`,
          );
          r.upload = {
            total: this.task.artifact.size,
            bytes: this.task.artifact.size,
            percent: 100,
            speed: 0,
          };
        } else {
          const started = this.deps.clock.now();
          await this.transport!.upload(
            this.task.artifact.path,
            r.remote!.stagePath,
            (bytes) => {
              r.upload = {
                total: this.task.artifact.size,
                bytes,
                percent: Math.min(100, Math.round((bytes / this.task.artifact.size) * 100)),
                speed: bytes / Math.max(0.001, (this.deps.clock.now() - started) / 1000),
              };
              this.emit();
            },
            this.controller.signal,
          );
        }
      });
      if (this.cancelled) throw new Error('操作已取消');
      await writeRemoteFile(
        this.transport,
        r.remote.jobDir + '/runner.sh',
        runnerScript(this.task, r, this.input.allowWeak, docker),
      );
      r.remote.phase = 'launching';
      this.emit(true);
      await mustExec(
        this.transport,
        `printf LAUNCHING > ${q(r.remote.jobDir + '/state')}; nohup bash ${q(r.remote.jobDir + '/runner.sh')} > ${q(r.remote.jobDir + '/output.log')} 2>&1 < /dev/null & pid=$!; printf '%s' "$pid" > ${q(r.remote.jobDir + '/pid')}; printf '%s' "$pid"`,
      );
      r.remote.phase = 'running';
      this.emit(true);
      await this.monitor(r);
    } catch (e) {
      const message = this.redact(errorText(e));
      this.log(message + '\n', r, true);
      r.error = message;
      if (r.remote && ['running', 'launching'].includes(r.remote.phase)) {
        r.status = 'unknown';
        this.task.status = 'interrupted';
        r.recovery =
          'SSH 中断或远端结果未确认。停止后续目标；使用“核实中断任务”读取原任务状态，禁止盲目重试。';
      } else {
        r.status = this.cancelled ? 'cancelled' : 'failed';
        if (r.remote) {
          try {
            this.transport?.close();
            this.transport = this.makeTransport(r, true);
            await this.transport.connect();
            await cleanupPrepared(this.transport, this.task, r);
            r.remote.phase = 'complete';
          } catch (cleanupError) {
            this.task.status = 'interrupted';
            r.recovery =
              '运行版本未被替换，但临时上传/任务锁尚未清理：' +
              this.redact(errorText(cleanupError));
          }
        }
      }
    } finally {
      r.endedAt = this.deps.clock.now();
      r.elapsed = (r.endedAt - r.startedAt) / 1000;
      this.transport?.close();
      this.emit(true);
    }
  }
  private journal(r: RunTarget, text: string) {
    for (const line of text.split('\n').filter(Boolean)) {
      const [stamp, kind, key, status] = line.split('\t');
      const time = Number(stamp);
      if (!Number.isFinite(time)) throw new Error('远端任务事件无效');
      if (kind === 'BACKUP') {
        r.backupCreated = true;
        r.backupPath = r.plannedBackupPath;
        r.backupSize = Number(key);
        r.backupHash = /^[a-f0-9]{64}$/i.test(status) ? status : undefined;
        continue;
      }
      if (kind !== 'STEP') continue;
      let index = r.steps.findIndex((s) => s.key === key);
      if (key === 'rollback' && index < 0) {
        r.steps.push({ key: 'rollback', label: '恢复旧版本并重新启动、检查', critical: true });
        index = r.steps.length - 1;
      }
      if (index < 0) continue;
      const step = r.steps[index];
      r.phase = index;
      if (status === 'START') {
        step.startedAt = time;
        step.status = 'running';
        if (key === 'rollback') r.status = 'rollingback';
      } else {
        step.endedAt = time;
        step.elapsed = Math.max(0, time - (step.startedAt ?? time)) / 1000;
        step.status = status === 'OK' ? 'success' : status === 'FAIL' ? 'failed' : 'skipped';
        if (status !== 'FAIL') r.phase = index + 1;
        else {
          r.steps.slice(index + 1).forEach((s) => {
            if (s.status === 'pending') s.status = 'skipped';
          });
          r.error = '远端步骤失败：' + step.label;
        }
      }
    }
  }
  private async readRemote(r: RunTarget, final = false) {
    const remote = r.remote!;
    const journal = await this.transport!.read(remote.jobDir + '/journal', remote.journalOffset);
    const last = journal.lastIndexOf(10);
    if (last >= 0) {
      this.journal(r, journal.subarray(0, last + 1).toString('utf8'));
      remote.journalOffset += last + 1;
    }
    for (let i = 0; i < 20; i++) {
      const data = await this.transport!.read(remote.jobDir + '/output.log', remote.logOffset);
      if (!data.length) break;
      const end = final ? data.length : data.lastIndexOf(10) + 1;
      if (!end) {
        if (data.length >= 262144) {
          this.log('警告：远端单行输出过长，日志按块保留。\n', r);
          this.log(data.toString('utf8'), r, true);
          remote.logOffset += data.length;
        }
        break;
      }
      this.log(data.subarray(0, end).toString('utf8'), r, final);
      remote.logOffset += end;
      if (data.length < 262144) break;
    }
  }
  private async monitor(r: RunTarget) {
    let empty = 0;
    while (true) {
      const state = (
        await mustExec(this.transport!, 'cat -- ' + q(r.remote!.jobDir + '/state'))
      ).trim();
      const final = [
        'SUCCESS',
        'UNVERIFIED',
        'FAILED',
        'ROLLEDBACK',
        'ROLLBACK_FAILED',
        'CANCELLED',
      ].includes(state);
      await this.readRemote(r, final);
      this.emit(true);
      if (state === 'AWAITING_LOCAL') {
        const passed = await localHealth(
          { ...r.target.health, startDelay: 0 }, // 静默等待已由远端 runner 执行，不重复等待。
          this.deps.clock,
          this.controller.signal,
          (text) => this.log(text, r),
        );
        await mustExec(
          this.transport!,
          'printf ' + q(passed ? 'PASS' : 'FAIL') + ' > ' + q(r.remote!.jobDir + '/local-health'),
        );
      }
      if (final) {
        r.remote!.phase = 'complete';
        r.status =
          state === 'SUCCESS'
            ? 'success'
            : state === 'UNVERIFIED'
              ? 'unverified'
              : state === 'ROLLEDBACK'
                ? 'rolledback'
                : state === 'CANCELLED'
                  ? 'cancelled'
                  : 'failed';
        if (state === 'ROLLBACK_FAILED') {
          r.error = '新版本失败且自动回滚失败';
          r.recovery = '请查看回滚阶段日志，原备份未删除：' + (r.backupPath || '无可用备份');
        } else if (state === 'ROLLEDBACK')
          r.recovery = '已恢复旧 JAR，并按目标配置重新启动和检查。';
        else if (state === 'FAILED')
          r.recovery = r.backupCreated
            ? '存在备份，但未成功自动恢复。请查看日志或发起历史回滚。'
            : '无本次有效备份，请查看日志和排查命令，必要时选择更早的历史备份。';
        if (['success', 'unverified'].includes(r.status)) r.phase = r.steps.length;
        this.log(`目标结果：${r.status}。\n`, r, true);
        return;
      }
      if (!['RUNNING', 'LAUNCHING', 'PREPARED', 'AWAITING_LOCAL'].includes(state))
        throw new Error('无法识别远端任务状态：' + state);
      const alive = await this.transport!.exec(
        `pid=$(cat ${q(r.remote!.jobDir + '/pid')} 2>/dev/null || true); case "$pid" in ''|*[!0-9]*) exit 1;; esac; kill -0 "$pid" 2>/dev/null`,
      );
      if (alive.code && ++empty >= 3)
        throw new Error('远端任务进程已退出，但未写入最终状态，必须人工核实');
      if (!alive.code) empty = 0;
      await this.deps.clock.sleep(1000);
    }
  }
  private async recover() {
    const t = this.task,
      r = t.targets.find((r) => r.remote && r.remote.phase !== 'complete');
    if (!r) throw new Error('没有可核实的远端任务');
    t.active = t.targets.indexOf(r);
    this.transport = this.makeTransport(r, true);
    await this.transport.connect();
    const state = (
      await mustExec(this.transport, 'cat -- ' + q(r.remote!.jobDir + '/state'))
    ).trim();
    if (state === 'PREPARED') {
      await cleanupPrepared(this.transport, t, r);
      r.status = 'cancelled';
      r.remote!.phase = 'complete';
      this.log('已清理尚未启动的上传任务，未修改运行版本。\n', r);
    } else {
      r.status = 'running';
      this.log('只核实原任务，不重复上传、备份或替换，也不继续其他目标。\n', r);
      await this.monitor(r);
    }
    for (let i = t.active + 1; i < t.targets.length; i++) t.targets[i].status = 'skipped';
    if (t.status === 'interrupted') t.status = 'running';
    r.endedAt = this.deps.clock.now();
    r.elapsed = (r.endedAt - (r.startedAt || r.endedAt)) / 1000;
    this.log('核实结束，累计耗时 ' + seconds(r.elapsed) + '\n', r);
  }
}
