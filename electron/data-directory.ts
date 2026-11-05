import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Sqlite from 'better-sqlite3';
import { z } from 'zod';
import { plainPath } from './managed-path';
import { MigrationReporter } from './migration-progress';
import { databaseVersion } from './storage';

/** 新迁移入口接受上级目录；既有位置指针和恢复日志继续使用原绝对路径。 */
export function migrationDestination(parent: string) {
  if (/[\r\n\0]/.test(parent)) throw new Error('请选择有效的绝对目录');
  return path.join(plainPath(parent), 'DeployCenter');
}

const ownerFile = '.yotoo-data-owner.ini';
const markerFile = '.yotoo-migration-owner';
const ownerText = '[application]\nid=local.deploycenter.desktop\n';
const pointerSchema = z.object({
  schema: z.literal(1),
  active: z.string(),
  pending: z.string().optional(),
  previous: z.string().optional(),
  migrationId: z.string().optional(),
  previousKept: z.boolean().optional(),
});
const journalSchema = z.object({
  id: z.string().uuid(),
  source: z.string(),
  target: z.string(),
  stage: z.enum(['copying', 'verifying', 'pending', 'active', 'cancelled', 'failed']),
  files: z.array(z.string()),
  createdTarget: z.boolean(),
  directories: z.array(z.string()).optional(),
  error: z.string().optional(),
  manifest: z
    .array(z.object({ relative: z.string(), size: z.number(), hash: z.string().optional() }))
    .optional(),
  verified: z
    .array(z.object({ relative: z.string(), size: z.number(), hash: z.string().optional() }))
    .optional(),
});
type Pointer = z.infer<typeof pointerSchema>;
type Journal = z.infer<typeof journalSchema>;
type Entry = { relative: string; size: number; hash?: string };
export type { MigrationProgress, DirectoryInfo, DirectoryCheck } from '../src/features';
import type { MigrationProgress, DirectoryInfo, DirectoryCheck } from '../src/features';

