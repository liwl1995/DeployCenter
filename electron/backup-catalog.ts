import { createHash } from 'node:crypto';
import path from 'node:path';
import type Sqlite from 'better-sqlite3';
import type { Server, Task } from '../src/model';
import type { RemoteBackupRecord, MaintenanceRecord } from '../src/features';
/** 凭据内容与本机密钥路径不属于远端身份；目录迁移不会改变同一远端记录的归属。 */
export const backupConnection = (s: Pick<Server, 'auth' | 'alias' | 'host' | 'user' | 'port'>) =>
  createHash('sha256')
    .update(JSON.stringify([s.auth, s.alias, s.host, s.user, s.port]))
    .digest('hex');
const backupId = (connection: string, file: string) =>
  createHash('sha256')
    .update(connection + '\0' + file)
    .digest('hex');
export class RemoteBackupCatalog {
  readonly issues: string[] = [];
  private read<T>(raw: string): T | undefined {
    try {
      const value = JSON.parse(raw);
      if (
        !value ||
        !['id', 'targetId', 'targetName', 'serverId', 'serverName', 'connection'].every(
          (key) => typeof value[key] === 'string',
        )
      )
        throw new Error();
      if ('requested' in value) {
        if (
          !['pending', 'success', 'partial', 'failed', 'unknown'].includes(value.status) ||
          typeof value.message !== 'string' ||
          typeof value.directory !== 'string' ||
          !Number.isFinite(Date.parse(value.time)) ||
          !Array.isArray(value.requested) ||
          !value.requested.every(
            (r: any) =>
              r &&
              typeof r.id === 'string' &&
              typeof r.path === 'string' &&
              Number.isSafeInteger(r.size) &&
              r.size > 0,
          ) ||
          !Array.isArray(value.deleted) ||
          !value.deleted.every((s: unknown) => typeof s === 'string')
        )
          throw new Error();
      } else if (
        typeof value.path !== 'string' ||
        typeof value.taskId !== 'string' ||
        !Number.isSafeInteger(value.size) ||
        value.size <= 0 ||
        !Number.isFinite(value.createdAt)
      )
        throw new Error();
      return value;
    } catch {
      if (!this.issues.length)
        this.issues.push('部分备份来源或清理记录无法读取，已保留原数据，不作为删除依据。');
      return undefined;
    }
  }
  constructor(
    private sql: () => Sqlite.Database,
    private now: () => number = Date.now,
  ) {}
  static initialize(sql: Sqlite.Database) {
    sql.exec(
      'CREATE TABLE IF NOT EXISTS remote_backups (id TEXT PRIMARY KEY, json TEXT NOT NULL, seq INTEGER NOT NULL, removed INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS maintenance_events (id TEXT PRIMARY KEY, target_id TEXT NOT NULL, task_id TEXT, at INTEGER NOT NULL, json TEXT NOT NULL);',
    );
  }
  register(task: Task, bootstrap = false) {
    if (task.dryRun) return;
    for (const run of task.targets) {
      if (
        !run.backupCreated ||
        run.backupRemoved ||
        !run.backupPath ||
        !run.backupSize ||
        /[\r\n\0]/.test(run.backupPath) ||
        !run.backupPath.startsWith('/') ||
        path.posix.normalize(run.backupPath) !== path.posix.normalize(run.plannedBackupPath)
      )
        continue;
      const connection = backupConnection(run.server),
        file = path.posix.normalize(run.backupPath),
        id = backupId(connection, file);
      const old = this.sql()
        .prepare('SELECT json,seq,removed FROM remote_backups WHERE id=?')
        .get(id) as { json: string; seq: number; removed: number } | undefined;
      const parsed = old ? this.read<RemoteBackupRecord>(old.json) : undefined;
      if (old && !parsed) continue;
      const previous =
        parsed && old ? { ...parsed, removed: !!old.removed, seq: old.seq } : undefined;
      if (
        previous?.taskId === task.id ||
        (bootstrap && previous && previous.createdAt >= (run.backupCreatedAt || task.startedAt))
      )
        continue;
      const seq = Number(
        (
          this.sql()
            .prepare('SELECT COALESCE(MAX(seq),0)+1 AS value FROM remote_backups')
            .get() as { value: number }
        ).value,
      );
      const record: RemoteBackupRecord = {
        id,
        connection,
        targetId: run.target.id,
        targetName: run.target.name,
        serverId: run.server.id,
        serverName: run.server.name,
        path: file,
        hash: run.backupHash,
        size: run.backupSize,
        createdAt: bootstrap ? run.backupCreatedAt || task.startedAt : this.now(),
        taskId: task.id,
        seq,
        removed: false,
      };
      this.sql()
        .prepare(
          'INSERT INTO remote_backups VALUES (?,?,?,0) ON CONFLICT(id) DO UPDATE SET json=excluded.json,seq=excluded.seq,removed=0',
        )
        .run(id, JSON.stringify(record), seq);
    }
  }
  records(targetId?: string): RemoteBackupRecord[] {
    return (
      this.sql().prepare('SELECT json,seq,removed FROM remote_backups ORDER BY seq DESC').all() as {
        json: string;
        seq: number;
        removed: number;
      }[]
    )
      .flatMap((row) => {
        const r = this.read<RemoteBackupRecord>(row.json);
        return r ? [{ ...r, seq: row.seq, removed: !!row.removed }] : [];
      })
      .filter((r) => !targetId || r.targetId === targetId);
  }
  removed(ids: string[]) {
    for (const id of ids)
      this.sql().prepare('UPDATE remote_backups SET removed=1 WHERE id=?').run(id);
  }
  saveAudit(record: MaintenanceRecord) {
    this.sql()
      .prepare(
        'INSERT INTO maintenance_events VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json',
      )
      .run(
        record.id,
        record.targetId,
        record.taskId || null,
        Date.parse(record.time),
        JSON.stringify(record),
      );
  }
  audits(targetId?: string): MaintenanceRecord[] {
    return (
      targetId
        ? this.sql()
            .prepare('SELECT json FROM maintenance_events WHERE target_id=? ORDER BY at DESC')
            .all(targetId)
        : (this.sql().prepare('SELECT json FROM maintenance_events ORDER BY at DESC').all() as {
            json: string;
          }[])
    ).flatMap((row: any) => {
      const r = this.read<MaintenanceRecord>(row.json);
      return r ? [r] : [];
    });
  }
}
