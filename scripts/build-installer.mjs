import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { withNsisTemplate } from './prepare-nsis.mjs';
const require = createRequire(import.meta.url);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'yotoo-installer-ui-'));
try {
  await withNsisTemplate(async () => {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--require', path.resolve('scripts/electron-installer-payload.cjs'), require.resolve('electron-builder/cli.js'), ...process.argv.slice(2)],
        { stdio: 'inherit', windowsHide: true, env: {
          ...process.env,
          YOTOO_INSTALLER_BUILD_TEMP: temporary,
        } },
      );
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
    process.exitCode = code;
  });
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