function atomic(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}
const inside = (value: string, root: string) => {
  const r = path.relative(root, value);
  return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r));
};
async function digest(file: string, signal?: AbortSignal, onChunk?: (bytes: number) => void) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) {
    if (signal?.aborted) throw new Error('迁移已取消');
    hash.update(chunk as Buffer);
    onChunk?.((chunk as Buffer).length);
  }
  return hash.digest('hex');
}
async function inventory(root: string): Promise<Entry[]> {
  plainPath(root);
  const list: Entry[] = [];
  async function walk(directory: string) {
    for (const item of await fsp.readdir(directory, { withFileTypes: true })) {
      if (item.name === ownerFile || item.name === markerFile) continue;
      const file = path.join(directory, item.name),
        info = await fsp.lstat(file);
      if (info.isSymbolicLink())
        throw new Error('数据目录包含链接，拒绝越界复制：' + path.relative(root, file));
      if (info.isDirectory()) await walk(file);
      else if (info.isFile()) list.push({ relative: path.relative(root, file), size: info.size });
      else throw new Error('数据目录包含不支持的文件类型');
    }
  }
  if (fs.existsSync(root)) await walk(root);
  return list;
}
async function directoryList(root: string): Promise<string[]> {
  const dirs: string[] = [];
  const walk = async (dir: string) => {
    for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name),
        info = await fsp.lstat(file);
      if (info.isSymbolicLink()) throw new Error('数据目录包含链接，拒绝迁移或清理');
      if (info.isDirectory()) {
        dirs.push(path.relative(root, file));
        await walk(file);
      }
    }
  };
  await walk(root);
  return dirs.sort();
}
function checkDatabase(file: string) {
  const sql = new Sqlite(file, { readonly: true, fileMustExist: true });
  try {
    if (sql.pragma('quick_check', { simple: true }) !== 'ok')
      throw new Error('数据库完整性检查未通过');
    const version = Number(sql.pragma('user_version', { simple: true }));
    if (version > databaseVersion) throw new Error('数据库由更新版本创建');
    sql.prepare('SELECT json FROM config WHERE id=1').get();
    return {
      tasks: (sql.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n,
      secrets: sql.prepare('SELECT id,hex(encrypted) AS value FROM secrets ORDER BY id').all(),
    };
  } finally {
    sql.close();
  }
}

/** 位置指针和迁移日志始终保存在数据目录外；复制完成前绝不切换活动目录。 */
export class DataDirectory {
  readonly pointerFile: string;
  readonly journalFile: string;
  private pointer: Pointer;
  private controller?: AbortController;
  progress: MigrationProgress = {
    state: 'idle',
    copied: 0,
    total: 0,
    files: 0,
    totalFiles: 0,
    message: '',
  };
  constructor(
    readonly settingsDir: string,
    readonly defaultDir: string,
    private restrictedRoots: string[] = [],
  ) {
    this.pointerFile = path.join(settingsDir, 'data-location.json');
    this.journalFile = path.join(settingsDir, 'migration.json');
    this.pointer = { schema: 1, active: path.resolve(defaultDir) };
  }
  private journal(): Journal | undefined {
    if (!fs.existsSync(this.journalFile)) return;
    return journalSchema.parse(JSON.parse(fs.readFileSync(this.journalFile, 'utf8')));
  }
  private savePointer(pointer: Pointer) {
    atomic(this.pointerFile, pointer);
    this.pointer = pointer;
    this.writeIni();
  }
  private writeIni() {
    fs.mkdirSync(this.settingsDir, { recursive: true });
    const ini =
      '[location]\r\nactive=' +
      this.pointer.active +
      '\r\npending=' +
      (this.pointer.pending || '') +
      '\r\nprevious=' +
      (this.pointer.previous || '') +
      '\r\n';
    // Windows 原生 INI API 按 UTF-16 BOM 识别中文路径，不能依赖系统 ANSI 代码页。
    fs.writeFileSync(
      path.join(this.settingsDir, 'data-location.ini'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ini, 'utf16le')]),
      { mode: 0o600 },
    );
  }
  async locate(): Promise<{ directory: string; notice?: string }> {
    let notice = '';
    if (fs.existsSync(this.pointerFile)) {
      try {
        this.pointer = pointerSchema.parse(JSON.parse(fs.readFileSync(this.pointerFile, 'utf8')));
      } catch {
        throw new Error(
          '数据目录位置配置损坏。请选择已有数据目录，或明确改用默认目录；不会自动新建空配置。',
        );
      }
    } else if (fs.existsSync(this.journalFile)) {
      const journal = this.journal();
      if (journal) {
        this.pointer = {
          schema: 1,
          active: journal.stage === 'active' ? journal.target : journal.source,
        };
        notice = '上次位置切换未完成，已找到原记录。';
      }
    }
    const journal = this.journal();
    if (journal && ['copying', 'verifying'].includes(journal.stage)) {
      try {
        await this.cleanCopied(journal);
      } catch (error) {
        notice += '目标目录的残留已保留，请人工核对：' + journal.target + '；' + String(error);
      }
      atomic(this.journalFile, { ...journal, stage: 'cancelled' });
      notice += '上次迁移被中断，继续使用原目录；未启用半迁移数据。';
    }
    if (this.pointer.pending) {
      try {
        if (
          !journal ||
          journal.target !== this.pointer.pending ||
          journal.id !== this.pointer.migrationId
        )
          throw new Error('迁移记录不一致');
        checkDatabase(path.join(this.pointer.pending, 'deploy-center.sqlite'));
        if (!journal.verified) throw new Error('缺少迁移完整性清单');
        if (
          journal.directories &&
          JSON.stringify(await directoryList(this.pointer.pending)) !==
            JSON.stringify(journal.directories)
        )
          throw new Error('迁移后目录结构变化');
        const currentFiles = await inventory(this.pointer.pending);
        if (currentFiles.length !== journal.verified.length) throw new Error('迁移后文件数量变化');
        for (const entry of journal.verified) {
          const file = path.resolve(this.pointer.pending, entry.relative);
          if (
            !inside(file, this.pointer.pending) ||
            (await fsp.stat(file)).size !== entry.size ||
            (await digest(file)) !== entry.hash
          )
            throw new Error('迁移后文件发生变化：' + entry.relative);
        }

        const previous = this.pointer.active;
        this.savePointer({
          schema: 1,
          active: this.pointer.pending,
          previous,
          migrationId: journal.id,
        });
        atomic(this.journalFile, { ...journal, stage: 'active' });
        notice += '已切换到校验通过的新目录，旧目录保留在 ' + previous + '。';
      } catch (error) {
        throw new Error(
          '待切换的数据目录无法读取：' +
            String(error) +
            '。原目录仍保留在 ' +
            this.pointer.active +
            '，请选择处理方式。',
        );
      }
    }
    const directory = path.resolve(this.pointer.active);
    if (fs.existsSync(this.pointerFile) || journal) {
      if (!fs.existsSync(path.join(directory, 'deploy-center.sqlite')))
        throw new Error(
          '指定数据目录不存在或缺少数据库：' + directory + '。请选择已有目录或明确改用默认目录。',
        );
      checkDatabase(path.join(directory, 'deploy-center.sqlite'));
    }
    return { directory, notice: notice || undefined };
  }
  /** 启动恢复必须由原生对话框明确选择；默认目录为空时也不会隐式覆盖其他目录。 */
  selectExisting(directory: string, allowNewDefault = false) {
    const target = path.resolve(directory);
    if (!allowNewDefault || target !== path.resolve(this.defaultDir))
      checkDatabase(path.join(target, 'deploy-center.sqlite'));
    this.savePointer({ schema: 1, active: target });
  }
  markOwned(directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, ownerFile), ownerText, { encoding: 'utf8', mode: 0o600 });
    this.writeIni();
  }
  async info(): Promise<DirectoryInfo> {
    const entries = await inventory(this.pointer.active);
    return {
      path: this.pointer.active,
      bytes: entries.reduce((n, e) => n + e.size, 0),
      files: entries.length,
      previous: this.pointer.previous,
      previousBytes: this.pointer.previous
        ? this.journal()?.manifest?.reduce((n, e) => n + e.size, 0)
        : undefined,
      pending: this.pointer.pending,
      previousKept: this.pointer.previousKept,
    };
  }
  private async safeTarget(raw: string) {
    if (!path.isAbsolute(raw) || /[\r\n\0]/.test(raw)) throw new Error('请选择有效的绝对目录');
    const target = plainPath(raw),
      root = path.parse(target).root;
    if (target === root) throw new Error('不能使用磁盘根目录');
    let ancestor = target;
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error('找不到可访问的父目录');
      ancestor = parent;
    }
    const canonical = path.join(await fsp.realpath(ancestor), path.relative(ancestor, target));
    const current = fs.existsSync(this.pointer.active)
      ? await fsp.realpath(this.pointer.active)
      : path.resolve(this.pointer.active);
    if (inside(canonical, current) || inside(current, canonical))
      throw new Error('新目录不能是当前目录、子目录或父目录');
    for (const restricted of this.restrictedRoots.filter(Boolean))
      if (inside(canonical, path.resolve(restricted)))
        throw new Error('不能选择系统目录或程序安装目录');
    return canonical;
  }
  async inspect(raw: string): Promise<DirectoryCheck> {
    const errors: string[] = [];
    let target = path.resolve(raw || '.'),
      available = 0,
      empty = false,
      writable = false;
    const info = await this.info();
    const required = Math.ceil(info.bytes * 1.1) + 16 * 1024 * 1024;
    try {
      target = await this.safeTarget(raw);
      let parent = target;
      if (fs.existsSync(target)) {
        if (!(await fsp.stat(target)).isDirectory()) throw new Error('所选路径不是目录');
        empty = (await fsp.readdir(target)).length === 0;
        if (!empty) errors.push('目标目录非空，禁止覆盖或合并。');
      } else {
        empty = true;
        while (!fs.existsSync(parent)) parent = path.dirname(parent);
      }
      const probe = path.join(parent, '.yotoo-write-' + randomUUID());
      const handle = await fsp.open(probe, 'wx', 0o600);
      await handle.close();
      await fsp.unlink(probe);
      writable = true;
      const disk = await fsp.statfs(parent);
      available = Number(disk.bavail) * Number(disk.bsize);
      if (available < required)
        errors.push('剩余空间不足，需要 ' + required + ' 字节，可用 ' + available + ' 字节。');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return {
      path: target,
      valid: errors.length === 0,
      errors,
      available,
      required,
      empty,
      writable,
    };
  }
  state() {
    return { ...this.pointer };
  }
  keepPrevious() {
    this.savePointer({ ...this.pointer, previousKept: true });
  }
  cancel() {
    this.controller?.abort();
  }
  async migrate(
    raw: string,
    guard: () => string | undefined,
    pause: () => void,
    resume: () => void,
    emit: (value: MigrationProgress) => void,
  ) {
    if (this.controller || this.pointer.pending) throw new Error('已有迁移或待重启切换');
    const blocked = guard();
    if (blocked) throw new Error(blocked);
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const reporter = new MigrationReporter(this.pointer.active, raw, (value) => {
      this.progress = value;
      emit(value);
    });
    this.progress = reporter.update({}, true);
    let check: DirectoryCheck;
    try {
      check = await this.inspect(raw);
      if (signal.aborted) throw new Error('迁移已取消');
      if (!check.valid) throw new Error(check.errors.join('\n'));
    } catch (error) {
      this.progress = reporter.update(
        {
          state: signal.aborted ? 'cancelled' : 'failed',
          message: String(error) + '；继续使用原目录。',
        },
        true,
      );
      this.controller = undefined;
      throw error;
    }
    const source = this.pointer.active,
      target = check.path;
    const journal: Journal = {
      id: randomUUID(),
      source,
      target,
      stage: 'copying',
      files: [],
      createdTarget: !fs.existsSync(target),
    };
    let paused = false,
      owned = false;
    const update = (patch: Partial<MigrationProgress>) => {
      this.progress = reporter.update({ ...patch, source, target });
    };
    try {
      const blockedAgain = guard();
      if (blockedAgain) throw new Error(blockedAgain);
      pause();
      paused = true;
      const manifest = await inventory(source),
        before = checkDatabase(path.join(source, 'deploy-center.sqlite'));
      // 检查后再次确认空目录，避免对话框停留期间目标发生变化。
      if (fs.existsSync(target) && (await fsp.readdir(target)).length)
        throw new Error('目标目录已变为非空，停止迁移');
      await fsp.mkdir(target, { recursive: true });
      journal.directories = await directoryList(source);
      await fsp.writeFile(path.join(target, markerFile), journal.id, { flag: 'wx', mode: 0o600 });
      owned = true;
      atomic(this.journalFile, journal);
      update({
        state: 'copying',
        copied: 0,
        total: manifest.reduce((n, e) => n + e.size, 0),
        files: 0,
        totalFiles: manifest.length,
        message: '正在复制，原目录保留且暂停写入',
      });
      for (const relative of journal.directories) {
        const dest = path.resolve(target, relative);
        if (!inside(dest, target) || dest === target) throw new Error('目录路径越界');
        await fsp.mkdir(dest, { recursive: true });
      }
      for (const entry of manifest) {
        if (signal.aborted) throw new Error('迁移已取消');
        update({ currentFile: entry.relative });
        const original = path.join(source, entry.relative),
          dest = path.join(target, entry.relative);
        if (!inside(dest, target)) throw new Error('文件路径越界');
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        plainPath(dest);
        journal.files.push(entry.relative);
        atomic(this.journalFile, journal);
        const output = await fsp.open(dest, 'wx', 0o600);
        const hash = createHash('sha256');
        try {
          for await (const chunk of fs.createReadStream(original)) {
            if (signal.aborted) throw new Error('迁移已取消');
            await output.writeFile(chunk as Buffer);
            hash.update(chunk as Buffer);
            update({ copied: this.progress.copied + (chunk as Buffer).length });
          }
          await output.sync();
        } finally {
          await output.close();
        }
        entry.hash = hash.digest('hex');
        update({ files: this.progress.files + 1 });
      }
      journal.stage = 'verifying';
      atomic(this.journalFile, journal);
      update({
        state: 'verifying',
        verified: 0,
        verifiedFiles: 0,
        message: '核对文件数量、大小、哈希及数据库',
      });
      if (JSON.stringify(await directoryList(target)) !== JSON.stringify(journal.directories))
        throw new Error('复制后的目录结构不一致');
      const copied = await inventory(target);
      if (copied.length !== manifest.length) throw new Error('复制后的文件数量不一致');
      for (const entry of manifest) {
        if (signal.aborted) throw new Error('迁移已取消');
        const file = path.join(target, entry.relative);
        update({ currentFile: entry.relative });
        if (
          (await fsp.stat(file)).size !== entry.size ||
          (await digest(file, signal, (bytes) =>
            update({ verified: (this.progress.verified || 0) + bytes }),
          )) !== entry.hash
        )
          throw new Error('文件校验失败：' + entry.relative);
        update({ verifiedFiles: (this.progress.verifiedFiles || 0) + 1 });
      }
      rebaseDatabase(path.join(target, 'deploy-center.sqlite'), source, target);
      const after = checkDatabase(path.join(target, 'deploy-center.sqlite'));
      if (
        before.tasks !== after.tasks ||
        JSON.stringify(before.secrets) !== JSON.stringify(after.secrets)
      )
        throw new Error('数据库任务或加密凭据校验不一致');
      journal.manifest = manifest;
      journal.verified = await inventory(target);
      for (const entry of journal.verified) {
        update({ currentFile: entry.relative });
        entry.hash = await digest(path.join(target, entry.relative), signal);
      }
      this.markOwned(target);
      if (signal.aborted) throw new Error('迁移已取消');
      journal.stage = 'pending';
      atomic(this.journalFile, journal);
      this.savePointer({ schema: 1, active: source, pending: target, migrationId: journal.id });
      update({
        state: 'pending',
        currentFile: undefined,
        message:
          '复制与校验完成，重启后使用新目录。为避免分叉，重启前暂停配置和部署写入；旧目录默认保留。',
      });
    } catch (error) {
      let cleanup = '';
      if (owned)
        try {
          await this.cleanCopied(journal);
        } catch (e) {
          cleanup = '；复制残留已保留，请检查 ' + target + '：' + String(e);
        }
      journal.stage = signal.aborted ? 'cancelled' : 'failed';
      journal.error = String(error) + cleanup;
      atomic(this.journalFile, journal);
      update({
        state: signal.aborted ? 'cancelled' : 'failed',
        message: String(error) + cleanup + '；继续使用原目录。',
      });
      throw new Error(this.progress.message);
    } finally {
      if (paused) resume();
      this.controller = undefined;
    }
    return this.progress;
  }
  private async cleanCopied(journal: Journal) {
    const target = path.resolve(journal.target),
      marker = path.join(target, markerFile);
    if (!fs.existsSync(marker)) return;
    if ((await fsp.readFile(marker, 'utf8')) !== journal.id)
      throw new Error('残留目录所有权标记不一致，未删除任何文件');
    const real = await fsp.realpath(target);
    if (
      target === path.parse(target).root ||
      real !== target ||
      inside(path.resolve(journal.source), target)
    )
      throw new Error('残留目录路径发生变化');
    for (const relative of [...journal.files].reverse()) {
      const file = path.resolve(target, relative);
      if (!inside(file, target) || file === target) throw new Error('清理范围越界');
      plainPath(file);
      if (fs.existsSync(file)) {
        if ((await fsp.lstat(file)).isSymbolicLink())
          throw new Error('复制文件被替换为链接，保留残留');
        await fsp.unlink(file);
      }
      let parent = path.dirname(file);
      while (parent !== target && inside(parent, target)) {
        try {
          await fsp.rmdir(parent);
        } catch {
          break;
        }
        parent = path.dirname(parent);
      }
    }
    for (const relative of [...(journal.directories || [])].sort((a, b) => b.length - a.length)) {
      const dir = path.resolve(target, relative);
      if (!inside(dir, target) || dir === target) throw new Error('目录清理越界');
      if (fs.existsSync(dir)) {
        if ((await fsp.lstat(dir)).isSymbolicLink() || (await fsp.realpath(dir)) !== dir)
          throw new Error('残留目录包含链接，已保留');
        await fsp.rmdir(dir);
      }
    }
    const remaining = (await fsp.readdir(target)).filter(
      (file) => ![ownerFile, markerFile].includes(file),
    );
    if (remaining.length) throw new Error('目标仍有未识别的残留，已保留目录与标记');
    for (const file of [ownerFile, markerFile])
      await fsp.unlink(path.join(target, file)).catch(() => {});
    if (journal.createdTarget) await fsp.rmdir(target).catch(() => {});
  }
  /** 只有新目录已激活且旧副本未被改动时才允许清理；调用方必须再次核对完整路径。 */
  async removePrevious(confirmedPath: string) {
    const previous = this.pointer.previous,
      journal = this.journal();
    if (
      !previous ||
      confirmedPath !== previous ||
      !journal ||
      journal.stage !== 'active' ||
      journal.source !== previous ||
      journal.target !== this.pointer.active
    )
      throw new Error('旧目录确认或迁移记录不匹配');
    const old = path.resolve(previous),
      current = path.resolve(this.pointer.active);
    if (inside(old, current) || inside(current, old) || path.parse(old).root === old)
      throw new Error('旧目录清理范围无效');
    checkDatabase(path.join(current, 'deploy-center.sqlite'));
    // 持久标记来自应用；旧版默认目录无标记时仅允许迁移时记录的精确文件集。
    if (
      journal.directories &&
      JSON.stringify(await directoryList(old)) !== JSON.stringify(journal.directories)
    )
      throw new Error('旧目录结构已改变，保留并人工检查');
    const entries = await inventory(old);
    const allowed = new Set(journal.files);
    if (entries.some((e) => !allowed.has(e.relative)))
      throw new Error('旧目录出现新增文件，请保留并人工检查');
    if (!journal.manifest || entries.length !== journal.manifest.length)
      throw new Error('旧目录文件数量已变化，请保留并人工核对');
    for (const entry of journal.manifest) {
      const file = path.resolve(old, entry.relative);
      if (
        !inside(file, old) ||
        (await fsp.stat(file)).size !== entry.size ||
        (await digest(file)) !== entry.hash
      )
        throw new Error('旧目录文件已改变，未清理：' + entry.relative);
    }
    if ((await fsp.realpath(old)) !== old) throw new Error('旧目录已变成链接');
    // 已逐项确认根路径与文件集，禁止使用未经检查的计算路径执行递归删除。
    plainPath(old);
    await fsp.rm(old, { recursive: true, force: false });
    this.savePointer({ ...this.pointer, previous: undefined });
    return true;
  }
}

