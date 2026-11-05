import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { createTask } from '../src/engine';
import { remoteJar, shellQuote as q, type Server, type Target } from '../src/model';
import type { WorkbenchAction, WorkbenchReview } from '../src/features';
import { MemoryCredentials } from './native-capabilities';
import { remotePaths } from './remote';
import { applyRemoteJournal, targetOutcome } from './remote-events';
import { mustExec, type Transport } from './ssh';
import type { Storage } from './storage';
import {
  cleanWorkbench,
  isFinalState,
  verifyWorkbench,
  workbenchHeader,
  workbenchScope,
  type Receipt,
} from './workbench';
import {
  allowedBackup,
  archiveLegacyWorkbench,
  canDiscard,
  claimForImport,
  discardWorkbench,
  exited,
  inspectWorkbench,
  type Inspection,
} from './workbench-inspection';

const manifestSchema = z.object({
  id: z.string().regex(/^DC-[A-Za-z0-9-]{1,120}$/),
  targetId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  directory: z.string().max(4096),
  fileName: z.string().max(512),
  mode: z.enum(['jar', 'docker']),
  operation: z.enum(['deploy', 'rollback']),
  startedAt: z.number().int().min(0).max(8640000000000000),
  artifact: z.object({
    size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    modified: z
      .string()
      .max(64)
      .refine((date) => Number.isFinite(Date.parse(date)))
      .optional(),
  }),
  build: z.enum(['rebuild', 'existing']).optional(),
  branch: z.string().max(512).optional(),
  commit: z
    .string()
    .regex(/^[a-f0-9]{7,40}$/i)
    .optional(),
  backupPath: z.string().max(4096).optional(),
});
function manifest(info: Inspection, target: Target) {
  try {
    const value = manifestSchema.parse(JSON.parse(info.task));
    if (
      value.id + '-' + value.targetId !== info.owner ||
      remoteJar(value) !== remoteJar(target) ||
      value.mode !== target.mode
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}
type Preview = {
  targetId: string;
  signature: string;
  revision: string;
  action: WorkbenchAction;
  credential: string;
  timer: NodeJS.Timeout;
};

export class WorkbenchRecovery {
  private previews = new Map<string, Preview>();
  private busy = false;
  constructor(
    private storage: Storage,
    private connect: (server: Server, credential: string) => Transport,
    private idle: () => boolean,
  ) {}
  isBusy() {
    return this.busy;
  }
  private context(id: string) {
    const db = this.storage.database();
    const target = db.targets.find((entry) => entry.id === id);
    const server = target && db.servers.find((entry) => entry.id === target.serverId);
    const service = target && db.services.find((entry) => entry.id === target.serviceId);
    if (!target || !server || !service) throw new Error('部署目标配置已变化');
    return { db, target, server, service, signature: JSON.stringify([target, server]) };
  }
  private receipt(target: Target, server: Server, info: Inspection): Receipt | undefined {
    const receipts = this.storage.workbenchReceipts(new Set([workbenchScope(target, server)]));
    if (!info.present) return receipts[0];
    return receipts.find((entry) => entry.owner === (info.owner || info.cleanupOwner));
  }
  private interruptedRun(target: Target, server: Server, info: Inspection) {
    const scope = workbenchScope(target, server);
    for (const task of this.storage.unfinished()) {
      const run = task.targets.find(
        (entry) =>
          entry.remote?.protocol === 2 &&
          entry.remote.phase !== 'complete' &&
          entry.target.id === target.id &&
          (info.owner ? task.id + '-' + entry.target.id === info.owner : !info.present) &&
          workbenchScope(entry.target, entry.server) === scope,
      );
      if (run) return { task, run };
    }
    return undefined;
  }
  private review(target: Target, server: Server, info: Inspection): WorkbenchReview {
    const db = this.storage.database();
    const current = manifest(info, target);
    const receipt = this.receipt(target, server, info);
    const unfinished = this.interruptedRun(target, server, info);
    const known =
      info.jarHash &&
      (info.jarHash === target.currentHash ||
        db.history.some(
          (row) => row.target.id === target.id && row.artifact.sha256 === info.jarHash,
        ));
    const evidence = [
      info.jarHash
        ? '线上 JAR SHA-256：' +
          info.jarHash +
          (known ? '（与本机已记录版本一致）' : '（本机未记录此指纹）')
        : '线上 JAR 指纹不可读或文件不存在。',
    ];
    if (current?.artifact.sha256)
      evidence.push(
        '本次产物指纹：' +
          current.artifact.sha256 +
          (info.jarHash === current.artifact.sha256 ? '（与线上一致）' : ''),
      );
    if (target.mode === 'docker')
      evidence.push(
        '容器状态：' +
          (info.container === 'true' ? '运行中' : info.container === 'false' ? '已停止' : '未知'),
      );
    let message = '当前没有待核实的远程工作文件。';
    let action: WorkbenchAction | undefined;
    if (info.unknown.length)
      message = '发现非预期文件或链接。请在服务器上核对并移出这些文件，工具会保留现场。';
    else if (receipt && info.process !== '0') {
      message = '本机已保存结果，可以补清理远程工作文件。';
      action = 'cleanup';
    } else if (info.process === '0')
      message = '原任务仍在执行。若本机有中断任务，可继续读取进度；请等待远端完成。';
    else if (info.legacy.length && !info.lockOwner) {
      const legacyUnfinished = this.storage
        .unfinished()
        .some((task) =>
          task.targets.some(
            (run) =>
              !run.remote?.protocol &&
              run.remote?.phase !== 'complete' &&
              run.target.directory === target.directory &&
              info.legacy.includes(task.id + '-' + run.target.id),
          ),
        );
      message = legacyUnfinished
        ? '存在可继续核实的旧版中断任务，请先在首页核实。'
        : '发现旧版任务或备份审计。可在确认后归档到同一部署目录，文件会保留。';
      if (!legacyUnfinished) action = 'archive';
    } else if (
      current &&
      isFinalState(info.state) &&
      exited(info) &&
      (!info.lockOwner || info.lockOwner === info.owner)
    ) {
      message = unfinished
        ? '远端已结束，请从首页「核实中断任务」补存原任务结果和日志。'
        : '远端已结束。可核对证据，确认后保存远端结果及日志，再清理工作文件。';
      if (!unfinished) action = 'import';
    } else if (!info.present && unfinished) {
      message = '未找到原远程现场。核对线上证据后，可以把本机中断记录结案为结果未知。';
      action = 'discard';
    } else if (info.owner || info.lockOwner) {
      message = '远端结果待核实。请核对线上版本、容器和备份证据，确认原任务停止后再处理。';
      if (canDiscard(info, db.settings.staleLockMinutes || 120)) action = 'discard';
    }
    return {
      token: '',
      target: target.name,
      directory: target.directory,
      owner:
        info.owner ||
        info.cleanupOwner ||
        info.lockOwner ||
        receipt?.owner ||
        unfinished?.task.id ||
        '',
      state: info.state,
      evidence,
      unknown: info.unknown,
      legacy: info.legacy,
      message,
      action,
    };
  }
  private async withConnection<T>(
    targetId: string,
    credential: string,
    action: (
      context: ReturnType<WorkbenchRecovery['context']>,
      transport: Transport,
      mask: MemoryCredentials,
    ) => Promise<T>,
  ) {
    if (this.busy || !this.idle()) throw new Error('请先结束当前部署或远程维护操作');
    const context = this.context(targetId);
    const mask = new MemoryCredentials({ active: credential });
    this.busy = true;
    let transport: Transport | undefined;
    try {
      transport = this.connect(context.server, credential);
      await transport.connect();
      return await action(context, transport, mask);
    } catch (error) {
      throw new Error(mask.redact(error instanceof Error ? error.message : String(error)));
    } finally {
      transport?.close();
      mask.clear();
      this.busy = false;
    }
  }
  async inspect(targetId: string, credential: string) {
    return this.withConnection(
      targetId,
      credential,
      async ({ target, server, signature }, transport, mask) => {
        const info = await inspectWorkbench(transport, target);
        const review = this.review(target, server, info);
        const current = manifest(info, target);
        if (current?.backupPath && allowedBackup(target, current.backupPath)) {
          const result = await mustExec(
            transport,
            'bash -s',
            workbenchHeader(target, '') +
              'file=' +
              q(current.backupPath) +
              '\nif dc_path "$file" && dc_file "$file"; then printf EXISTS; else printf MISSING; fi',
          );
          review.evidence.push(
            '备份：' +
              current.backupPath +
              (result === 'EXISTS' ? '（存在）' : '（不可核对或不存在）'),
          );
        } else review.evidence.push('没有可核对的备份路径，请结合远程备份清单核实。');
        review.evidence = review.evidence.map((line) => mask.redact(line));
        review.unknown = review.unknown.map((line) => mask.redact(line));
        if (!review.action) return review;
        for (const [token, entry] of this.previews)
          if (entry.targetId === targetId) this.cancel(token);
        const token = randomUUID();
        this.previews.set(token, {
          targetId,
          credential,
          signature,
          revision: info.revision,
          action: review.action,
          timer: setTimeout(() => this.cancel(token), 300000).unref(),
        });
        return { ...review, token };
      },
    );
  }
  cancel(token: string) {
    const entry = this.previews.get(token);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.previews.delete(token);
  }
  async resolve(token: string, confirmation: string): Promise<string> {
    const preview = this.previews.get(token);
    if (!preview) throw new Error('远程核实已过期，请重新读取');
    const context = this.context(preview.targetId);
    if (confirmation !== context.target.name) throw new Error('请输入当前目标的完整环境名称');
    this.cancel(token);
    return this.withConnection(
      preview.targetId,
      preview.credential,
      async ({ target, server, signature, db }, transport, mask) => {
        const info = await inspectWorkbench(transport, target);
        if (
          signature !== preview.signature ||
          info.revision !== preview.revision ||
          this.review(target, server, info).action !== preview.action
        )
          throw new Error('远端状态、文件或目标配置已变化，请重新核实');
        switch (preview.action) {
          case 'cleanup': {
            const receipt = this.receipt(target, server, info)!;
            await cleanWorkbench(transport, target, receipt);
            this.storage.workbenchCleaned(receipt);
            return '已清理远程工作文件，原部署结果已保留。';
          }
          case 'archive': {
            const directory = await archiveLegacyWorkbench(
              transport,
              target,
              'DC-ARCHIVE-' + randomUUID(),
              info.legacy,
            );
            return '旧版工作文件已归档：' + directory;
          }
          case 'discard': {
            const local = this.interruptedRun(target, server, info);
            if (local) {
              const { task, run } = local;
              run.status = 'unknown';
              run.recovery = '用户已核对证据并确认结案，原任务结果仍未知。';
              run.remote!.phase = 'complete';
              task.status = task.targets.some((r) => ['success', 'unverified'].includes(r.status))
                ? 'partial'
                : 'failed';
              task.endedAt = Date.now();
              this.storage.appendLog(task.id, run.recovery + '\n', run.target.id);
              this.storage.complete(task, false);
            }
            if (!info.present) return '本机中断记录已结案，原部署结果仍标记为未知。';
            await discardWorkbench(transport, target, info, db.settings.staleLockMinutes || 120);
            return '已丢弃未核实的远程现场，原部署结果仍标记为未知。';
          }
          case 'import':
            return this.importResult(transport, mask, context, info);
        }
      },
    );
  }
  private async importResult(
    transport: Transport,
    mask: MemoryCredentials,
    { db, target, service }: ReturnType<WorkbenchRecovery['context']>,
    info: Inspection,
  ) {
    const current = manifest(info, target);
    if (!current || !isFinalState(info.state)) throw new Error('远端最终状态或任务标识不完整');
    await claimForImport(transport, target, info);
    const task = createTask(
      db,
      service,
      [target],
      {},
      current.build || 'existing',
      {
        name: target.fileName,
        path: remoteJar(target),
        size: current.artifact.size,
        sha256: current.artifact.sha256,
        exists: true,
        modified: current.artifact.modified || new Date(0).toISOString(),
        source: 'remote',
      },
      undefined,
      () => current.startedAt,
    );
    task.id = 'DC-RECOVER-' + randomUUID();
    task.note = '从远程工作台补存 · ' + info.owner;
    task.operation = current.operation;
    task.service.git = {
      branch: current.branch || '未记录',
      commit: current.commit || '未记录',
      time: '',
    };
    task.deployedCommit = current.commit;
    task.buildPhase = 3;
    task.buildSteps = [];
    const run = task.targets[0];
    run.remote = remotePaths(task, run);
    run.plannedBackupPath =
      current.backupPath && allowedBackup(target, current.backupPath) ? current.backupPath : '';
    run.startedAt = current.startedAt;
    const logDecoder = new StringDecoder('utf8');
    const journalDecoder = new StringDecoder('utf8');
    let logTail = '',
      journalTail = '';
    const append = (text: string, flush = false) => {
      logTail += text;
      const end = flush ? logTail.length : logTail.lastIndexOf('\n') + 1;
      if (!end) return;
      this.storage.appendLog(task.id, mask.redact(logTail.slice(0, end)), run.target.id);
      logTail = logTail.slice(end);
    };
    const inspectedTask = Buffer.from(info.owner + '\n' + info.task, 'utf8');
    let receipt: Receipt;
    try {
      append(task.note + '\n');
      receipt = await verifyWorkbench(
        transport,
        run,
        info.owner,
        info.state,
        (file, bytes, offset) => {
          if (
            file === 'task' &&
            !bytes.equals(inspectedTask.subarray(offset, offset + bytes.length))
          )
            throw new Error('远端任务元数据在确认后发生变化');
          if (file === 'output.log') append(logDecoder.write(bytes));
          if (file === 'journal') {
            journalTail += journalDecoder.write(bytes);
            const end = journalTail.lastIndexOf('\n') + 1;
            if (end) {
              applyRemoteJournal(run, journalTail.slice(0, end));
              journalTail = journalTail.slice(end);
            }
            if (journalTail.length > 65536) throw new Error('远端步骤日志格式异常');
          }
        },
      );
      if (receipt.files.find((file) => file.file === 'task')?.size !== inspectedTask.length)
        throw new Error('远端任务元数据长度发生变化');
      if (journalTail || journalDecoder.end()) throw new Error('远端步骤日志没有完整结束');
      append(logDecoder.end(), true);
      if (!run.plannedBackupPath) {
        run.backupCreated = false;
        run.backupPath = undefined;
      }
      run.status = targetOutcome(info.state);
      if (info.state === 'ROLLBACK_FAILED') run.error = '远端记录：新版本失败且自动回滚失败。';
      run.remote.phase = 'complete';
      run.remote.finalState = info.state;
      run.endedAt = task.endedAt = Date.now();
      task.elapsed = run.elapsed = Math.max(
        0,
        ((run.steps.reduce((end, step) => Math.max(end, step.endedAt || 0), 0) ||
          current.startedAt) -
          current.startedAt) /
          1000,
      );
      task.status = ['success', 'unverified'].includes(run.status)
        ? 'success'
        : run.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
      this.storage.persistWorkbench(task, run.target.id, receipt, true);
    } catch (error) {
      this.storage.discardUncommittedLog(task.id, run.target.id);
      throw error;
    }
    try {
      await cleanWorkbench(transport, target, receipt);
      this.storage.workbenchCleaned(receipt);
      return '已保存远端结果和完整日志，并清理远程工作文件。';
    } catch {
      const warning = '远程工作文件待清理，请在部署目标中重新核实。';
      try {
        this.storage.workbenchCleanupPending(task.id, run.target.id, warning);
      } catch {
        // 结果与保存确认已提交，远端清理仍可以重试。
      }
      return '已保存远端结果和完整日志。' + warning;
    }
  }
}
