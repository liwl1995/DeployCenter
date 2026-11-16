import fs from 'node:fs/promises';
import path from 'node:path';

/** 框架没有禁用安装包自缓存的选项；只移除这一条复制，模板变化时停止构建供人工核对。 */
export function withoutInstallerCache(source) {
  const instruction =
    '!insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"';
  if (source.split(instruction).length !== 2)
    throw new Error('NSIS 框架缓存模板已变化，必须核对后再构建安装包');
  return source.replace(instruction, '; 应用使用配置目录内的更新缓存，不再保存框架的额外副本。');
}
/** 打包期间限定修改单个依赖模板，完成或失败均还原；独占锁阻止两次打包互相覆盖。 */
export async function withNsisTemplate(action, project = process.cwd()) {
  const template = path.join(
    project,
    'node_modules/app-builder-lib/templates/nsis/include/installer.nsh',
  );
  const original = await fs.readFile(template),
    updated = Buffer.from(withoutInstallerCache(original.toString('utf8')));
  const lock = await fs.open(template + '.yotoo-lock', 'wx');
  try {
    await fs.writeFile(template, updated);
    return await action();
  } finally {
    const current = await fs.readFile(template);
    if (!current.equals(updated) && !current.equals(original)) {
      await lock.close();
      throw new Error('构建中 NSIS 模板被外部修改，已保留锁，请核对依赖后恢复');
    }
    await fs.writeFile(template, original);
    await lock.close();
    await fs.unlink(template + '.yotoo-lock');
  }
}