function rebaseDatabase(file: string, source: string, target: string) {
  const sql = new Sqlite(file);
  const move = (value: string) =>
    path.isAbsolute(value) && inside(path.resolve(value), source)
      ? path.join(target, path.relative(source, path.resolve(value)))
      : value;
  const artifact = (item: any) => {
    if (item?.artifact) {
      for (const key of ['path', 'originalPath'])
        if (typeof item.artifact[key] === 'string') item.artifact[key] = move(item.artifact[key]);
    }
  };
  try {
    sql.transaction(() => {
      const config = sql.prepare('SELECT json FROM config WHERE id=1').get() as
        | { json: string }
        | undefined;
      if (config) {
        const db = JSON.parse(config.json);
        for (const s of db.services || [])
          for (const key of ['root', 'workDir', 'jarDir', 'mavenPath'])
            if (typeof s[key] === 'string') s[key] = move(s[key]);
        for (const j of db.jdks || []) j.path = move(j.path);
        for (const s of db.servers || [])
          for (const key of ['keyPath', 'sshConfigFile'])
            if (typeof s[key] === 'string') s[key] = move(s[key]);
        for (const h of db.history || []) artifact(h);
        sql.prepare('UPDATE config SET json=? WHERE id=1').run(JSON.stringify(db));
      }
      if (
        sql
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifact_objects'")
          .get()
      ) {
        for (const row of sql.prepare('SELECT path FROM artifact_objects').all() as {
          path: string;
        }[]) {
          const moved = move(row.path);
          sql.prepare('UPDATE artifact_objects SET path=? WHERE path=?').run(moved, row.path);
          sql.prepare('UPDATE artifact_refs SET path=? WHERE path=?').run(moved, row.path);
        }
      }
      for (const row of sql.prepare('SELECT id,json FROM tasks').all() as {
        id: string;
        json: string;
      }[]) {
        const task = JSON.parse(row.json);
        artifact(task);
        sql.prepare('UPDATE tasks SET json=? WHERE id=?').run(JSON.stringify(task), row.id);
      }
    })();
    sql.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    sql.close();
  }
}
