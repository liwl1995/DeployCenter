import path from 'node:path';
/** 系统组件只使用 Windows 自身提供的位置，不假设系统安装在某个盘符。 */
export function windowsRoot(env: NodeJS.ProcessEnv = process.env) {
  const root = env.SystemRoot || env.windir;
  if (!root || !path.win32.isAbsolute(root)) throw new Error('无法定位 Windows 系统目录，请检查 SystemRoot 或 windir 环境变量');
  return root;
}
