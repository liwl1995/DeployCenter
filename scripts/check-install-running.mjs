import { _electron as electron } from '@playwright/test';
import { spawn } from 'node:child_process';
const [executablePath, installer, dataDir] = process.argv.slice(2);
const env = { ...process.env, DEPLOY_CENTER_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath, args: [], env });
try {
  await app.firstWindow();
  const code = await new Promise((resolve, reject) => {
    const child = spawn(installer, ['/S'], { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 1602 || app.process().exitCode !== null) throw new Error('运行保护失败：' + code);
  console.log('guard-ok：安装器拒绝覆盖且原应用仍正常运行');
} finally {
  await app.close();
}
