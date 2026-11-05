import fs from 'node:fs';
import path from 'node:path';

/** 只接受数据目录中约定的普通文件；逐层拒绝链接，不能只检查最终 realpath。 */
export function managedPath(dataDir: string, folder: 'artifacts' | 'tmp', raw: string) {
  if (!path.isAbsolute(raw) || raw.split(/[\\/]/).includes('..'))
    throw new Error('路径不在允许清理的范围内');
  const base = path.resolve(dataDir, folder),
    target = path.resolve(raw);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('路径不在允许清理的范围内');
  plainPath(target);
  return { target, relative };
}
export function snapshotPath(dataDir: string, raw: string) {
  const result = managedPath(dataDir, 'artifacts', raw);
  if (
    !/^(?:sha256[\\/][a-f0-9]{64}\.jar|DC-[a-zA-Z0-9-]+[\\/][^\\/:*?"<>|]+\.jar)$/i.test(
      result.relative,
    )
  )
    throw new Error('产物目录结构异常，已保留');
  return result.target;
}

/** 迁移与日志同样不能跟随路径任一级的链接或 Windows 目录联接。 */
export function plainPath(raw: string) {
  if (!path.isAbsolute(raw) || raw.split(/[\\/]/).includes('..'))
    throw new Error('路径必须为无越界片段的绝对路径');
  const target = path.resolve(raw),
    root = path.parse(target).root;
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    if (segment) current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('链接路径不能清理或迁移');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return target;
}
