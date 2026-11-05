import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
await viteBuild();
await fs.mkdir('dist-electron', { recursive: true });
await build({
  entryPoints: [
    'electron/main.ts',
    'electron/preload.ts',
    'electron/worker.ts',
    'electron/history-search.ts',
  ],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  packages: 'external',
  loader: { '.sh': 'text' },
  define: { __PROTOTYPE__: 'false' },
  sourcemap: true,
});
console.log('Built Vite renderer, Electron main/preload and utilityProcess engine.');
