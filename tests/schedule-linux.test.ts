// @vitest-environment node
import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Server as SshServer, utils, type Connection } from 'ssh2';
import { ZipWriter, BlobWriter, TextReader } from '@zip.js/zip.js';
import { Storage } from '../electron/storage';
import { Controller } from '../electron/controller';
import { Deployment } from '../electron/deployment';
import { ReleaseScheduler } from '../electron/scheduler';
import { seed, shellQuote as q } from '../src/model';

const distro = process.env.DEPLOY_CENTER_TEST_WSL;
function linux(script: string) {
  return new Promise<{ code: number; out: string; error: string }>((resolve, reject) => {
    const child = spawn('wsl.exe', ['-d', distro!, '--', '/bin/bash', '-s'], { windowsHide: true });
    let out = '',
      error = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Linux 夹具超时'));
    }, 30000);
    child.stdout.on('data', (b) => (out += b.toString()));
    child.stderr.on('data', (b) => (error += b.toString()));
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out, error });
    });
    child.stdin.end(script);
  });
}
async function run(script: string) {
  const result = await linux(script);
  if (result.code) throw new Error(result.error || result.out);
  return result.out.trim();
}

it.skipIf(process.platform !== 'win32' || !distro)(
  '定时计划通过真实回环 SSH/SFTP 在隔离 Linux 部署固定快照（无业务服务）',
  async () => {
    const remote = await run('mktemp -d /tmp/deploy-center-schedule.XXXXXXXX');
    if (!/^\/tmp\/deploy-center-schedule\.[A-Za-z0-9]+$/.test(remote))
      throw new Error('远端夹具目录越界');
    await fs.mkdir(path.resolve('.test-data'), { recursive: true });
    const dir = await fs.mkdtemp(path.resolve('.test-data/schedule-linux-'));
    const clients = new Set<Connection>();
    let uploads = 0;
    const host = utils.generateKeyPairSync('ed25519');
    const server = new SshServer({ hostKeys: [host.private] }, (client) => {
      clients.add(client);
      client.on('close', () => clients.delete(client));
      client.on('error', () => {});
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.password === 'isolated-fixture') ctx.accept();
        else ctx.reject();
      });
      client.on('ready', () =>
        client.on('session', (accept) => {
          const session = accept();
          session.on('exec', (accept, _reject, info) => {
            const stream = accept();
            stream.on('error', () => {});
            const child = spawn('wsl.exe', ['-d', distro!, '--', '/bin/bash', '-c', info.command], {
              windowsHide: true,
            });
            // WSL 命令会话退出可能结束其后台进程；网关等待同一 shell 的 runner 完成。
            stream.on('data', (data: Buffer) => child.stdin.write(data));
            stream.on('end', () =>
              child.stdin.end(info.command === 'bash -s' ? '\nwait\n' : undefined),
            );
            child.stdin.on('error', () => {});
            child.stdout.pipe(stream, { end: false });
            child.stderr.pipe(stream.stderr, { end: false });
            child.on('close', (code) => {
              stream.exit(code ?? 1);
              stream.end();
            });
          });
          session.on('sftp', (accept) => {
            const sftp = accept();
            const files = new Map<string, { file: string; data: Buffer }>();
            sftp.on('OPEN', (id, file) => {
              if (!file.startsWith(remote + '/') || file.includes('..')) {
                sftp.status(id, 3);
                return;
              }
              const handle = Buffer.from(String(id));
              files.set(handle.toString(), { file, data: Buffer.alloc(0) });
              sftp.handle(id, handle);
            });
            sftp.on('WRITE', (id, handle, offset, data) => {
              const file = files.get(handle.toString())!;
              const next = Buffer.alloc(Math.max(file.data.length, offset + data.length));
              file.data.copy(next);
              data.copy(next, offset);
              file.data = next;
              sftp.status(id, 0);
            });
            sftp.on('CLOSE', (id, handle) => {
              const file = files.get(handle.toString())!;
              files.delete(handle.toString());
              void run(
                'umask 077; set -C; printf %s ' +
                  q(file.data.toString('base64')) +
                  ' | base64 -d > ' +
                  q(file.file),
              ).then(
                () => {
                  uploads++;
                  sftp.status(id, 0);
                },
                () => sftp.status(id, 4),
              );
            });
          });
        }),
      );
    });
    let storage: Storage | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      storage = new Storage(dir, {
        encrypt: async (s) => Buffer.from(s),
        decrypt: async (b) => b.toString(),
      });
      const store = storage;
      const db = seed(),
        service = db.services[0],
        target = db.targets[0],
        hostConfig = db.servers.find((s) => s.id === target.serverId)!;
      db.history = [];
      db.taskHistory = {};
      service.root = dir;
      service.jarDir = '.';
      service.jarName = 'fixture.jar';
      Object.assign(hostConfig, {
        auth: 'password',
        host: '127.0.0.1',
        port,
        user: 'fixture',
        credentialMode: 'windows',
      });
      Object.assign(target, {
        production: false,
        mode: 'jar',
        directory: remote,
        fileName: 'service.jar',
        stop: 'printf stopped >> ' + q(remote + '/commands.log'),
        start: 'printf started >> ' + q(remote + '/commands.log'),
        restart: '',
        health: { type: 'none', value: '', timeout: 1, retries: 1, interval: 1 },
        backup: { ...target.backup, enabled: true, directory: remote + '/backups' },
      });
      store.saveConfig(db);
      await store.saveCredential(hostConfig.id, 'isolated-fixture');
      const parsed = utils.parseKey(host.private);
      if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('无效测试密钥');
      const publicKey = parsed.getPublicSSH();
      store.trust('127.0.0.1:' + port, {
        key: publicKey.toString('base64'),
        fingerprint:
          'SHA256:' + createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, ''),
      });
      const zip = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
      await zip.add('META-INF/MANIFEST.MF', new TextReader('Manifest-Version: 1.0\r\n'));
      await fs.writeFile(
        path.join(dir, 'fixture.jar'),
        Buffer.from(await (await zip.close()).arrayBuffer()),
      );
      await run('printf old > ' + q(remote + '/service.jar'));
      let completed: (() => void) | undefined;
      const controller = new Controller(
        store,
        (onMessage) => {
          let engine: Deployment;
          let handoff: ((error?: string) => void) | undefined;
          let dispatch: ((error?: string) => void) | undefined;
          return {
            send: (message) => {
              if (message.kind === 'begin') {
                engine = new Deployment(
                  message.value,
                  (event) => {
                    onMessage(event);
                    if (event.kind === 'done') completed?.();
                  },
                  async () => false,
                  undefined,
                  (task, targetId, receipt) =>
                    new Promise<void>((resolve, reject) => {
                      handoff = (error) => (error ? reject(new Error(error)) : resolve());
                      onMessage({ kind: 'handoff', task, targetId, receipt });
                    }),
                  (task) =>
                    new Promise<void>((resolve, reject) => {
                      dispatch = (error) => (error ? reject(new Error(error)) : resolve());
                      onMessage({ kind: 'schedule-dispatch', task });
                    }),
                );
                void engine.run();
              } else if (message.kind === 'schedule-dispatch-result') dispatch?.(message.error);
              else if (message.kind === 'handoff-result') handoff?.(message.error);
              else if (message.kind === 'cancel') void engine.cancel();
            },
            close() {},
          };
        },
        () => {},
      );
      const ready = new Promise<void>((resolve) => {
        completed = resolve;
      });
      const pending = await controller.prepare({
        serviceId: service.id,
        targetIds: [target.id],
        build: 'existing',
        overrides: {},
        failurePolicy: 'stop',
      });
      await controller.start(
        pending.token,
        {},
        { productionWord: '', allowWeak: false, protectCurrent: true },
        { at: Date.now() + 600000 },
      );
      await ready;
      const plan = store.schedules()[0];
      expect(plan.state, JSON.stringify(store.task(plan.preparationId))).toBe('ready');
      expect(uploads).toBe(0);
      expect(await run('find ' + q(remote) + ' -mindepth 1 -maxdepth 1 -printf "%f\\n"')).toBe(
        'service.jar',
      );
      const fixedHash = plan.task.artifact.sha256;
      await fs.writeFile(path.join(dir, 'fixture.jar'), 'changed after preparation');
      plan.scheduledAt = Date.now() - 1;
      store.saveSchedule(plan);
      const published = new Promise<void>((resolve) => {
        completed = resolve;
      });
      const scheduler = new ReleaseScheduler(
        store,
        controller,
        () => false,
        () => {},
      );
      await scheduler.tick();
      await published;
      const result = store.schedules()[0];
      expect(result.state, JSON.stringify(store.task(result.taskId!))).toBe('completed');
      expect(store.task(result.taskId!)?.status, JSON.stringify(store.task(result.taskId!))).toBe(
        'success',
      );
      expect(uploads).toBe(1);
      expect((await run('sha256sum -- ' + q(remote + '/service.jar'))).split(' ')[0]).toBe(
        fixedHash,
      );
      expect(await run('cat -- ' + q(remote + '/commands.log'))).toBe('stoppedstarted');
      expect(store.database().history).toHaveLength(1);
      await run(
        'test ! -e ' +
          q(remote + '/.deploy-center') +
          ' && test ! -e ' +
          q(remote + '/.deploy-center.lock'),
      );
    } finally {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (storage) {
        await storage.settle();
        storage.close();
      }
      await run('rm -rf -- ' + q(remote));
      if (!dir.startsWith(path.resolve('.test-data') + path.sep))
        throw new Error('本地测试目录越界');
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
  120000,
);
