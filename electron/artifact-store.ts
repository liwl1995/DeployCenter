import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Sqlite from 'better-sqlite3';
import type { ArtifactPolicy, Task } from '../src/model';
import type {
  CleanupKind,
  CleanupPlan,
  CleanupResult,
  DataUsage,
  SnapshotAvailability,
} from '../src/features';
import { managedPath, snapshotPath } from './managed-path';
import { fileHash, type SnapshotSource } from './files';
import { parseTaskRecord } from './task-record';

export const defaultArtifactPolicy: ArtifactPolicy = {
  mode: 'success',
  maxCount: 5,
  maxGB: 1,
  failedDays: 7,
};
export function artifactPolicy(value?: ArtifactPolicy): ArtifactPolicy {
  const p = { ...defaultArtifactPolicy, ...value };
  if (
    !['success', 'count', 'size'].includes(p.mode) ||
    !Number.isInteger(p.maxCount) ||
    p.maxCount < 1 ||
    p.maxCount > 10000 ||
    !Number.isFinite(p.maxGB) ||
    p.maxGB <= 0 ||
    p.maxGB > 1024 ||
    !Number.isInteger(p.failedDays) ||
    p.failedDays < 1 ||
    p.failedDays > 3650
  )
    throw new Error('产物保留设置无效');
  return p;
}
type ObjectRow = {
  path: string;
  hash: string;
  size: number;
  used: number;
  legacy: number;
  approved: number;
};
type InternalPlan = {
  merges: { from: string; to: string; hash: string }[];
  public: CleanupPlan;
  paths: string[];
  until: number;
  signature: string;
};
const protectedTask = (task: Task) =>
  ['running', 'cancelling', 'interrupted'].includes(task.status);
const succeeded = (task: Task) =>
  !protectedTask(task) &&
  task.targets.length > 0 &&
  task.targets.every((r) => ['success', 'unverified'].includes(r.status));
const taskName = /^DC-[a-zA-Z0-9-]+$/;

