import Sqlite from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import {
  safeConfigJson,
  validDatabase,
  type Database,
  type Recovery,
  type Task,
} from '../src/model';
import { recordTask, pruneHistory } from '../src/records';
import type { Pin } from './contracts';
import type { TaskSummary } from '../src/platform';
import { summarizeTask, importedSummaries } from '../src/history-model';
import { emptyDatabase } from '../src/defaults';
import { ArtifactStore, artifactPolicy } from './artifact-store';
import type { LogContext } from '../src/features';
import { plainPath } from './managed-path';
import { parseTaskRecord } from './task-record';
import { backupConnection, RemoteBackupCatalog } from './backup-catalog';
import type { Receipt } from './workbench';
import type { MaintenanceRecord } from '../src/features';

export type Cryptography = {
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
};
export const databaseVersion = 5;
export const productionSeed = emptyDatabase;
export class Storage {
  private sql!: Sqlite.Database;
  private state: Database;
  recovery?: Recovery;
  readonly dataDir: string;
  readonly artifacts: ArtifactStore;
  readonly remoteBackups: RemoteBackupCatalog;
  private maintenance: Promise<void> = Promise.resolve();
  maintenanceWarnings: string[] = [];
  taskIssues: { id: string; message: string }[] = [];
  allTasks() {
    const tasks: Task[] = [];
    this.taskIssues = [];
    for (const row of this.sql.prepare('SELECT id,json FROM tasks ORDER BY updated DESC').all() as {
      id: string;
      json: string;
    }[])
      try {
        tasks.push(parseTaskRecord(row.json, row.id));
      } catch {
        this.taskIssues.push({
          id: row.id,
          message: '原始任务记录无法读取，已保留；请检查或恢复数据库备份。',
        });
      }
    return tasks;
  }
  hasUnreadableTasks() {
    this.allTasks();
    return this.taskIssues.length > 0;
  }
  constructor(
    dir: string,
    private crypto: Cryptography,
    clock: () => number = Date.now,
  ) {
    this.dataDir = path.resolve(dir);
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dataDir, 'deploy-center.sqlite');
    try {
      this.sql = new Sqlite(file);
      const version = Number(
        (this.sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      );
      if (version > databaseVersion) throw new Error('数据库由更新版本创建，请升级应用');
      this.sql.pragma('journal_mode = WAL');
      this.sql.pragma('synchronous = FULL');
      this.sql.pragma('busy_timeout = 5000');
      if (version < databaseVersion) {
        // 迁移在事务内执行；原数据库先 checkpoint 并备份，失败不替换原文件。
        if (fs.statSync(file).size > 0) this.backup();
        this.sql.transaction(() => {
          this.sql.exec(
            'CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated INTEGER NOT NULL, active INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, encrypted BLOB NOT NULL); CREATE TABLE IF NOT EXISTS pins (endpoint TEXT PRIMARY KEY, key TEXT NOT NULL, fingerprint TEXT NOT NULL); CREATE TABLE IF NOT EXISTS recoveries (id TEXT PRIMARY KEY, raw TEXT NOT NULL);',
          );
          ArtifactStore.initialize(this.sql);
          RemoteBackupCatalog.initialize(this.sql);
          this.sql.exec(
            'CREATE TABLE IF NOT EXISTS workbench_receipts (scope TEXT NOT NULL, owner TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (scope,owner));',
          );
          this.sql.pragma('user_version = ' + databaseVersion);
        })();
      }
    } catch (e) {
      try {
        this.sql?.close();
      } catch {}
      throw new Error('无法打开本地数据库，原文件已保留：' + String(e));
    }
    const raw = (
      this.sql.prepare('SELECT json FROM config WHERE id=1').get() as { json: string } | undefined
    )?.json;
    if (!raw) {
      this.state = productionSeed();
      this.writeState();
    } else {
      try {
        const value = JSON.parse(raw);
        if (!validDatabase(value)) throw new Error('配置字段或版本无效');
        this.state = value;
        this.state.settings.demoMode = false;
      } catch {
        const key = 'config-backup-' + Date.now();
        this.sql.prepare('INSERT INTO recoveries VALUES (?,?)').run(key, raw);
        this.recovery = { raw, backupKey: key };
        this.state = productionSeed();
      }
    }
    this.artifacts = new ArtifactStore(
      this.dataDir,
      () => this.sql,
      () => this.state.settings.artifactPolicy,
      clock,
    );
    this.artifacts.scan();
    this.remoteBackups = new RemoteBackupCatalog(() => this.sql, clock);
    for (const task of this.allTasks().reverse()) this.remoteBackups.register(task, true);
  }
  async maintainStartup() {
    this.maintenanceWarnings.push(...(await this.artifacts.cleanTemporary(true)));
    await this.artifacts.automatic();
  }
  async settle() {
    await this.maintenance;
  }
  private scheduleMaintenance(taskId?: string) {
    this.maintenance = this.maintenance
      .then(async () => {
        if (taskId)
          this.maintenanceWarnings.push(...(await this.artifacts.cleanTemporary(false, taskId)));
        await this.artifacts.automatic();
      })
      .catch((error) => {
        this.maintenanceWarnings.push('清理稍后重试：' + String(error));
      });
  }
  applyArtifactPolicy(value: import('../src/model').ArtifactPolicy) {
    this.state.settings.artifactPolicy = artifactPolicy(value);
    this.writeState();
  }
  database() {
    return structuredClone(this.state);
  }
  private writeState() {
    if (!this.recovery)
      this.sql
        .prepare('INSERT INTO config VALUES (1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json')
        .run(safeConfigJson(this.state));
  }
  confirmRecovery() {
    this.recovery = undefined;
    this.writeState();
  }
  saveConfig(incoming: Database) {
    if (this.recovery) throw new Error('请先下载原始配置并确认恢复');
    if (!validDatabase(incoming)) throw new Error('配置格式无效');
    const next = structuredClone(incoming);
    // 执行结果只由主进程写入，避免界面的延迟自动保存覆盖刚完成的版本和历史。
    next.history = this.state.history;
    next.taskHistory = this.state.taskHistory;
    next.settings.demoMode = false;
    // 产物策略只能通过带预览和确认的专用入口改变。
    next.settings.artifactPolicy = this.state.settings.artifactPolicy;
    next.targets = next.targets.map((t) => {
      const old = this.state.targets.find((x) => x.id === t.id);
      return old
        ? {
            ...t,
            version: old.version,
            lastDeploy: old.lastDeploy,
            healthState: old.healthState,
            currentHash: old.currentHash,
            currentCommit: old.currentCommit,
          }
        : t;
    });
    this.dropChangedCredentials(next.servers);
    this.state = pruneHistory(next);
    this.applyRetention();
    this.writeState();
    this.scheduleMaintenance();
    for (const id of this.credentialIds())
      if (!next.servers.some((s) => s.id === id && s.credentialMode === 'windows'))
        this.deleteCredential(id);
  }
  importDatabase(value: Database, includeHistory: boolean) {
    if (!validDatabase(value)) throw new Error('导入配置无效');
    this.backup();
    const state = JSON.parse(safeConfigJson(value)) as Database;
    state.settings.demoMode = false;
    const merge = <T extends { id: string }>(old: T[], incoming: T[]) => [
      ...old.filter((x) => !incoming.some((y) => y.id === x.id)),
      ...incoming,
    ];
    state.services = merge(this.state.services, state.services);
    state.servers = merge(this.state.servers, state.servers);
    state.targets = merge(this.state.targets, state.targets);
    state.jdks = [
      ...this.state.jdks.filter((x) => !state.jdks.some((y) => y.name === x.name)),
      ...state.jdks,
    ];
    if (!includeHistory) {
      state.history = this.state.history;
      state.taskHistory = this.state.taskHistory;
    }
    this.dropChangedCredentials(state.servers);
    state.settings.artifactPolicy = this.state.settings.artifactPolicy;
    this.state = pruneHistory(state);
    this.recovery = undefined;
    this.writeState();
  }
  backup() {
    this.sql.exec('PRAGMA wal_checkpoint(FULL)');
    const dir = path.join(this.dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    if (fs.lstatSync(dir).isSymbolicLink())
      throw new Error('数据库备份目录不能是链接，原数据库已保留');
    const destination = path.join(
      dir,
      'database-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.sqlite',
    );
    fs.copyFileSync(
      path.join(this.dataDir, 'deploy-center.sqlite'),
      destination,
      fs.constants.COPYFILE_EXCL,
    );
    return destination;
  }
  saveTask(task: Task) {
    this.artifacts.register(task);
    this.remoteBackups.register(task);
    const summary = structuredClone(task);
    summary.buildLogs = [];
    for (const r of summary.targets) r.logs = [];
    this.sql
      .prepare(
        'INSERT INTO tasks VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,updated=excluded.updated,active=excluded.active',
      )
      .run(
        task.id,
        JSON.stringify(summary),
        Date.now(),
        ['running', 'cancelling'].includes(task.status) ? 1 : 0,
      );
  }
  workbenchReceipts(scopes: Set<string>): Receipt[] {
    const rows = this.sql.prepare('SELECT scope,json FROM workbench_receipts').all() as {
      scope: string;
      json: string;
    }[];
    return rows.filter((row) => scopes.has(row.scope)).map((row) => JSON.parse(row.json) as Receipt);
  }
  persistWorkbench(task: Task, targetId: string, receipt: Receipt, imported = false) {
    // 日志先落盘，再在 SQLite 提交远端交接确认。清理许可只在两步成功后返回。
    const fd = fs.openSync(this.logPath(task.id, targetId), 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const previous = this.state;
    try {
      this.sql.transaction(() => {
        this.saveTask(task);
        if (imported) {
          this.state = recordTask(this.state, task, false);
          this.writeState();
        }
        this.sql
          .prepare('INSERT OR REPLACE INTO workbench_receipts VALUES (?,?,?)')
          .run(receipt.scope, receipt.owner, JSON.stringify({ ...receipt, taskId: task.id, targetId }));
      })();
    } catch (error) {
      this.state = previous;
      throw error;
    }
  }
  discardUncommittedLog(taskId: string, targetId: string) {
    if (!this.task(taskId)) fs.rmSync(this.logPath(taskId, targetId), { force: true });
  }
  private setCleanupWarning(taskId: string, targetId: string, warning?: string) {
    const task = this.task(taskId);
    const run = task?.targets.find((entry) => entry.target.id === targetId);
    if (task && run && run.cleanupWarning !== warning) {
      run.cleanupWarning = warning;
      this.sql.prepare('UPDATE tasks SET json=? WHERE id=?').run(JSON.stringify(task), taskId);
    }
    const history = this.state.history.map((entry) =>
      entry.taskId === taskId && entry.target.id === targetId
        ? { ...entry, cleanupWarning: warning }
        : entry,
    );
    this.state = { ...this.state, history };
    this.writeState();
  }
  workbenchCleanupPending(taskId: string, targetId: string, warning: string) {
    this.setCleanupWarning(taskId, targetId, warning);
  }
  workbenchCleaned(receipt: Receipt) {
    const previous = this.state;
    try {
      this.sql.transaction(() => {
        const row = this.sql
          .prepare('SELECT json FROM workbench_receipts WHERE scope=? AND owner=?')
          .get(receipt.scope, receipt.owner) as { json: string } | undefined;
        if (!row) return;
        const { taskId, targetId } = JSON.parse(row.json) as { taskId?: string; targetId?: string };
        if (taskId && targetId) this.setCleanupWarning(taskId, targetId);
        this.sql
          .prepare('DELETE FROM workbench_receipts WHERE scope=? AND owner=?')
          .run(receipt.scope, receipt.owner);
      })();
    } catch (error) {
      this.state = previous;
      throw error;
    }
  }
  complete(task: Task, updateTargets = true) {
    // 任务结果、目标版本与历史在同一事务提交，崩溃不能留下“成功但版本未更新”。
    this.sql.transaction(() => {
      this.saveTask(task);
      if (!task.dryRun) this.state = recordTask(this.state, task, updateTargets);
      for (const h of this.state.history) h.logs = [];
      for (const r of Object.values(this.state.taskHistory)) r.buildLogs = [];
      this.writeState();
    })();
    this.applyRetention();
    this.writeState();
    this.scheduleMaintenance(task.id);
  }
  recordMaintenance(record: MaintenanceRecord, removedIds: string[] = []) {
    const paths = new Set(record.deleted.map((file) => path.posix.normalize(file)));
    this.sql.transaction(() => {
      this.remoteBackups.saveAudit(record);
      this.remoteBackups.removed(removedIds);
      if (paths.size) {
        const source = this.remoteBackups.records().filter((r) => removedIds.includes(r.id));
        for (const h of this.state.history)
          if (
            h.backupPath &&
            paths.has(path.posix.normalize(h.backupPath)) &&
            source.some(
              (r) => r.targetId === h.target.id && r.connection === backupConnection(h.server),
            )
          )
            h.backupRemoved = true;
        for (const task of this.allTasks()) {
          let changed = false;
          for (const run of task.targets)
            if (
              run.backupPath &&
              paths.has(path.posix.normalize(run.backupPath)) &&
              source.some(
                (r) =>
                  r.targetId === run.target.id && r.connection === backupConnection(run.server),
              )
            ) {
              run.backupRemoved = true;
              changed = true;
            }
          if (changed)
            this.sql
              .prepare('UPDATE tasks SET json=? WHERE id=?')
              .run(JSON.stringify(task), task.id);
        }
        this.writeState();
      }
    })();
  }
  private dropChangedCredentials(servers: Database['servers']) {
    const identity = (s: Database['servers'][number]) =>
      JSON.stringify([s.auth, s.host, s.port, s.user, s.alias, s.keyPath, s.sshConfigFile]);
    for (const id of this.credentialIds()) {
      const old = this.state.servers.find((s) => s.id === id),
        next = servers.find((s) => s.id === id);
      if (!next || next.credentialMode !== 'windows' || (old && identity(old) !== identity(next)))
        this.deleteCredential(id);
    }
  }
  private applyRetention() {
    const cutoff = this.state.settings.historyDays
      ? Date.now() - this.state.settings.historyDays * 86400000
      : -Infinity;
    this.state.history = this.state.history.filter((h) => Date.parse(h.time) >= cutoff);
    this.state = pruneHistory(this.state);
    const referenced = new Set(this.state.history.map((h) => h.taskId));
    const rows = this.sql
      .prepare('SELECT id,json,updated,active FROM tasks ORDER BY updated DESC')
      .all() as { id: string; json: string; updated: number; active: number }[];
    rows.forEach((row, index) => {
      let task: Task;
      try {
        task = parseTaskRecord(row.json, row.id);
      } catch {
        return;
      }
      if (
        row.active ||
        referenced.has(row.id) ||
        task.status === 'interrupted' ||
        (index < this.state.settings.historyLimit && row.updated >= cutoff)
      )
        return;
      this.artifacts.forget(row.id);
      this.sql.prepare('DELETE FROM tasks WHERE id=?').run(row.id);
      if (/^DC-[a-zA-Z0-9-]+$/.test(row.id))
        for (const folder of ['logs']) {
          const base = path.resolve(this.dataDir, folder),
            target = path.resolve(base, row.id);
          if (
            target.startsWith(base + path.sep) &&
            fs.existsSync(target) &&
            fs.realpathSync(target).startsWith(fs.realpathSync(base) + path.sep)
          )
            try {
              const verify = (dir: string) => {
                plainPath(dir);
                for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
                  const entry = path.join(dir, item.name);
                  plainPath(entry);
                  if (item.isDirectory()) verify(entry);
                }
              };
              verify(target);
              fs.rmSync(target, { recursive: true, force: true });
            } catch {
              /* 文件被占用时保留，不能让历史清理打断已完成任务。 */
            }
        }
    });
  }
  task(id: string): Task | undefined {
    const row = this.sql.prepare('SELECT json FROM tasks WHERE id=?').get(id) as
      | { json: string }
      | undefined;
    if (!row) return undefined;
    try {
      return parseTaskRecord(row.json, id);
    } catch {
      return undefined;
    }
  }
  tasks(): Task[] {
    return this.allTasks().slice(0, 500);
  }
  latestTask(): Task | undefined {
    return this.allTasks()[0];
  }
  unfinished(): Task[] {
    return this.allTasks().filter((t) => t.status === 'interrupted');
  }
  summaries(): TaskSummary[] {
    const actual = this.allTasks().slice(0, 10000).map(summarizeTask);
    const maintenance = this.remoteBackups
      .audits()
      .map(
        (m): TaskSummary => ({
          id: m.id,
          service: '远程备份',
          operation: 'deploy',
          status: m.status === 'pending' || m.status === 'unknown' ? 'interrupted' : m.status,
          started: m.time,
          elapsed: 0,
          note: m.message.split('\n')[0],
          maintenance: m,
          targets: [
            {
              id: m.targetId,
              name: m.targetName,
              serverId: m.serverId,
              server: m.serverName,
              status:
                m.status === 'success'
                  ? 'success'
                  : m.status === 'pending' || m.status === 'unknown'
                    ? 'unknown'
                    : 'failed',
              elapsed: 0,
            },
          ],
        }),
      );
    return [
      ...maintenance,
      ...actual,
      ...this.taskIssues.map(
        (issue): TaskSummary => ({
          id: issue.id,
          service: '无法读取的任务记录',
          operation: 'deploy',
          status: 'interrupted',
          started: '',
          elapsed: 0,
          note: issue.message,
          uncertain: true,
        }),
      ),
      ...importedSummaries(this.state, new Set(actual.map((t) => t.id))),
    ].sort((a, b) => Date.parse(b.started) - Date.parse(a.started));
  }
  markInterrupted() {
    for (const row of this.sql.prepare('SELECT id,json FROM tasks WHERE active=1').all() as {
      id: string;
      json: string;
    }[]) {
      let task: Task;
      try {
        task = parseTaskRecord(row.json, row.id);
      } catch {
        continue;
      }
      task.status = 'interrupted';
      for (const r of task.targets)
        if (
          ['running', 'rollingback'].includes(r.status) ||
          (r.remote && r.remote.phase !== 'complete')
        ) {
          r.status = 'unknown';
          r.error = '上次应用退出时任务未结束，请核实远端任务；不会自动重试替换。';
        }
      this.saveTask(task);
    }
  }
  pins(): Record<string, Pin> {
    return Object.fromEntries(
      (
        this.sql.prepare('SELECT * FROM pins').all() as {
          endpoint: string;
          key: string;
          fingerprint: string;
        }[]
      ).map((p) => [p.endpoint, { key: p.key, fingerprint: p.fingerprint }]),
    );
  }
  trust(endpoint: string, pin: Pin) {
    this.sql
      .prepare(
        'INSERT INTO pins VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET key=excluded.key,fingerprint=excluded.fingerprint',
      )
      .run(endpoint, pin.key, pin.fingerprint);
  }
  credentialIds(): string[] {
    return (this.sql.prepare('SELECT id FROM secrets').all() as { id: string }[]).map((x) => x.id);
  }
  async saveCredential(id: string, value: string) {
    const encrypted = await this.crypto.encrypt(value);
    this.sql
      .prepare(
        'INSERT INTO secrets VALUES (?,?) ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted',
      )
      .run(id, encrypted);
  }
  async credential(id: string) {
    const row = this.sql.prepare('SELECT encrypted FROM secrets WHERE id=?').get(id) as
      | { encrypted: Uint8Array }
      | undefined;
    return row ? this.crypto.decrypt(Buffer.from(row.encrypted)) : undefined;
  }
  deleteCredential(id: string) {
    this.sql.prepare('DELETE FROM secrets WHERE id=?').run(id);
  }
  logPath(taskId: string, targetId?: string) {
    if (!/^DC-[a-zA-Z0-9-]+$/.test(taskId) || (targetId && !/^[a-zA-Z0-9_-]+$/.test(targetId)))
      throw new Error('日志标识无效');
    const dir = path.join(this.dataDir, 'logs', taskId);
    return plainPath(path.join(dir, targetId ? targetId + '.log' : 'build.log'));
  }
  appendLog(taskId: string, text: string, targetId?: string, context?: LogContext) {
    const file = this.logPath(taskId, targetId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const start = fs.existsSync(file) ? fs.statSync(file).size : 0;
    fs.appendFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
    const end = fs.statSync(file).size;
    if (context)
      try {
        plainPath(file + '.context.jsonl');
        fs.appendFileSync(
          file + '.context.jsonl',
          JSON.stringify({ ...context, offset: start, end }) + '\n',
          { encoding: 'utf8', mode: 0o600 },
        );
      } catch {
        this.maintenanceWarnings.push('日志定位信息暂不可写，原始日志已保留。');
      }
    return end;
  }
  readLogs(taskId: string, targetId: string, before?: { build: number; target: number }) {
    const tail = (file: string, requested?: number) => {
      if (!fs.existsSync(file))
        return { text: '', truncated: false, offset: 0, start: 0, contexts: [] as LogContext[] };
      const stat = fs.statSync(file);
      const fd = fs.openSync(file, 'r');
      const end = Math.min(stat.size, requested ?? stat.size);
      const buffer = Buffer.alloc(Math.min(end, 2 * 1024 * 1024));
      try {
        fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, end - buffer.length));
      } finally {
        fs.closeSync(fd);
      }
      let start = Math.max(0, end - buffer.length),
        body = buffer;
      if (start > 0) {
        const first = buffer.indexOf(10);
        if (first >= 0) {
          start += first + 1;
          body = buffer.subarray(first + 1);
        }
      }
      const contextFile = file + '.context.jsonl';
      const contexts: LogContext[] = [];
      if (fs.existsSync(contextFile)) {
        plainPath(contextFile);
        // 定位信息与原始日志分开；旧记录缺失时保持空值，不推测远端时间或步骤。
        const cstat = fs.statSync(contextFile),
          size = Math.min(cstat.size, 16 * 1024 ** 2),
          chunk = Buffer.alloc(size),
          handle = fs.openSync(contextFile, 'r');
        try {
          fs.readSync(handle, chunk, 0, size, cstat.size - size);
        } finally {
          fs.closeSync(handle);
        }
        for (const line of chunk.toString('utf8').split('\n'))
          try {
            const context = JSON.parse(line) as LogContext;
            if (
              Number.isFinite(context.offset) &&
              Number.isFinite(context.end) &&
              context.offset! >= 0 &&
              context.end! > context.offset! &&
              context.end! > start &&
              context.offset! < end
            )
              contexts.push({
                offset: context.offset,
                end: context.end,
                time:
                  Number.isFinite(context.time) &&
                  context.time! >= 0 &&
                  context.time! <= 8640000000000000
                    ? context.time
                    : undefined,
                step: typeof context.step === 'string' ? context.step.slice(0, 500) : undefined,
                command:
                  typeof context.command === 'string' ? context.command.slice(0, 5000) : undefined,
              });
          } catch {
            /* 最早一条可能被截断，保留其他完整定位信息。 */
          }
      }
      return { text: body.toString('utf8'), truncated: start > 0, offset: end, start, contexts };
    };
    const build = tail(this.logPath(taskId), before?.build),
      target = tail(this.logPath(taskId, targetId), before?.target);
    return {
      build: build.text.split('\n'),
      target: target.text.split('\n'),
      truncated: build.truncated || target.truncated,
      buildOffset: build.offset,
      targetOffset: target.offset,
      buildStart: build.start,
      targetStart: target.start,
      buildContexts: build.contexts,
      targetContexts: target.contexts,
    };
  }
  pause() {
    if (this.artifacts.isBusy()) throw new Error('产物清理尚未结束');
    this.artifacts.setPaused(true);
    this.sql.pragma('wal_checkpoint(TRUNCATE)');
    this.sql.close();
  }
  resume() {
    this.sql = new Sqlite(path.join(this.dataDir, 'deploy-center.sqlite'));
    this.sql.pragma('journal_mode = WAL');
    this.sql.pragma('synchronous = FULL');
    this.sql.pragma('busy_timeout = 5000');
    this.artifacts.setPaused(false);
  }
  close() {
    this.artifacts?.setPaused(true);
    if (this.sql.open) this.sql.close();
  }
}
