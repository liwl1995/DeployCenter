import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildUpdateHelper } from './build-update-helper.mjs';
await viteBuild();
await fs.mkdir('dist-electron', { recursive: true });
const entryPoints = [
  'electron/main.ts',
  'electron/preload.ts',
  'electron/tray-preload.ts',
  'electron/worker.ts',
  'electron/history-search.ts',
];
// 只移除以前生成的入口映射，覆盖构建时也不会留下旧调试文件。
await Promise.all(
  entryPoints.map((file) =>
    fs.rm(path.join('dist-electron', path.basename(file, '.ts') + '.cjs.map'), { force: true }),
  ),
);
await build({
  entryPoints,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  packages: 'external',
  loader: { '.sh': 'text' },
  define: { __PROTOTYPE__: 'false' },
});
await buildUpdateHelper();
console.log('Built Vite renderer, Electron main/preload and utilityProcess engine.');