/** 文件是内容寻址的，引用单独保存；清理时始终重新读取任务状态，不能凭预览结果删除。 */
export class ArtifactStore {
  private plans = new Map<string, InternalPlan>();
  private busy = false;
  private paused = false;
  private unreadable = new Set<string>();
  setPaused(value: boolean) {
    this.paused = value;
  }
  constructor(
    readonly dir: string,
    private sql: () => Sqlite.Database,
    private policy: () => ArtifactPolicy | undefined,
    private now: () => number = Date.now,
  ) {}
  static initialize(sql: Sqlite.Database) {
    sql.exec(
      'CREATE TABLE IF NOT EXISTS artifact_objects (path TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL, used INTEGER NOT NULL, legacy INTEGER NOT NULL, approved INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS artifact_refs (task_id TEXT PRIMARY KEY, path TEXT NOT NULL); CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
    );
  }
  isBusy() {
    return this.busy;
  }
  private retentionTime(task: Task, object: ObjectRow) {
    const reviewed = this.sql()
      .prepare("SELECT value FROM app_meta WHERE key='legacy-reviewed'")
      .get() as { value: string } | undefined;
    return Math.max(task.endedAt || this.now(), object.legacy ? Number(reviewed?.value || 0) : 0);
  }
  private tasks(): Task[] {
    const tasks: Task[] = [];
    this.unreadable.clear();
    for (const row of this.sql().prepare('SELECT id,json FROM tasks').all() as {
      id: string;
      json: string;
    }[])
      try {
        tasks.push(parseTaskRecord(row.json, row.id));
      } catch {
        this.unreadable.add(row.id);
      }
    return tasks;
  }
  register(task: Task) {
    const a = task.artifact;
    if (
      task.dryRun ||
      task.operation === 'rollback' ||
      !a.sha256 ||
      !/^[a-f0-9]{64}$/.test(a.sha256) ||
      a.snapshotRemoved
    )
      return;
    try {
      const file = snapshotPath(this.dir, a.path),
        stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size !== a.size) return;
      const legacy = path.basename(path.dirname(file)) !== 'sha256' ? 1 : 0;
      this.sql()
        .prepare(
          'INSERT INTO artifact_objects VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET used=MAX(used,excluded.used)',
        )
        .run(file, a.sha256, a.size, task.startedAt || this.now(), legacy, legacy ? 0 : 1);
      this.sql()
        .prepare(
          'INSERT INTO artifact_refs VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET path=excluded.path',
        )
        .run(task.id, file);
    } catch {
      /* 非本工具管理的路径只用于历史展示，绝不取得删除权限。 */
    }
  }
  scan() {
    for (const task of this.tasks()) this.register(task);
  }
  sources(): SnapshotSource[] {
    return this.objects()
      .filter((o) => {
        try {
          return fs.lstatSync(snapshotPath(this.dir, o.path)).isFile();
        } catch {
          return false;
        }
      })
      .map((o) => ({ path: o.path, hash: o.hash, size: o.size }));
  }
  private objects(): ObjectRow[] {
    return this.sql()
      .prepare('SELECT * FROM artifact_objects ORDER BY used DESC,path')
      .all() as ObjectRow[];
  }
  private refs(file: string, tasks: Task[]) {
    const ids = new Set(
      (
        this.sql().prepare('SELECT task_id FROM artifact_refs WHERE path=?').all(file) as {
          task_id: string;
        }[]
      ).map((r) => r.task_id),
    );
    const object = this.objects().find((o) => o.path === file);
    // 工作进程可能在发布快照后、回传新路径前崩溃；按已知指纹保护，无法确认时保守保护全部。
    return tasks.filter(
      (t) =>
        ids.has(t.id) ||
        (protectedTask(t) &&
          !t.dryRun &&
          t.operation === 'deploy' &&
          (!t.artifact.sha256 || t.artifact.sha256 === object?.hash || t.artifact.path === file)),
    );
  }
  private resolved(task: Task, tasks: Task[]) {
    if (succeeded(task)) return true;
    if (protectedTask(task)) return false;
    const failedIds = task.targets
      .filter((r) => !['success', 'unverified'].includes(r.status))
      .map((r) => r.target.id);
    // 多次分别重试也可释放原任务引用；原任务的真实失败结果保持不变。
    return (
      failedIds.length > 0 &&
      failedIds.every((id) =>
        tasks.some(
          (t) => t.retryOf === task.id && succeeded(t) && t.targets.some((r) => r.target.id === id),
        ),
      )
    );
  }
  availability(taskId: string): SnapshotAvailability {
    const task = this.tasks().find((t) => t.id === taskId);
    if (!task || task.operation === 'rollback' || task.dryRun)
      return { available: false, reason: '此任务没有本地部署产物，请重新构建或选择现有 JAR。' };
    try {
      const file = snapshotPath(this.dir, task.artifact.path),
        item = fs.lstatSync(file);
      if (
        !task.artifact.snapshotRemoved &&
        item.isFile() &&
        item.size === task.artifact.size &&
        this.refs(file, [task]).length
      )
        return { available: true, reason: '', path: file };
    } catch {}
    return {
      available: false,
      reason:
        '本地固定产物已清理或无法读取，不能直接只重试失败目标。请重新构建，或选择现有 JAR 后重新部署；远程备份回滚不受影响。',
    };
  }
  private signature() {
    return JSON.stringify([this.tasks(), this.objects(), this.policy(), [...this.unreadable]]);
  }
  private calculate(kind: CleanupKind, policy = artifactPolicy(this.policy())) {
    const tasks = this.tasks(),
      objects = this.objects(),
      selected: string[] = [],
      warnings: string[] = [];
    let protectedCount = 0;
    if (this.unreadable.size)
      return {
        selected,
        protectedCount: objects.length,
        warnings: ['有任务元数据无法读取，尚不能确定共享引用关系，产物已全部保留。'],
      };
    const distinct = new Set<string>(),
      retained = new Set<string>();
    let keptBytes = 0;
    // 限额按内容计数；受保护引用始终优先，即使因此超过用户设定上限。
    for (const o of objects) {
      const refs = this.refs(o.path, tasks);
      const isProtected =
        refs.some(protectedTask) ||
        refs.some(
          (t) =>
            !this.resolved(t, tasks) &&
            (!t.endedAt || this.now() - this.retentionTime(t, o) < policy.failedDays * 86400000),
        );
      if (isProtected && !distinct.has(o.hash)) {
        distinct.add(o.hash);
        retained.add(o.hash);
        keptBytes += o.size;
      }
    }
    for (const o of objects) {
      const refs = this.refs(o.path, tasks);
      if (refs.some(protectedTask)) {
        protectedCount++;
        continue;
      }
      if (kind === 'legacy-success') {
        if (o.legacy && !o.approved && refs.length > 0 && refs.every((t) => succeeded(t)))
          selected.push(o.path);
        continue;
      }
      if (kind !== 'artifacts' && !o.approved) continue;
      if (kind === 'artifacts') {
        selected.push(o.path);
        continue;
      }
      if (!refs.length) {
        selected.push(o.path);
        continue;
      }
      if (
        refs.some(
          (t) =>
            !this.resolved(t, tasks) &&
            (!t.endedAt || this.now() - this.retentionTime(t, o) < policy.failedDays * 86400000),
        )
      ) {
        protectedCount++;
        continue;
      }
      if (policy.mode === 'success') {
        selected.push(o.path);
        continue;
      }
      if (retained.has(o.hash)) continue;
      const fits =
        policy.mode === 'count'
          ? distinct.size < policy.maxCount
          : keptBytes + o.size <= policy.maxGB * 1024 ** 3;
      if (fits) {
        distinct.add(o.hash);
        retained.add(o.hash);
        keptBytes += o.size;
      } else selected.push(o.path);
    }
    return { selected, protectedCount, warnings };
  }
  preview(kind: CleanupKind, value?: ArtifactPolicy): CleanupPlan {
    const policy = artifactPolicy(value || this.policy());
    const result =
      kind === 'temporary' ? this.temporaryCandidates(false) : this.calculate(kind, policy);
    const objects = this.objects(),
      tasks = this.tasks(),
      merges: InternalPlan['merges'] = [];
    // 已确认的旧副本仅在保护期结束后合并；仍保留同一内容，任务引用一起转移，不损失重试能力。
    if (kind === 'policy' && !this.unreadable.size) {
      const byHash = new Map<string, ObjectRow>();
      for (const object of objects) {
        if (!object.approved || result.selected.includes(object.path)) continue;
        const refs = this.refs(object.path, tasks);
        if (
          refs.some(protectedTask) ||
          refs.some(
            (t) =>
              !this.resolved(t, tasks) &&
              (!t.endedAt ||
                this.now() - this.retentionTime(t, object) < policy.failedDays * 86400000),
          )
        )
          continue;
        const kept = byHash.get(object.hash);
        if (kept && kept.size === object.size) {
          merges.push({ from: object.path, to: kept.path, hash: object.hash });
          result.selected.push(object.path);
        } else byHash.set(object.hash, object);
      }
      if (merges.length)
        result.warnings.push(
          '其中 ' + merges.length + ' 份为内容相同的旧副本，将合并为共享文件，相关任务仍可重试。',
        );
    }
    if (
      tasks.some(
        (t) => protectedTask(t) && !t.dryRun && t.operation === 'deploy' && !t.artifact.sha256,
      )
    )
      result.warnings.push('有中断或活动任务的产物归属尚未确认，相关内容暂时全部保留。');
    const plan: CleanupPlan = {
      token: randomUUID(),
      kind,
      bytes: 0,
      files: 0,
      tasks: [],
      protected: result.protectedCount,
      warnings: result.warnings,
      policy: kind === 'policy' ? policy : undefined,
    };
    const safe: string[] = [];
    for (const file of result.selected) {
      try {
        if (kind === 'temporary') managedPath(this.dir, 'tmp', file);
        else snapshotPath(this.dir, file);
        const stat = fs.lstatSync(file);
        if (!stat.isFile()) throw new Error('不是普通文件');
        plan.bytes += stat.size;
        plan.files++;
        safe.push(file);
        if (kind !== 'temporary' && !merges.some((m) => m.from === file))
          for (const t of this.refs(file, tasks))
            if (!plan.tasks.includes(t.id)) plan.tasks.push(t.id);
      } catch (error) {
        plan.warnings.push(
          '已保留无法安全读取的文件：' + path.basename(file) + '，' + String(error),
        );
      }
    }
    if (objects.some((o) => !o.approved) && kind === 'policy')
      plan.warnings.push('旧版产物需先单独确认，未包含在自动清理范围中。');
    this.plans.set(plan.token, {
      merges,
      public: plan,
      paths: safe,
      until: this.now() + 300000,
      signature: this.signature(),
    });
    for (const [id, p] of this.plans) if (p.until < this.now()) this.plans.delete(id);
    return plan;
  }
  async apply(token: string, confirmed: boolean): Promise<CleanupResult> {
    if (this.paused) throw new Error('数据目录正在切换或应用正在退出，不能清理');
    if (!confirmed) throw new Error('请先确认清理内容及影响');
    const plan = this.plans.get(token);
    if (!plan || plan.until < this.now()) throw new Error('清理预览已过期，请重新预览');
    if (this.busy) throw new Error('正在清理，请稍后重试');
    if (plan.signature !== this.signature())
      throw new Error('任务或保留设置已变化，请重新预览清理范围');
    if (this.tasks().some((t) => ['running', 'cancelling'].includes(t.status)))
      throw new Error('有任务正在执行，结束后才能清理');
    if (this.unreadable.size && plan.public.kind !== 'temporary')
      throw new Error('有任务记录无法读取，产物已保留，请先检查数据库备份。');
    this.plans.delete(token);
    this.busy = true;
    const result: CleanupResult = { bytes: 0, files: 0, warnings: [], policy: plan.public.policy };
    try {
      for (const file of plan.paths) {
        try {
          if (plan.public.kind === 'temporary') managedPath(this.dir, 'tmp', file);
          else {
            snapshotPath(this.dir, file);
            const object = this.objects().find((o) => o.path === file);
            if (!object || this.refs(file, this.tasks()).some(protectedTask))
              throw new Error('文件仍受任务保护');
            if ((await fileHash(file)) !== object.hash)
              throw new Error('文件内容与记录不一致，已保留');
          }
          const merge = plan.merges.find((m) => m.from === file);
          if (merge) {
            snapshotPath(this.dir, merge.to);
            if ((await fileHash(merge.to)) !== merge.hash)
              throw new Error('共享副本校验失败，保留原文件');
          }
          if (this.paused) throw new Error('应用退出或目录切换，保留文件下次处理');
          // 哈希计算期间任务可能开始，必须在最终 unlink 前再次检查。
          if (this.tasks().some((t) => ['running', 'cancelling'].includes(t.status)))
            throw new Error('任务已开始，停止清理');
          if (this.unreadable.size && plan.public.kind !== 'temporary')
            throw new Error('任务元数据无法读取，文件已保留');
          if (plan.public.kind === 'temporary') managedPath(this.dir, 'tmp', file);
          else snapshotPath(this.dir, file);
          if (plan.public.kind !== 'temporary' && this.refs(file, this.tasks()).some(protectedTask))
            throw new Error('任务状态变化，文件已保留');
          if (plan.public.kind === 'temporary') {
            const owner = path.relative(path.join(this.dir, 'tmp'), file).split(path.sep)[0];
            if (
              this.tasks().some(
                (t) => protectedTask(t) && (t.id === owner || !taskName.test(owner)),
              )
            )
              throw new Error('临时文件仍受任务保护');
          }
          if (merge) {
            snapshotPath(this.dir, merge.to);
            const taskRows = this.tasks();
            if (this.unreadable.size || this.refs(file, taskRows).some(protectedTask))
              throw new Error('任务状态已变化，保留原副本');
            this.sql().transaction(() => {
              for (const task of taskRows.filter((t) => t.artifact.path === file)) {
                task.artifact.path = merge.to;
                task.artifact.snapshotId = merge.hash;
                this.sql()
                  .prepare('UPDATE tasks SET json=? WHERE id=?')
                  .run(JSON.stringify(task), task.id);
              }
              this.sql()
                .prepare('UPDATE artifact_refs SET path=? WHERE path=?')
                .run(merge.to, file);
              this.sql()
                .prepare(
                  'UPDATE artifact_objects SET used=MAX(used,(SELECT used FROM artifact_objects WHERE path=?)) WHERE path=?',
                )
                .run(file, merge.to);
            })();
            // 若退出发生在引用转移之后，原对象仍在表中，下次按无引用文件安全回收。
          }
          const size = fs.lstatSync(file).size;
          fs.unlinkSync(file);
          result.bytes += size;
          result.files++;
          if (plan.public.kind !== 'temporary') this.markRemoved(file);
          this.removeEmptyParents(
            path.dirname(file),
            plan.public.kind === 'temporary' ? 'tmp' : 'artifacts',
          );
        } catch (error) {
          result.warnings.push(path.basename(file) + '：' + String(error));
        }
      }
      if (plan.public.kind === 'legacy-success') {
        // 未成功/中断的旧文件依然保留；用户确认后的失败产物从本次升级起获得完整保留窗口。
        this.sql()
          .prepare(
            "INSERT INTO app_meta VALUES ('legacy-reviewed',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(String(this.now()));
        this.sql().prepare('UPDATE artifact_objects SET approved=1 WHERE legacy=1').run();
      }
      return result;
    } finally {
      this.busy = false;
    }
  }
  private markRemoved(file: string) {
    const tasks = this.refs(file, this.tasks());
    this.sql().transaction(() => {
      for (const task of tasks) {
        task.artifact.snapshotRemoved = true;
        this.sql().prepare('UPDATE tasks SET json=? WHERE id=?').run(JSON.stringify(task), task.id);
      }
      this.sql().prepare('DELETE FROM artifact_refs WHERE path=?').run(file);
      this.sql().prepare('DELETE FROM artifact_objects WHERE path=?').run(file);
    })();
  }
  private removeEmptyParents(dir: string, folder: 'artifacts' | 'tmp') {
    const base = path.join(this.dir, folder);
    while (dir !== base) {
      try {
        managedPath(this.dir, folder, dir);
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
      } catch {
        break;
      }
    }
  }
  forget(taskId: string) {
    this.sql().prepare('DELETE FROM artifact_refs WHERE task_id=?').run(taskId);
  }
  private temporaryCandidates(stale: boolean, onlyTask?: string) {
    const selected: string[] = [],
      warnings: string[] = [],
      tasks = this.tasks();
    let protectedCount = 0;
    const root = path.join(this.dir, 'tmp');
    if (!fs.existsSync(root)) return { selected, warnings, protectedCount };
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const owned = taskName.test(entry.name) || /^build-command-[a-zA-Z0-9_-]+$/.test(entry.name);
      if (!owned || (onlyTask && entry.name !== onlyTask)) {
        if (!onlyTask) warnings.push('保留无法确认归属的临时内容：' + entry.name);
        continue;
      }
      const owner = tasks.find((t) => t.id === entry.name);
      if (
        this.unreadable.has(entry.name) ||
        (owner && protectedTask(owner)) ||
        (!owner && (tasks.some(protectedTask) || this.unreadable.size > 0))
      ) {
        protectedCount++;
        continue;
      }
      const walk = (dir: string) => {
        try {
          managedPath(this.dir, 'tmp', dir);
          const item = fs.lstatSync(dir);
          if (item.isSymbolicLink()) throw new Error('链接不能清理');
          if (item.isDirectory())
            for (const name of fs.readdirSync(dir)) walk(path.join(dir, name));
          else if (item.isFile() && (!stale || this.now() - item.mtimeMs > 86400000))
            selected.push(dir);
        } catch (error) {
          warnings.push('临时内容已保留：' + path.basename(dir) + '，' + String(error));
        }
      };
      walk(path.join(root, entry.name));
    }
    return { selected, warnings, protectedCount };
  }
  async cleanTemporary(stale: boolean, taskId?: string) {
    if (this.paused) return [];
    const result = this.temporaryCandidates(stale, taskId),
      warnings = [...result.warnings];
    for (const file of result.selected)
      try {
        const owner = path.relative(path.join(this.dir, 'tmp'), file).split(path.sep)[0];
        if (this.tasks().some((t) => t.id === owner && protectedTask(t))) continue;
        managedPath(this.dir, 'tmp', file);
        fs.unlinkSync(file);
        this.removeEmptyParents(path.dirname(file), 'tmp');
      } catch (error) {
        warnings.push('临时文件稍后重试清理：' + path.basename(file) + '，' + String(error));
      }
    return warnings;
  }
  async automatic() {
    if (
      this.paused ||
      this.busy ||
      this.tasks().some((t) => ['running', 'cancelling'].includes(t.status))
    )
      return;
    const plan = this.preview('policy');
    if (plan.files) await this.apply(plan.token, true);
  }
  usage(): DataUsage {
    const value: DataUsage = {
      database: 0,
      logs: 0,
      artifacts: 0,
      temporary: 0,
      backups: 0,
      other: 0,
      total: 0,
      legacy: { pending: false, bytes: 0, successBytes: 0, warnings: [] },
    };
    this.tasks();
    if (this.unreadable.size)
      value.legacy.warnings.push(
        '任务元数据无法读取，相关产物已保留：' + [...this.unreadable].join('、'),
      );
    const known = new Set(this.objects().map((o) => o.path));
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name),
          stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) {
          value.legacy.warnings.push(
            '已保留链接，未统计其指向内容：' + path.relative(this.dir, file),
          );
          continue;
        }
        if (stat.isDirectory()) {
          walk(file);
          continue;
        }
        if (!stat.isFile()) continue;
        const relative = path.relative(this.dir, file),
          top = relative.split(path.sep)[0];
        const key =
          top === 'logs'
            ? 'logs'
            : top === 'artifacts'
              ? 'artifacts'
              : top === 'tmp'
                ? 'temporary'
                : top === 'backups'
                  ? 'backups'
                  : /^deploy-center\.sqlite(?:-wal|-shm)?$/.test(relative)
                    ? 'database'
                    : 'other';
        value[key] += stat.size;
        value.total += stat.size;
        if (top === 'artifacts' && !known.has(file)) {
          value.legacy.bytes += stat.size;
          value.legacy.warnings.push('产物元数据缺失或目录异常，已保留：' + relative);
        }
      }
    };
    walk(this.dir);
    const tasks = this.tasks(),
      reviewed = !!this.sql()
        .prepare("SELECT value FROM app_meta WHERE key='legacy-reviewed'")
        .get();
    for (const o of this.objects().filter((o) => o.legacy && !o.approved)) {
      value.legacy.bytes += fs.existsSync(o.path) ? o.size : 0;
      const refs = this.refs(o.path, tasks);
      if (refs.length && refs.every(succeeded)) value.legacy.successBytes += o.size;
    }
    value.legacy.pending =
      !reviewed && (value.legacy.bytes > 0 || value.legacy.warnings.length > 0);
    return value;
  }
}
