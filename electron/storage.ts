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
import { emptyDatabase } from '../src/defaults';

export type Cryptography = {
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
};
export const productionSeed = emptyDatabase;
export class Storage {
  private sql!: Sqlite.Database;
  private state: Database;
  recovery?: Recovery;
  readonly dataDir: string;
  constructor(
    dir: string,
    private crypto: Cryptography,
  ) {
    this.dataDir = path.resolve(dir);
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dataDir, 'deploy-center.sqlite');
    try {
      this.sql = new Sqlite(file);
      const version = Number(
        (this.sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      );
      if (version > 2) throw new Error('数据库由更新版本创建，请升级应用');
      this.sql.pragma('journal_mode = WAL');
      this.sql.pragma('synchronous = FULL');
      this.sql.pragma('busy_timeout = 5000');
      if (version < 2) {
        // 迁移在事务内执行；原数据库先 checkpoint 并备份，失败不替换原文件。
        if (fs.statSync(file).size > 0) this.backup();
        this.sql.transaction(() => {
          this.sql.exec(
            'CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated INTEGER NOT NULL, active INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, encrypted BLOB NOT NULL); CREATE TABLE IF NOT EXISTS pins (endpoint TEXT PRIMARY KEY, key TEXT NOT NULL, fingerprint TEXT NOT NULL); CREATE TABLE IF NOT EXISTS recoveries (id TEXT PRIMARY KEY, raw TEXT NOT NULL);',
          );
          this.sql.pragma('user_version = 2');
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
    next.targets = next.targets.map((t) => {
      const old = this.state.targets.find((x) => x.id === t.id);
      return old
        ? {
            ...t,
            version: old.version,
            lastDeploy: old.lastDeploy,
            healthState: old.healthState,
            currentHash: old.currentHash,
          }
        : t;
    });
    this.dropChangedCredentials(next.servers);
    this.state = pruneHistory(next);
    this.applyRetention();
    this.writeState();
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
    this.state = pruneHistory(state);
    this.recovery = undefined;
    this.writeState();
  }
  backup() {
    this.sql.exec('PRAGMA wal_checkpoint(FULL)');
    const dir = path.join(this.dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
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
  complete(task: Task) {
    // 任务结果、目标版本与历史在同一事务提交，崩溃不能留下“成功但版本未更新”。
    this.sql.transaction(() => {
      this.saveTask(task);
      if (!task.dryRun) this.state = recordTask(this.state, task);
      for (const h of this.state.history) h.logs = [];
      for (const r of Object.values(this.state.taskHistory)) r.buildLogs = [];
      this.writeState();
    })();
    this.applyRetention();
    this.writeState();
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
      if (
        row.active ||
        referenced.has(row.id) ||
        JSON.parse(row.json).status === 'interrupted' ||
        (index < this.state.settings.historyLimit && row.updated >= cutoff)
      )
        return;
      this.sql.prepare('DELETE FROM tasks WHERE id=?').run(row.id);
      if (/^DC-[a-zA-Z0-9-]+$/.test(row.id))
        for (const folder of ['logs', 'artifacts']) {
          const base = path.resolve(this.dataDir, folder),
            target = path.resolve(base, row.id);
          if (
            target.startsWith(base + path.sep) &&
            fs.existsSync(target) &&
            fs.realpathSync(target).startsWith(fs.realpathSync(base) + path.sep)
          )
            try {
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
    return row ? JSON.parse(row.json) : undefined;
  }
  tasks(): Task[] {
    return (
      this.sql.prepare('SELECT json FROM tasks ORDER BY updated DESC LIMIT 500').all() as {
        json: string;
      }[]
    ).map((row) => JSON.parse(row.json));
  }
  latestTask(): Task | undefined {
    const row = this.sql.prepare('SELECT json FROM tasks ORDER BY updated DESC LIMIT 1').get() as
      | { json: string }
      | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }
  unfinished(): Task[] {
    return (
      this.sql
        .prepare(
          "SELECT json FROM tasks WHERE json_extract(json,'$.status')='interrupted' ORDER BY updated DESC",
        )
        .all() as { json: string }[]
    ).map((r) => JSON.parse(r.json));
  }
  summaries(): TaskSummary[] {
    return this.sql
      .prepare(
        "SELECT id, json_extract(json,'$.service.name') AS service,json_extract(json,'$.operation') AS operation,json_extract(json,'$.status') AS status,json_extract(json,'$.started') AS started,json_extract(json,'$.elapsed') AS elapsed FROM tasks ORDER BY updated DESC LIMIT 200",
      )
      .all() as TaskSummary[];
  }
  markInterrupted() {
    for (const row of this.sql.prepare('SELECT json FROM tasks WHERE active=1').all() as {
      json: string;
    }[]) {
      const task = JSON.parse(row.json) as Task;
      task.status = 'interrupted';
      for (const r of task.targets)
        if (
          ['running', 'rollingback'].includes(r.status) ||
          (r.remote && !['success', 'unverified', 'rolledback', 'failed'].includes(r.status))
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
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, targetId ? targetId + '.log' : 'build.log');
  }
  appendLog(taskId: string, text: string, targetId?: string) {
    const file = this.logPath(taskId, targetId);
    fs.appendFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
    return fs.statSync(file).size;
  }
  readLogs(taskId: string, targetId: string) {
    const tail = (file: string) => {
      if (!fs.existsSync(file)) return { text: '', truncated: false, offset: 0 };
      const stat = fs.statSync(file);
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(Math.min(stat.size, 2 * 1024 * 1024));
      try {
        fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
      } finally {
        fs.closeSync(fd);
      }
      return {
        text: buffer.toString('utf8'),
        truncated: stat.size > buffer.length,
        offset: stat.size,
      };
    };
    const build = tail(this.logPath(taskId)),
      target = tail(this.logPath(taskId, targetId));
    return {
      build: build.text.split('\n'),
      target: target.text.split('\n'),
      truncated: build.truncated || target.truncated,
      buildOffset: build.offset,
      targetOffset: target.offset,
    };
  }
  close() {
    this.sql.close();
  }
}
