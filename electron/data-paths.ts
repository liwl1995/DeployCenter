import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { plainPath } from './managed-path';

/** 所有应用写入位置仅从当前数据目录派生，系统用户目录只用于兼容读取旧版本。 */
export function dataPaths(directory: string) {
  const root = plainPath(directory);
  const result = {
    root,
    control: path.join(root, 'Control'),
    runtime: path.join(root, 'Runtime'),
    updates: path.join(root, 'Updates'),
    logs: path.join(root, 'logs'),
    crashes: path.join(root, 'logs', 'crashes'),
    applicationLogs: path.join(root, 'logs', 'application'),
    updateLogs: path.join(root, 'logs', 'update'),
    temp: path.join(root, 'tmp', 'system'),
    installerLogs: path.join(root, 'logs', 'installer'),
    installerBackup: path.join(root, 'installer-backups'),
  };
  for (const value of Object.values(result)) plainPath(value);
  return result;
}
/** 原生助手只读写当前用户的目录位置；没有数据库、缓存或凭据写入注册表。 */
export class DirectoryLocator {
  constructor(
    private helper: string,
    private development: boolean,
  ) {}
  private command(operation: 'read' | 'write', directory?: string) {
    const args = [
      '--data-directory-' + operation,
      this.development ? 'DevelopmentDataDirectory' : 'DataDirectory',
    ];
    if (directory) args.push(Buffer.from(plainPath(directory), 'utf8').toString('base64'));
    try {
      return execFileSync(this.helper, args, {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 10000,
      }).trim();
    } catch {
      throw new Error(
        '无法读取或保存数据目录位置；不会自动切回默认目录，请检查当前用户注册表权限。',
      );
    }
  }
  read() {
    const value = this.command('read');
    return value ? plainPath(Buffer.from(value, 'base64').toString('utf8')) : undefined;
  }
  write(directory: string) {
    this.command('write', directory);
  }
}
const digest = (file: string) => {
  const hash = createHash('sha256'),
    buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(plainPath(file), 'r');
  try {
    let size: number;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, size));
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
};
/** 先复制到自有临时文件并核对，再发布文件名，避免磁盘不足留下被误认为完整的副本。 */
function copyVerified(source: string, target: string, hash: string) {
  const temp = plainPath(path.join(path.dirname(target), '.yotoo-copy-' + randomUUID()));
  try {
    fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
    if (digest(temp) !== hash) throw new Error('旧资料复制校验失败');
    if (fs.existsSync(target)) {
      if (digest(target) !== hash) throw new Error('目标出现不同文件，已保留原件');
    } else fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
/** 只复制普通文件并逐个验证，链接及未知类型保留现场；清理阶段不会递归扩大范围。 */
export function transferTree(source: string, target: string, exclude: string[] = []) {
  const files: { source: string; target: string; hash: string }[] = [];
  const dirs: string[] = [];
  if (!fs.existsSync(source) || path.resolve(source) === path.resolve(target))
    return { files, dirs };
  plainPath(source);
  plainPath(target);
  const fromRoot = path.resolve(source),
    toRoot = path.resolve(target);
  const nested = (a: string, b: string) => {
    const relative = path.relative(a, b);
    return (
      relative === '' ||
      (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    );
  };
  if (nested(fromRoot, toRoot) || nested(toRoot, fromRoot))
    throw new Error('转移目录不能互为父子目录');
  const walk = (from: string, to: string) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (from === source && exclude.includes(entry.name)) continue;
      const original = path.join(from, entry.name),
        dest = path.join(to, entry.name);
      plainPath(original);
      plainPath(dest);
      if (entry.isDirectory()) walk(original, dest);
      else if (entry.isFile()) {
        const hash = digest(original);
        if (!fs.existsSync(dest)) copyVerified(original, dest, hash);
        if (digest(dest) !== hash)
          throw new Error('旧数据与新目录存在不同文件，已保留原数据：' + original);
        files.push({ source: original, target: dest, hash });
      } else throw new Error('旧数据含有链接或特殊文件，已保留原数据：' + original);
    }
    dirs.push(from);
  };
  walk(source, target);
  return { files, dirs };
}
export function finishTransfer(transfer: ReturnType<typeof transferTree>) {
  for (const file of transfer.files) {
    plainPath(file.source);
    plainPath(file.target);
    if (
      fs.existsSync(file.source) &&
      digest(file.source) === file.hash &&
      digest(file.target) === file.hash
    )
      fs.unlinkSync(file.source);
  }
  for (const dir of transfer.dirs) {
    plainPath(dir);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
}

/** 原始资料已有校验备份时，只为新运行目录补齐文件；不覆盖本版本已经写入的会话状态。 */
export function seedTree(source: string, target: string) {
  if (!fs.existsSync(source)) return;
  plainPath(source);
  plainPath(target);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'lockfile' || entry.name === 'LOCK') continue;
    const from = plainPath(path.join(source, entry.name)),
      to = plainPath(path.join(target, entry.name));
    if (entry.isDirectory()) seedTree(from, to);
    else if (entry.isFile() && !fs.existsSync(to)) {
      copyVerified(from, to, digest(from));
      if (digest(from) !== digest(to)) throw new Error('运行资料复制校验失败');
    } else if (!entry.isFile()) throw new Error('运行资料包含特殊文件');
  }
}

/** 旧框架自缓存按内容复用已转移的安装包；没有相同内容时才另存一份。 */
export function transferInstallerCache(source: string, updates: string) {
  const target = path.join(updates, 'legacy-framework-cache');
  const transfer = transferTree(source, target, ['installer.exe']);
  const installer = plainPath(path.join(source, 'installer.exe'));
  if (!fs.existsSync(installer)) return transfer;
  if (!fs.statSync(installer).isFile()) throw new Error('旧安装缓存不是普通文件，已保留');
  const hash = digest(installer),
    size = fs.statSync(installer).size;
  for (const entry of fs.readdirSync(plainPath(updates), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('update-')) continue;
    const file = plainPath(path.join(updates, entry.name, 'setup.exe'));
    if (
      fs.existsSync(file) &&
      fs.statSync(file).isFile() &&
      fs.statSync(file).size === size &&
      digest(file) === hash
    ) {
      transfer.files.push({ source: installer, target: file, hash });
      return transfer;
    }
  }
  return transferTree(source, target);
}
