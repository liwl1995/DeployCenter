// @vitest-environment node
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

const compiler = process.env.DEPLOY_CENTER_NSIS || path.join(process.env.LOCALAPPDATA || '',
  'electron-builder/Cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/Bin/makensis.exe');

it.skipIf(process.platform !== 'win32' || !existsSync(compiler)).each([
  '已安装记录恢复预填', '保留显式路径', '不接受卸载器指向其他目录',
])('隔离 NSIS 原安装目录识别（%s）', async (scenario) => {
  const testRoot = path.resolve('.test-data');
  await fs.mkdir(testRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testRoot, 'installer-upgrade-path-'));
  const location = path.join(root, '已装 软件');
  const defaultDir = path.join(root, '默认位置');
  const explicit = path.join(root, '指定位置');
  const mismatched = scenario === '不接受卸载器指向其他目录';
  const override = scenario === '保留显式路径' ? explicit : '';
  const key = 'Software\\YOTOO\\DeployCenter.Tests\\' + randomUUID();
  const source = path.join(root, 'check.nsi');
  const output = path.join(root, 'check.exe');
  const result = path.join(root, 'result.txt');
  try {
    await fs.mkdir(path.join(location, 'resources'), { recursive: true });
    await Promise.all(['YOTOO.exe', 'Uninstall YOTOO.exe', 'resources/app.asar'].map((file) =>
      fs.writeFile(path.join(location, file), 'fixture')));
    const implementation = (await fs.readFile('installer/custom.nsh', 'utf8')).match(
      /!macro DC_PreviousDirectoryFunction[\s\S]*?!macroend/,
    );
    expect(implementation).toBeTruthy();
    await fs.writeFile(source, `Unicode true
!include LogicLib.nsh
RequestExecutionLevel user
SilentInstall silent
OutFile "${output}"
InstallDir "${override || defaultDir}"
!define INSTALL_REGISTRY_KEY "${key}\\Install"
!define UNINSTALL_REGISTRY_KEY "${key}\\Uninstall"
!define APP_EXECUTABLE_FILENAME "YOTOO.exe"
Var DC_PreviousDir
!macro GetDParameter out
  StrCpy \${out} "${override}"
!macroend
${implementation![0]}
!insertmacro DC_PreviousDirectoryFunction
Section
  WriteRegStr HKCU "${key}\\Install" InstallLocation ""
  WriteRegStr HKCU "${key}\\Uninstall" InstallLocation "${location}"
  WriteRegStr HKCU "${key}\\Uninstall" UninstallString '"${mismatched ? defaultDir : location}\\Uninstall YOTOO.exe" /currentuser'
  Call DC_ReadPreviousDirectory
  FileOpen $0 "${result}" w
  FileWriteUTF16LE $0 "$DC_PreviousDir$\\r$\\n$INSTDIR"
  FileClose $0
  DeleteRegKey HKCU "${key}"
SectionEnd
`);
    const build = spawnSync(compiler, ['/INPUTCHARSET', 'UTF8', '/V2', '/WX', source], { windowsHide: true, encoding: 'utf8' });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const run = spawnSync(output, [], { windowsHide: true, timeout: 15000 });
    expect(run.status).toBe(0);
    expect((await fs.readFile(result)).toString('utf16le').replace(/^\uFEFF/, '').split('\r\n')).toEqual([
      mismatched ? '' : location,
      override || (mismatched ? defaultDir : location),
    ]);
  } finally {
    if (/^Software\\YOTOO\\DeployCenter\.Tests\\[a-f0-9-]{36}$/.test(key))
      spawnSync(path.join(process.env.SystemRoot!, 'System32/reg.exe'), ['delete', 'HKCU\\' + key, '/f'], { windowsHide: true });
    if (path.dirname(root) === testRoot) await fs.rm(root, { recursive: true, force: true });
  }
}, 20000);
