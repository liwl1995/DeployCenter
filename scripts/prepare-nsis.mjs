import fs from 'node:fs/promises';
import path from 'node:path';

/** 保留标准安装流程，只关闭额外缓存并挂接展示阶段；关键指令变化时停止构建。 */
export function withoutInstallerCache(source) {
  const instruction =
    '!insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"';
  if (source.split(instruction).length !== 2)
    throw new Error('NSIS 框架缓存模板已变化，必须核对后再构建安装包');
  const extraction = '!insertmacro extractEmbeddedAppPackage';
  if (source.split(extraction).length !== 2)
    throw new Error('NSIS 安装阶段模板已变化，必须核对后再构建安装包');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return source
    .replace(instruction, '; 应用使用配置目录内的更新缓存，不再保存框架的额外副本。')
    .replace(
      extraction,
      '!insertmacro DC_InstallStage 2 "正在解压并安装程序文件"' + newline + '      ' + extraction,
    );
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
