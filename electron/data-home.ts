import fs from 'node:fs';
import path from 'node:path';
import { DataDirectory, validateExistingDirectory } from './data-directory';
import { createHash, randomUUID } from 'node:crypto';
import {
  dataPaths,
  transferTree,
  transferInstallerCache,
  finishTransfer,
  seedTree,
  type DirectoryLocator,
} from './data-paths';
import { plainPath } from './managed-path';

type Locator = Pick<DirectoryLocator, 'read' | 'write'>;
const read = (file: string) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(plainPath(file), 'utf8')) : undefined;
/** 隔离验收只写测试根目录中的定位文件，绝不改正式注册表。 */
export function testLocator(directory: string): Locator {
  const file = path.join(directory, 'bootstrap-location.json');
  return {
    read: () => {
      const value = read(file);
      return value ? plainPath(value.directory) : undefined;
    },
    write: (value) => {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ directory: plainPath(value) }), 'utf8');
    },
  };
}
/** 启动先确定目录，迁移待激活时先为目标配置运行路径；业务完整性仍交给原迁移验证。 */
export function prepareDataHome(
  defaultDir: string,
  legacySettings: string,
  locator: Locator,
  legacyAuxiliary: { source: string; target: string; installerCache?: boolean }[] = [],
) {
  const located = locator.read();
  const warnings: string[] = [];
  let legacy;
  try {
    legacy = read(path.join(legacySettings, 'data-location.json'));
  } catch (error) {
    if (!located) throw error;
    warnings.push('旧位置记录无法解析，原始内容将备份到当前目录：' + String(error));
  }
  const directory = plainPath(located || legacy?.active || defaultDir);
  const paths = dataPaths(directory);
  const transfers: ReturnType<typeof transferTree>[] = [];
  const controlNames = ['data-location.json', 'data-location.ini', 'migration.json'];
  if (controlNames.some((name) => fs.existsSync(path.join(legacySettings, name)))) {
    // 原始控制记录先留一份数据目录内备份，再复制工作副本，后续只清理经验证的原件。
    transfers.push(
      transferTree(
        legacySettings,
        path.join(paths.control, 'legacy-startup-backup'),
        fs
          .readdirSync(legacySettings)
          .filter(
            (n) => !['data-location.json', 'data-location.ini', 'migration.json'].includes(n),
          ),
      ),
    );
    fs.mkdirSync(paths.control, { recursive: true });
    for (const name of ['data-location.json', 'data-location.ini', 'migration.json']) {
      const source = path.join(legacySettings, name);
      if (!located && fs.existsSync(source) && !fs.existsSync(path.join(paths.control, name)))
        fs.copyFileSync(
          plainPath(source),
          path.join(paths.control, name),
          fs.constants.COPYFILE_EXCL,
        );
    }
  }
  const pointer = read(path.join(paths.control, 'data-location.json'));
  // 兼容已激活控制记录但尚未来得及提交注册表位置就崩溃的窗口。
  let runtimeRoot = pointer?.active ? plainPath(pointer.active) : directory;
  if (pointer?.pending) {
    const pending = plainPath(pointer.pending);
    if (
      fs.existsSync(path.join(pending, '.yotoo-migration-owner')) &&
      fs.existsSync(path.join(pending, 'deploy-center.sqlite'))
    )
      runtimeRoot = pending;
  }
  return {
    directory,
    configured: !!located || !!legacy,
    paths,
    runtimeRoot,
    locator,
    prepareProfile() {
      const runtime = dataPaths(runtimeRoot).runtime;
      if (runtimeRoot !== directory && fs.existsSync(paths.runtime))
        seedTree(paths.runtime, runtime);
      if (fs.existsSync(legacySettings)) {
        try {
          const profileBackup = path.join(paths.control, 'legacy-startup-backup', 'profile');
          transfers.push(
            transferTree(legacySettings, profileBackup, [
              'Updates',
              'data-location.json',
              'data-location.ini',
              'migration.json',
              'update-install.log',
              'lockfile',
              'bootstrap-location.json',
            ]),
          );
          seedTree(profileBackup, runtime);
        } catch (error) {
          if (!located) throw error;
          warnings.push('旧资料已保留：' + String(error));
        }
      }
    },
    complete(active: string) {
      // 先由原迁移逻辑核验并激活业务目录，随后才导入旧更新包和安装日志，不能污染待核验清单。
      const adopt = (source: string, target: string, exclude: string[] = []) => {
        try {
          transfers.push(transferTree(source, target, exclude));
        } catch (error) {
          warnings.push('旧资料无法自动转移，已保留：' + String(error));
        }
      };
      adopt(path.join(legacySettings, 'Updates'), dataPaths(active).updates);
      const oldLog = path.join(legacySettings, 'update-install.log');
      if (fs.existsSync(oldLog)) {
        const target = path.join(
          dataPaths(active).control,
          'legacy-startup-backup',
          'update-log',
          'update-install.log',
        );
        adopt(
          legacySettings,
          path.dirname(target),
          fs.readdirSync(legacySettings).filter((name) => name !== 'update-install.log'),
        );
      }
      for (const entry of legacyAuxiliary) {
        if (!entry.installerCache) adopt(entry.source, path.join(active, entry.target));
        else
          try {
            transfers.push(transferInstallerCache(entry.source, dataPaths(active).updates));
          } catch (error) {
            warnings.push('旧安装缓存无法自动转移，已保留：' + String(error));
          }
      }
      locator.write(active);
      for (const transfer of transfers) {
        try {
          finishTransfer(transfer);
        } catch (error) {
          warnings.push('旧资料清理未完成：' + String(error));
        }
      }
      const lock = path.join(legacySettings, 'lockfile');
      try {
        if (
          fs.existsSync(lock) &&
          fs.lstatSync(plainPath(lock)).isFile() &&
          fs.statSync(lock).size === 0
        )
          fs.unlinkSync(lock);
      } catch (error) {
        warnings.push('旧运行锁文件仍被占用：' + String(error));
      }
      try {
        if (fs.existsSync(legacySettings) && fs.readdirSync(legacySettings).length === 0)
          fs.rmdirSync(legacySettings);
      } catch (error) {
        warnings.push('旧目录仍被占用，已保留空目录：' + String(error));
      }
      return warnings.join('；') || undefined;
    },
  };
}
function requireHash(file: string) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 用户明确选择恢复已有目录后，先备份原始位置记录再重建，数据库不做重置。 */
export function recoverDataHome(raw: string) {
  const directory = validateExistingDirectory(raw),
    paths = dataPaths(directory);
  const backup = path.join(directory, 'backups', 'location-recovery-' + randomUUID());
  for (const name of ['data-location.json', 'migration.json', 'data-location.ini']) {
    const file = plainPath(path.join(paths.control, name));
    if (!fs.existsSync(file)) continue;
    fs.mkdirSync(backup, { recursive: true });
    const copy = path.join(backup, name);
    fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
    if (requireHash(file) !== requireHash(copy)) throw new Error('原始位置记录备份校验失败');
  }
  const manager = new DataDirectory(paths.control, directory, [], true);
  manager.selectExisting(directory);
  const journal = plainPath(path.join(paths.control, 'migration.json'));
  if (fs.existsSync(journal)) fs.unlinkSync(journal);
  return directory;
}
