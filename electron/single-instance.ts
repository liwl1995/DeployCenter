import net from 'node:net';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';

/** Windows 命名管道不落磁盘，实例身份不随数据迁移改变；测试和开发身份独立。 */
export async function singleInstance(identity: string, activate: () => void) {
  const name =
    '\\\\.\\pipe\\yotoo-deploy-' +
    createHash('sha256')
      .update(userInfo().username + ':' + userInfo().homedir + ':' + identity)
      .digest('hex');
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      activate();
      socket.end();
    });
    socket.on('error', () => {});
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(name, resolve);
    });
    return { primary: true, close: () => server.close() };
  } catch (error) {
    server.close();
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    await new Promise<void>((resolve, reject) => {
      const client = net.connect(name, () => client.end('activate'));
      client.setTimeout(3000, () => client.destroy(new Error('已有实例未响应，请稍后重试')));
      client.once('error', reject);
      client.once('close', () => resolve());
    });
    return { primary: false, close: () => {} };
  }
}
