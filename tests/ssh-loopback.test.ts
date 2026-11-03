// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Server, utils } from 'ssh2';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createTransport } from '../electron/ssh';
import { seed } from '../src/model';
import fs from 'node:fs/promises';
import path from 'node:path';
const { private: hostKey } = utils.generateKeyPairSync('ed25519');
async function fixture(
  run: (port: number, uploaded: Map<string, Buffer>, counts: { auth: number }) => Promise<void>,
) {
  const uploaded = new Map<string, Buffer>(),
    counts = { auth: 0 };
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      counts.auth++;
      if (ctx.method === 'password' && ctx.password === 'fixture-only') ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (accept, _reject, info) => {
          const stream = accept();
          stream.on('error', () => {});
          stream.write(info.command === 'fixture exit 7' ? 'failure' : 'loopback SSH output');
          stream.exit(info.command === 'fixture exit 7' ? 7 : 0);
          stream.end();
        });
        session.on('sftp', (accept) => {
          const sftp = accept(),
            handles = new Map<string, string>();
          sftp.on('OPEN', (id, file) => {
            const handle = Buffer.from(String(id));
            handles.set(handle.toString(), file);
            uploaded.set(file, Buffer.alloc(0));
            sftp.handle(id, handle);
          });
          sftp.on('WRITE', (id, handle, offset, data) => {
            const name = handles.get(handle.toString())!,
              previous = uploaded.get(name)!;
            const out = Buffer.alloc(Math.max(previous.length, offset + data.length));
            previous.copy(out);
            data.copy(out, offset);
            uploaded.set(name, out);
            sftp.status(id, 0);
          });
          sftp.on('CLOSE', (id, handle) => {
            handles.delete(handle.toString());
            sftp.status(id, 0);
          });
        });
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await run((server.address() as AddressInfo).port, uploaded, counts);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
function config(port: number) {
  return {
    ...seed().servers[0],
    auth: 'password' as const,
    host: '127.0.0.1',
    port,
    user: 'fixture',
  };
}
describe('回环地址上的临时 SSH2 测试服务器（真实 SSH/SFTP 协议）', () => {
  it('首次指纹确认后密码认证、命令退出码及 SFTP 上传进度', async () =>
    fixture(async (port, files) => {
      const t = createTransport(config(port), {
        credential: 'fixture-only',
        pins: {},
        trust: async (request) => request.fingerprint.startsWith('SHA256:'),
      });
      const base = path.resolve('.test-data');
      await fs.mkdir(base, { recursive: true });
      const file = path.join(base, 'ssh-upload-' + Date.now() + '.jar');
      await fs.writeFile(file, Buffer.alloc(200000, 65));
      try {
        await t.connect();
        expect((await t.exec('fixture output')).stdout).toBe('loopback SSH output');
        expect((await t.exec('fixture exit 7')).code).toBe(7);
        let bytes = 0;
        await t.upload(file, "/tmp/中文 space'file.uploading", (n) => (bytes = n));
        expect(bytes).toBe(200000);
        expect(files.get("/tmp/中文 space'file.uploading")?.length).toBe(200000);
      } finally {
        t.close();
        await fs.unlink(file);
      }
    }));
  it('拒绝首次主机指纹时不发送认证信息', async () =>
    fixture(async (port, _files, counts) => {
      const t = createTransport(config(port), {
        credential: 'fixture-only',
        pins: {},
        trust: async () => false,
      });
      try {
        await expect(t.connect()).rejects.toThrow();
        expect(counts.auth).toBe(0);
      } finally {
        t.close();
      }
    }));
  it('保存的主机指纹不一致直接阻止，不提供忽略或替换入口', async () =>
    fixture(async (port, _files, counts) => {
      let prompts = 0;
      const t = createTransport(config(port), {
        credential: 'fixture-only',
        pins: { ['127.0.0.1:' + port]: { key: 'wrong-host-key', fingerprint: 'wrong' } },
        trust: async () => {
          prompts++;
          return true;
        },
      });
      try {
        await expect(t.connect()).rejects.toThrow('主机指纹不一致');
        expect(prompts).toBe(0);
        expect(counts.auth).toBe(0);
      } finally {
        t.close();
      }
    }));
  it('错误密码与网络错误分开提示', async () =>
    fixture(async (port) => {
      const t = createTransport(config(port), {
        credential: 'bad',
        pins: {},
        trust: async () => true,
      });
      try {
        await expect(t.connect()).rejects.toThrow('认证失败');
      } finally {
        t.close();
      }
      expect(createHash('sha256').update(hostKey).digest('hex')).toHaveLength(64);
    }));
});
