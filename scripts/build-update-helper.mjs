import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 使用 Windows 自带 .NET Framework 编译器，运行时无需开发工具或额外服务。 */
export async function buildUpdateHelper(
  output = path.resolve('dist-electron/update-helper.exe'),
  source = path.resolve('installer/UpdateHelper.cs'),
) {
  if (process.platform !== 'win32') return;
  const windows = process.env.SystemRoot || process.env.windir;
  if (!windows || !path.isAbsolute(windows)) throw new Error('无法定位 Windows 系统目录，请检查 SystemRoot 或 windir');
  const compiler = path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await fs.mkdir(path.dirname(output), { recursive: true });
  execFileSync(
    compiler,
    [
      '/nologo',
      '/target:exe',
      '/optimize+',
      '/reference:System.Windows.Forms.dll',
      '/out:' + output,
      source,
    ],
    { windowsHide: true, stdio: 'pipe' },
  );
  console.log('Built independent Windows update helper.');
}
