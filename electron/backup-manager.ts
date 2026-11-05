import { workbenchHeader } from './workbench';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { shellQuote as q, remoteJar, type Server, type Target } from '../src/model';
import type {
  BackupEntry,
  BackupPlan,
  MaintenanceRecord,
  RemoteBackupRecord,
} from '../src/features';
import { Storage } from './storage';
import { backupConnection } from './backup-catalog';
import type { Transport } from './ssh';
import { MemoryCredentials } from './native-capabilities';

type Frame = {
  public: BackupPlan;
  target: Target;
  server: Server;
  credential: string;
  directory: string;
  signature: string;
  records: RemoteBackupRecord[];
  metadata: Map<string, { size: number; modified: number }>;
  until: number;
  timer: ReturnType<typeof setTimeout>;
};
const pending = (status: string) => ['running', 'cancelling', 'interrupted'].includes(status);
const directoryOf = (t: Target) => path.posix.resolve(t.directory, t.backup.directory || 'backups');
const regularName = (base: string, file: string) =>
  base !== '/' &&
  file.startsWith('/') &&
  !/[\r\n\0]/.test(file) &&
  path.posix.dirname(file) === base &&
  !['.', '..'].includes(path.posix.basename(file));

/** 一次只读查询已证明的文件名；不扫描通配符，也不把服务器任意文件当成本工具备份。 */
export function inspectBackupsScript(
  directory: string,
  records: { id: string; path: string }[],
  targetDirectory?: string,
) {
  return `set -eu
base=${q(directory)}
[ -d "$base" ] && [ -r "$base" ] && [ -x "$base" ] || { printf 'BASE_UNAVAILABLE\\n'; exit 0; }
cd -P -- "$base"
[ "$(pwd -P)" = "$base" ] || { printf 'BASE_LINK\\n'; exit 0; }
${targetDirectory ? `if [ -d ${q(targetDirectory + '/.deploy-center.lock')} ]; then printf 'LOCKED\\n'; fi` : ''}
${records
  .map(
    (record) => `file=${q('./' + path.posix.basename(record.path))}
if [ -L "$file" ]; then printf '%s\\tLINK\\n' ${q(record.id)}; elif [ ! -e "$file" ]; then printf '%s\\tMISSING\\n' ${q(record.id)}; elif [ ! -f "$file" ]; then printf '%s\\tOTHER\\n' ${q(record.id)}; elif value=$(stat -c '%s %Y' -- "$file" 2>/dev/null); then printf '%s\\tFILE\\t%s\\n' ${q(record.id)} "$value"; else printf '%s\\tUNREADABLE\\n' ${q(record.id)}; fi`,
  )
  .join('\n')}
`;
}
/** 两次校验并固定工作目录，只删除清单里的单个文件名；锁和核实记录均位于明确声明的工具目录。 */
export function cleanupBackupsScript(
  target: Target,
  directory: string,
  auditId: string,
  entries: { id: string; path: string; size: number; modified: number; hash: string }[],
) {
  if (
    !/^DC-CLEAN-[a-zA-Z0-9-]+$/.test(auditId) ||
    !entries.length ||
    entries.some(
      (e) =>
        !regularName(directory, e.path) ||
        !/^[a-f0-9]{64}$/i.test(e.hash) ||
        !Number.isSafeInteger(e.size) ||
        e.size <= 0 ||
        !Number.isSafeInteger(e.modified),
    )
  )
    throw new Error('备份清理范围无效');
  const verify = (e: (typeof entries)[number]) =>
    `check_file ${q('./' + path.posix.basename(e.path))} ${q(String(e.size))} ${q(String(e.modified))} ${q(e.hash)}`;
  return workbenchHeader(target, auditId) +
`[ -d "$DIR" ] && dc_path "$DIR" || { printf 'REJECTED:部署目录包含链接或归属不符\\n'; exit 1; }
dc_acquire || { printf 'REJECTED:目标已有任务锁\\n'; exit 1; }
cleanup_lock() {
  if dc_lock; then
    if dc_file "$LOCK/pid"; then rm -- "$LOCK/pid"; fi
    dc_unlock || true
  fi
}
trap cleanup_lock EXIT
trap 'exit 129' HUP INT TERM
(umask 077; set -C; printf '%s %s %s\\n' "$$" "$(dc_proc "$$")" "$(cat /proc/sys/kernel/random/boot_id)" > "$LOCK/pid")
set -eu
cd -P -- ${q(directory)}
[ "$(pwd -P)" = ${q(directory)} ] || { printf 'REJECTED:备份目录包含链接\\n'; exit 1; }
hash_file() { if command -v sha256sum >/dev/null 2>&1; then timeout ${q(String(target.commandTimeout || 120))} sha256sum -- "$1" | awk '{print $1}'; elif command -v shasum >/dev/null 2>&1; then timeout ${q(String(target.commandTimeout || 120))} shasum -a 256 -- "$1" | awk '{print $1}'; elif command -v openssl >/dev/null 2>&1; then timeout ${q(String(target.commandTimeout || 120))} openssl dgst -sha256 "$1" | awk '{print $NF}'; else return 1; fi; }
check_file() { [ "$(pwd -P)" = ${q(directory)} ] && [ ! -L "$1" ] && [ -f "$1" ] && [ "$(stat -c%s -- "$1")" = "$2" ] && [ "$(stat -c%Y -- "$1")" = "$3" ] && [ "$(hash_file "$1")" = "$4" ]; }
${entries.map((e) => `${verify(e)} || { printf 'REJECTED:文件变化，已保留\\n'; exit 1; }`).join('\n')}
printf 'VERIFIED\\n'
failed=0
${entries.map((e) => `if ${verify(e)} && rm -f -- ${q('./' + path.posix.basename(e.path))}; then printf 'DELETED\\t%s\\n' ${q(e.id)}; else printf 'FAILED\\t%s\\n' ${q(e.id)}; failed=1; fi`).join('\n')}
printf 'FINISHED\\n'
exit "$failed"
`;
}
export class BackupManager {
  private frames = new Map<string, Frame>();
  private busy = false;
  constructor(
    private storage: Storage,
    private connect: (server: Server, credential: string) => Transport,
    private onAudit: (record: MaintenanceRecord) => void,
    private now: () => number = Date.now,
  ) {}
  isBusy() {
    return this.busy;
  }
  private context(targetId: string) {
    const db = this.storage.database(),
      target = db.targets.find((t) => t.id === targetId),
      server = target && db.servers.find((s) => s.id === target.serverId);
    if (!target || !server) throw new Error('目标或服务器配置不存在');
    return { target, server };
  }
  private signature(target: Target, server: Server) {
    return JSON.stringify([
      target,
      server,
      this.storage.remoteBackups.records(target.id),
      this.storage
        .allTasks()
        .filter((t) => pending(t.status))
        .map((t) => [t.id, t.status, t.sourceBackup, t.targets.map((r) => r.backupPath)]),
    ]);
  }
  private protectedReason(
    record: RemoteBackupRecord,
    target: Target,
    server: Server,
    latest?: RemoteBackupRecord,
  ) {
    if (record.connection !== backupConnection(server)) return '服务器连接配置已变化，原备份保留';
    if (!regularName(directoryOf(target), record.path)) return '不在当前备份目录内，原文件保留';
    if (record.path === path.posix.normalize(remoteJar(target))) return '当前运行的 JAR，禁止清理';
    if (
      this.storage.remoteBackups
        .audits()
        .some(
          (a) =>
            ['pending', 'unknown'].includes(a.status) &&
            a.requested.some((f) => f.id === record.id),
        )
    )
      return '有关清理结果尚待核实，请先只读核实原记录';
    if (!record.hash || !/^[a-f0-9]{64}$/i.test(record.hash))
      return '旧记录缺少完整指纹，不能安全清理';
    if (
      this.storage
        .allTasks()
        .some(
          (t) =>
            pending(t.status) &&
            ((t.sourceBackup && path.posix.normalize(t.sourceBackup) === record.path) ||
              t.targets.some(
                (r) => r.backupPath && path.posix.normalize(r.backupPath) === record.path,
              )),
        )
    )
      return '正在被运行或中断任务引用，禁止清理';
    if (record.id === latest?.id) return '最近一次任务产生的备份，保留';
    return '';
  }
  async preview(targetId: string, credential: string): Promise<BackupPlan> {
    const { target, server } = this.context(targetId),
      directory = directoryOf(target),
      records = this.storage.remoteBackups
        .records(targetId)
        .filter((r) => !r.removed)
        .slice(0, 2000),
      latest = records.find((r) => r.connection === backupConnection(server));
    const candidates = records.filter(
      (r) => r.connection === backupConnection(server) && regularName(directory, r.path),
    );
    const metadata = new Map<string, { size: number; modified: number }>(),
      states = new Map<string, string>();
    const transport = this.connect(server, credential),
      mask = new MemoryCredentials({ active: credential });
    let locked = false,
      unavailable = '';
    try {
      if (candidates.length) {
        await transport.connect();
        const result = await transport.exec('bash -s', {
          input: inspectBackupsScript(
            directory,
            candidates,
            path.posix.normalize(target.directory),
          ),
          timeout: 120000,
        });
        if (result.code) throw new Error(mask.redact(result.stderr || result.stdout));
        locked = result.stdout.split('\n').includes('LOCKED');
        if (/BASE_UNAVAILABLE|BASE_LINK/.test(result.stdout))
          unavailable = '备份目录不可读或包含链接，未执行清理';
        for (const line of result.stdout.split('\n')) {
          const [id, state, values] = line.split('\t');
          if (!records.some((r) => r.id === id)) continue;
          states.set(id, state);
          if (state === 'FILE' && /^\d+ -?\d+$/.test(values || '')) {
            const [size, modified] = values.split(' ').map(Number);
            if (Number.isSafeInteger(size) && Number.isSafeInteger(modified))
              metadata.set(id, { size, modified });
          }
        }
      }
    } finally {
      transport.close();
      mask.clear();
    }
    let selected = 0;
    const entries: BackupEntry[] = records.map((record, index) => {
      const info = metadata.get(record.id),
        reason =
          this.protectedReason(record, target, server, latest) ||
          unavailable ||
          (locked ? '目标存在任务锁，不能清理' : '') ||
          (states.get(record.id) === 'MISSING'
            ? '文件已不存在，无法回滚此备份'
            : !info
              ? '文件不可读取或不是普通文件，已保留'
              : info.size !== record.size
                ? '文件大小与记录不同，已保留'
                : '');
      const choose =
        !reason && !!target.backup.keepLast && index >= target.backup.keepLast && selected < 100;
      if (choose) selected++;
      return {
        id: record.id,
        path: record.path,
        size: info?.size || 0,
        time: info ? new Date(info.modified * 1000).toISOString() : '未读取',
        hash: record.hash,
        protectedReason: reason || undefined,
        selected: choose,
      };
    });
    const token = randomUUID(),
      plan: BackupPlan = {
        token,
        targetId,
        environment: target.name,
        production: target.production,
        entries,
        count: metadata.size,
        bytes: [...metadata.values()].reduce((n, i) => n + i.size, 0),
        effects: [
          '只列出本机实际部署任务确认创建的备份，导入历史不作为删除依据。',
          '清理前再次核对文件大小、修改时间和完整指纹，不一致就保留。',
          '清理时临时占用目标任务锁，审计结果保存到本机。',
          '保留数量只用于建议选择，不会后台静默删除；每批最多 100 个文件。',
          ...(records.length === 2000
            ? ['本次最多列出 2000 条未清理记录，完成后可再次查询更早记录。']
            : []),
        ],
      };
    const timer = setTimeout(() => this.cancel(token), 300000);
    timer.unref?.();
    this.frames.set(token, {
      public: plan,
      target,
      server,
      credential,
      directory,
      signature: this.signature(target, server),
      records,
      metadata,
      until: this.now() + 300000,
      timer,
    });
    return structuredClone(plan);
  }
  cancel(token: string) {
    const frame = this.frames.get(token);
    if (frame) {
      frame.credential = '';
      clearTimeout(frame.timer);
    }
    this.frames.delete(token);
  }
  private save(record: MaintenanceRecord, ids: string[] = []) {
    this.storage.recordMaintenance(record, ids);
    this.storage.appendLog(
      record.id,
      record.time +
        ' · ' +
        record.message +
        '\n' +
        record.deleted.map((p) => '已清理或核实不存在：' + p).join('\n') +
        '\n',
    );
    this.onAudit(structuredClone(record));
  }
  async apply(token: string, ids: string[], confirmation: string): Promise<MaintenanceRecord> {
    if (this.busy) throw new Error('正在清理其他备份，请稍后');
    if (this.storage.hasUnreadableTasks())
      throw new Error('有任务记录无法读取，不能确定保护范围，请先检查数据库备份');
    const frame = this.frames.get(token);
    if (!frame || frame.until < this.now()) throw new Error('备份清单已过期，请重新读取');
    const { target, server } = this.context(frame.target.id);
    if (frame.signature !== this.signature(target, server))
      throw new Error('目标、备份或任务状态已变化，请重新读取清单');
    if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length)
      throw new Error('请选择 1–100 个备份文件');
    if (target.production && confirmation !== target.name)
      throw new Error('请输入正式环境名称确认清理位置');
    const selected = ids.map((id) => frame.public.entries.find((e) => e.id === id));
    if (selected.some((e) => !e || e.protectedReason))
      throw new Error('清单含受保护或未知文件，禁止清理');
    const files = selected.map((e) => ({
      ...e!,
      modified: frame.metadata.get(e!.id)!.modified,
      hash: e!.hash!,
    }));
    const audit: MaintenanceRecord = {
      id: 'DC-CLEAN-' + randomUUID(),
      targetId: target.id,
      targetName: target.name,
      serverId: server.id,
      serverName: server.name,
      connection: backupConnection(server),
      directory: frame.directory,
      time: new Date(this.now()).toISOString(),
      taskId: frame.records[0]?.taskId,
      status: 'pending',
      requested: files.map((f) => ({ id: f.id, path: f.path, size: f.size, hash: f.hash })),
      deleted: [],
      message: '已确认清理 ' + files.length + ' 个远程备份，执行结果尚未返回。',
    };
    const transport = this.connect(frame.server, frame.credential),
      mask = new MemoryCredentials({ active: frame.credential });
    this.busy = true;
    try {
      this.save(audit);
      await transport.connect();
      const current = this.context(target.id);
      if (
        this.storage.hasUnreadableTasks() ||
        frame.signature !== this.signature(current.target, current.server)
      )
        throw new Error('任务或配置已变化，清理已停止');
      const result = await transport.exec('bash -s', {
        input: cleanupBackupsScript(frame.target, frame.directory, audit.id, files),
        timeout: 120000 + files.length * 1000,
      });
      const deletedIds = result.stdout
        .split('\n')
        .filter((l) => l.startsWith('DELETED\t'))
        .map((l) => l.split('\t')[1])
        .filter((id) => ids.includes(id));
      audit.deleted = files.filter((f) => deletedIds.includes(f.id)).map((f) => f.path);
      audit.status = result.stdout.includes('FINISHED')
        ? audit.deleted.length === files.length
          ? 'success'
          : audit.deleted.length
            ? 'partial'
            : 'failed'
        : result.stdout.includes('REJECTED:')
          ? 'failed'
          : 'unknown';
      audit.message = mask.redact(
        (audit.status === 'success'
          ? '远程备份清理完成。'
          : audit.status === 'unknown'
            ? '连接结束前未取得完整结果，请只读核实，不要重复删除。'
            : '部分或全部文件未清理，原部署结果不受影响。') +
          '\n' +
          result.stdout +
          result.stderr,
      );
      this.save(audit, deletedIds);
      return structuredClone(audit);
    } catch (e) {
      audit.status = 'unknown';
      audit.message = mask.redact(
        '清理结果待核实：' + String(e) + '。未取得完整结果，不会改变已完成的部署结果。',
      );
      this.save(audit);
      return structuredClone(audit);
    } finally {
      transport.close();
      mask.clear();
      this.cancel(token);
      this.busy = false;
    }
  }
  async reconcile(auditId: string, credential: string): Promise<MaintenanceRecord> {
    if (this.busy) throw new Error('请等待备份操作结束');
    const audit = this.storage.remoteBackups.audits().find((r) => r.id === auditId);
    if (!audit) throw new Error('清理记录不存在');
    const { server } = this.context(audit.targetId);
    if (backupConnection(server) !== audit.connection)
      throw new Error('服务器连接配置已变化，不能核实旧服务器文件');
    if (audit.requested.some((e) => !regularName(audit.directory, e.path)))
      throw new Error('原清单范围异常，未发起读取');
    const transport = this.connect(server, credential),
      mask = new MemoryCredentials({ active: credential });
    this.busy = true;
    try {
      await transport.connect();
      const result = await transport.exec('bash -s', {
        input: inspectBackupsScript(audit.directory, audit.requested),
        timeout: 120000,
      });
      const missing = new Set(
        result.stdout
          .split('\n')
          .filter((l) => l.endsWith('\tMISSING'))
          .map((l) => l.split('\t')[0]),
      );
      const remaining = audit.requested.filter((e) => !missing.has(e.id));
      const known =
        result.code === 0 &&
        !/BASE_UNAVAILABLE|BASE_LINK/.test(result.stdout) &&
        remaining.every((e) =>
          result.stdout.split('\n').some((l) => l.startsWith(e.id + '\tFILE\t')),
        );
      audit.deleted = audit.requested.filter((e) => missing.has(e.id)).map((e) => e.path);
      audit.status = known
        ? !remaining.length
          ? 'success'
          : missing.size
            ? 'partial'
            : 'failed'
        : 'unknown';
      audit.message = mask.redact(
        '只读核实：' +
          missing.size +
          ' 个原路径已不存在，' +
          remaining.length +
          ' 个仍存在或需检查；未再次删除远程文件。\n' +
          result.stderr,
      );
      this.save(audit, [...missing]);
      return structuredClone(audit);
    } catch (e) {
      throw new Error(mask.redact(String(e)));
    } finally {
      transport.close();
      mask.clear();
      this.busy = false;
    }
  }
  close() {
    for (const token of this.frames.keys()) this.cancel(token);
  }
}
