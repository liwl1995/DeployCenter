import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 使用 Windows 自带 .NET Framework 编译器，运行时无需开发工具或额外服务。 */
export async function buildUpdateHelper(
  output = path.resolve('dist-electron/update-helper.exe'),
  source = path.resolve('installer/UpdateHelper.cs'),
) {
  if (process.platform !== 'win32') return;
  const compiler = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe',
  );
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
