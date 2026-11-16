import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { withNsisTemplate } from './prepare-nsis.mjs';
const require = createRequire(import.meta.url);
await withNsisTemplate(async () => {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [require.resolve('electron-builder/cli.js'), ...process.argv.slice(2)],
      { stdio: 'inherit', windowsHide: true },
    );
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
});
