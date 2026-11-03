// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTransport, mustExec } from '../electron/ssh';
import { seed } from '../src/model';
const host = process.env.DEPLOY_CENTER_TEST_SSH_HOST,
  port = Number(process.env.DEPLOY_CENTER_TEST_SSH_PORT || 0);
const enabled =
  !!host &&
  ['127.0.0.1', '::1', 'localhost'].includes(host) &&
  port > 0 &&
  port !== 22 &&
  !!process.env.DEPLOY_CENTER_TEST_SSH_KEY;
if (!enabled)
  console.warn(
    '[SKIP] 未配置回环地址的测试 sshd；跳过真实 sshd 集成。不会使用任何业务服务器配置。',
  );
describe.skipIf(!enabled)('本机专用 sshd 集成（显式指定非 22 端口）', () => {
  it('验证主机指纹，执行命令并用 SFTP 上传含空格中文的临时文件', async () => {
    const dir = path.resolve('.test-data/sshd');
    await fs.mkdir(dir, { recursive: true });
    const local = path.join(dir, 'upload.jar');
    await fs.writeFile(local, 'sshd integration fixture');
    const server = {
      ...seed().servers[0],
      auth: 'key' as const,
      host: host!,
      port,
      user: process.env.DEPLOY_CENTER_TEST_SSH_USER || 'deploy-test',
      keyPath: process.env.DEPLOY_CENTER_TEST_SSH_KEY!,
    };
    const transport = createTransport(server, {
      pins: {},
      trust: async (request) =>
        request.fingerprint === process.env.DEPLOY_CENTER_TEST_SSH_FINGERPRINT,
    });
    const remote = '/tmp/deploy-center-sshd-test-' + Date.now();
    try {
      await transport.connect();
      await mustExec(transport, `mkdir '${remote}'`);
      let sent = 0;
      await transport.upload(local, remote + '/中文 space.jar', (n) => (sent = n));
      expect(sent).toBeGreaterThan(0);
      expect(await mustExec(transport, `cat '${remote}/中文 space.jar'`)).toBe(
        'sshd integration fixture',
      );
      await mustExec(transport, `rm -f '${remote}/中文 space.jar'; rmdir '${remote}'`);
    } finally {
      transport.close();
      await fs.unlink(local);
      await fs.rmdir(dir);
    }
  });
});
