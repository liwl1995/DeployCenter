import fs from 'node:fs/promises';
import path from 'node:path';

function replaceOnce(source, instruction, replacement) {
  if (source.split(instruction).length !== 2)
    throw new Error('NSIS 框架模板已变化，必须核对指令后再构建安装包：' + instruction);
  return source.replace(instruction, replacement);
}
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
      'Call DC_CopyPreparedProgram',
    )
    .concat(newline, [
      '!macro DC_PrepareEmbeddedProgram',
      '  !ifdef APP_BUILD_DIR',
      '    !error "YOTOO 安装器只支持先解压再验证的离线安装包"',
      '  !endif',
      '  !ifdef APP_PACKAGE_URL',
      '    !error "YOTOO 安装器只支持先解压再验证的离线安装包"',
      '  !endif',
      '  !ifdef ZIP_COMPRESSION',
      '    !error "YOTOO 安装器只支持 7z 安装包"',
      '  !endif',
      '  !insertmacro DC_InstallStage 2 "正在解压程序文件"',
      '  Call DC_StageElectronRuntime',
      '  ' + extraction,
      '  !insertmacro DC_InstallStage 3 "正在校验新版程序"',
      '  Call DC_VerifyPreparedProgram',
      '!macroend',
      '',
    ].join(newline));
}
function stageProgramExecutable(source) {
  // 只在 NSIS 私有目录中解包，验证通过前不运行旧版卸载器。
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const marker = '!macro extractUsing7za FILE' + newline;
  if (source.split(marker).length !== 2 || !source.trimEnd().endsWith('DoneExtract7za:' + newline + '!macroend'))
    throw new Error('NSIS 解包模板已变化，必须核对后再构建安装包');
  return source.slice(0, source.indexOf(marker)) + [
    '!macro extractUsing7za FILE',
    '  SetOutPath "$PLUGINSDIR\\7z-out"',
    '  Nsis7z::Extract "${FILE}"',
    '  SetOutPath "$PLUGINSDIR"',
    '!macroend',
    '',
  ].join(newline);
}
function protectProgramLaunch(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const uninstall = '!insertmacro uninstallOldVersion SHELL_CONTEXT';
  const install = '!insertmacro installApplicationFiles';
  const guarded = replaceOnce(source, uninstall, [
    '!insertmacro DC_PrepareEmbeddedProgram', 'Call DC_WithdrawProgram', uninstall,
  ].join(newline));
  const published = replaceOnce(guarded, install, install + newline + 'Call DC_PublishProgram');
  const destination = replaceOnce(published, 'SetOutPath $INSTDIR', 'Call DC_PrepareProgramDestination');
  const shortcuts = [
    '!insertmacro addStartMenuLink $keepShortcuts',
    '!insertmacro addDesktopLink $keepShortcuts',
  ].join(newline);
  return replaceOnce(destination, shortcuts, '; Windows 快捷方式由 customInstall 统一写入。');
}
function preserveUpgradeShortcuts(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const options = '  !insertMacro setIsTryToKeepShortcuts';
  const sameDirectory = [
    options,
    '  ${If} $DC_ProgramWithdrawn == "1"',
    '  ${AndIf} $DC_OldExecutable == "${APP_EXECUTABLE_FILENAME}"',
    '  ${AndIf} $DC_BackupSource == $installationDir',
    '  ${AndIf} $installationDir == $INSTDIR',
    '    StrCpy $isTryToKeepShortcuts "true"',
    '  ${EndIf}',
  ].join(newline);
  const previous = [
    '    ${andIf} ${FileExists} "$appExe"',
    '      StrCpy $0 "$0 --keep-shortcuts"',
  ].join(newline);
  // 旧入口在卸载前已下线，原目录升级仍须保留 Windows 快捷方式和固定项。
  return replaceOnce(replaceOnce(source, options, sameDirectory), previous, [
    '      ${If} $DC_ProgramWithdrawn == "1"',
    '      ${AndIf} $DC_OldExecutable == "${APP_EXECUTABLE_FILENAME}"',
    '      ${AndIf} $DC_BackupSource == $installationDir',
    '      ${AndIf} $installationDir == $INSTDIR',
    '        StrCpy $0 "$0 --keep-shortcuts"',
    '      ${ElseIf} ${FileExists} "$appExe"',
    '        StrCpy $0 "$0 --keep-shortcuts"',
    '      ${EndIf}',
  ].join(newline));
}
function useUninstallConfirmation(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return replaceOnce(source, '!insertmacro MUI_UNPAGE_COMPONENTS', [
    'PageEx un.custom',
    '  PageCallbacks un.DC_ShowUninstallConfirm un.DC_LeaveUninstallConfirm',
    'PageExEnd',
  ].join(newline));
}

function styleUninstallProgress(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const page = '!insertmacro MUI_UNPAGE_INSTFILES';
  return replaceOnce(source, page, [
    '!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.DC_ShowUninstallProgress',
    '!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.DC_LeaveUninstallProgress',
    page,
  ].join(newline));
}

function verifyUninstallRemoval(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const removal = '    RMDir /r $INSTDIR';
  return replaceOnce(source, removal, removal + newline + '    Call un.DC_CheckProgramRemoval');
}

/** 打包期间修改所需模板，完成或失败均还原；独占锁阻止两次打包互相覆盖。 */
export async function withNsisTemplate(action, project = process.cwd()) {
  const directory = path.join(project, 'node_modules/app-builder-lib/templates/nsis');
  const changes = [
    ['include/installer.nsh', withoutInstallerCache],
    ['include/extractAppPackage.nsh', stageProgramExecutable],
    ['include/installUtil.nsh', preserveUpgradeShortcuts],
    ['installSection.nsh', protectProgramLaunch],
    ['installer.nsi', useUninstallConfirmation],
    ['assistedInstaller.nsh', styleUninstallProgress],
    ['uninstaller.nsh', verifyUninstallRemoval],
  ];
  const lockFile = path.join(directory, 'include/installer.nsh.yotoo-lock');
  const lock = await fs.open(lockFile, 'wx');
  const templates = [];
  try {
    for (const [relative, transform] of changes) {
      const file = path.join(directory, relative);
      const original = await fs.readFile(file);
      const updated = Buffer.from(transform(original.toString('utf8')));
      templates.push({ file, original, updated });
      await fs.writeFile(file, updated);
    }
    return await action();
  } finally {
    let restored = false;
    try {
      const modified = [];
      for (const { file, original, updated } of templates) {
        const current = await fs.readFile(file);
        if (current.equals(updated)) await fs.writeFile(file, original);
        else if (!current.equals(original)) modified.push(file);
      }
      if (modified.length)
        throw new Error('构建中 NSIS 模板被外部修改，已保留锁：' + modified.join(', '));
      restored = true;
    } finally {
      await lock.close();
      if (restored) await fs.unlink(lockFile);
    }
  }
}
