// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inspectImageArchive } from '../electron/image-archive';
import { checkImageImport } from '../electron/image-import';
import { ImageJobs } from '../electron/images';
import type { Transport } from '../electron/ssh';
import type { ImageCheck, ImageJob } from '../src/images';
import { seed } from '../src/model';

const base = path.resolve('.test-data');
const label = 'yotoo/crm:2.2.0';
const config = Buffer.from('{"os":"linux","architecture":"amd64"}');
const imageId = 'sha256:' + createHash('sha256').update(config).digest('hex');
const home = "/home/team's fixtures";
const remoteDirectory = home + '/.deploy-center/image-imports';
let dir: string;

function tar(entries: [name: string, content: Buffer][]) {
  return Buffer.concat([
    ...entries.flatMap(([name, content]) => {
      const header = Buffer.alloc(512);
      header.write(name);
      header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
      header.fill(32, 148, 156);
      header[156] = 48;
      header.write('ustar\0', 257);
      header.write(
        header
          .reduce((sum, byte) => sum + byte, 0)
          .toString(8)
          .padStart(6, '0') + '\0 ',
        148,
      );
      return [header, content, Buffer.alloc((512 - (content.length % 512)) % 512)];
    }),
    Buffer.alloc(1024),
  ]);
}

function saveFixture(tags: string[] = [label], extra: [string, Buffer][] = []) {
  return tar([
    ['config.json', config],
    ['layer.tar', Buffer.alloc(512)],
    [
      'manifest.json',
      Buffer.from(
        JSON.stringify([{ Config: 'config.json', RepoTags: tags, Layers: ['layer.tar'] }]),
      ),
    ],
    ...extra,
  ]);
}

beforeEach(async () => {
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(path.join(base, 'image-tools-'));
});
afterEach(async () => {
  if (dir.startsWith(base + path.sep)) await rm(dir, { recursive: true, force: true });
});

it('可从镜像包列表取消刚启动的构建，保留取消记录且不发布镜像包', async () => {
  const changes: ImageJob[] = [];
  const manager = new ImageJobs(dir, { job: (value) => changes.push(structuredClone(value)), log: vi.fn() });
  const db = seed();
  const first = manager.build({
    serviceId: db.services[0].id,
    engine: { kind: 'windows' },
    mode: 'existing',
    dockerfile: path.join(dir, 'Dockerfile'),
    context: dir,
    reference: label,
    platform: 'linux/amd64',
  }, db.services[0], db);
  expect(() => manager.cancelBuild(randomUUID())).toThrow('镜像构建');
  manager.cancelBuild(first.id);
  await vi.waitFor(() => expect(manager.busy()).toBe(false));
  expect(changes.some((job) => job.status === 'running' && job.cancelling)).toBe(true);
  expect((await manager.list())[0]).toMatchObject({ status: 'cancelled', message: expect.stringContaining('未生成镜像包') });
  expect((await manager.list())[0].archive).toBeUndefined();
  expect((await manager.logs(first.id)).map((chunk) => chunk.text).join('')).toContain('镜像构建已取消');
  await expect(stat(path.join(manager.directory, first.id, 'export.partial.tar'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('读取单标签 Docker 归档、gzip、平台及真实配置摘要，拒绝多标签和越界条目', async () => {
  const plain = path.join(dir, 'ready.tar'),
    compressed = plain + '.gz';
  await writeFile(plain, saveFixture());
  await writeFile(compressed, gzipSync(saveFixture()));
  const first = await inspectImageArchive(plain);
  expect(first).toMatchObject({
    reference: label,
    platform: 'linux/amd64',
    imageId,
    hash: createHash('sha256').update(saveFixture()).digest('hex'),
  });
  expect(await inspectImageArchive(compressed)).toMatchObject({ reference: label, imageId });
  await writeFile(plain, saveFixture([label, 'yotoo/other:latest']));
  await expect(inspectImageArchive(plain)).rejects.toThrow('一个标签');
  await writeFile(plain, saveFixture([label], [['../escape', Buffer.alloc(1)]]));
  await expect(inspectImageArchive(plain)).rejects.toThrow('TAR 路径');
  await writeFile(plain, saveFixture().subarray(0, -513));
  await expect(inspectImageArchive(plain)).rejects.toThrow('不完整');
});

it('识别新版 Docker 归档的嵌套 OCI 索引，拒绝不同标签的描述符', async () => {
  const file = path.join(dir, 'oci.tar');
  const digest = (bytes: Buffer) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));
  const manifest = json({ config: { digest: imageId } });
  const manifestId = digest(manifest);
  const index = json({ manifests: [{ digest: manifestId }] });
  const indexId = digest(index);
  const archive = (reference: string) =>
    saveFixture(
      [label],
      [
        ['blobs/sha256/' + manifestId.slice(7), manifest],
        ['blobs/sha256/' + indexId.slice(7), index],
        [
          'index.json',
          json({
            manifests: [
              { digest: indexId, annotations: { 'io.containerd.image.name': reference } },
            ],
          }),
        ],
      ],
    );
  await writeFile(file, archive('docker.io/' + label));
  expect(await inspectImageArchive(file)).toMatchObject({
    imageId,
    manifestIds: [indexId, manifestId],
  });
  await writeFile(file, archive('docker.io/yotoo/other:2.2.0'));
  await expect(inspectImageArchive(file)).rejects.toThrow('OCI 标签');
});

it('预检拒绝不兼容平台或同名不同镜像，命令中没有创建或上传动作', async () => {
  const file = path.join(dir, 'ready.tar');
  await writeFile(file, saveFixture());
  const archive = await inspectImageArchive(file);
  const exec = vi
    .fn()
    .mockResolvedValue({
      code: 0,
      stdout: remoteDirectory + '\nlinux/aarch64\n100000\n',
      stderr: '',
    });
  const transport = { exec } as unknown as Transport;
  await expect(checkImageImport(transport, '测试服务器', archive)).rejects.toThrow('linux/arm64');
  exec.mockResolvedValueOnce({
    code: 0,
    stdout: remoteDirectory + '\nlinux/x86_64\n100000\nsha256:' + 'f'.repeat(64),
    stderr: '',
  });
  await expect(checkImageImport(transport, '测试服务器', archive)).rejects.toThrow('已有不同');
  expect(exec.mock.calls[0][0]).not.toMatch(/mkdir|image load|rm -/);
});

it.each(['success', 'wrong-image', 'cancel'] as const)(
  '导入 %s 时按核验结果清理或保留现场',
  async (scenario) => {
    const file = path.join(dir, 'ready.tar'),
      id = randomUUID();
    await writeFile(file, saveFixture());
    const archive = await inspectImageArchive(file);
    const check: ImageCheck = {
      archive,
      server: '测试服务器',
      free: 100_000_000,
      remoteDirectory,
      uploadFile: remoteDirectory + '/' + id + '/image.tar',
      alreadyPresent: false,
    };
    const calls: string[] = [];
    const transport = {
      connect: async () => {},
      close: () => {},
      read: async () => Buffer.alloc(0),
      exec: async (command: string) => {
        const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
        if (command.includes('docker.sock info')) {
          calls.push('check');
          return ok(remoteDirectory + '\nlinux/x86_64\n100000\n');
        }
        if (command.includes('mkdir --')) {
          calls.push('mkdir');
          return ok(check.uploadFile);
        }
        if (command.includes('actual="$(sha256sum')) {
          calls.push('hash');
          return ok();
        }
        if (command.includes('image inspect')) {
          calls.push('verify');
          return ok(
            (scenario === 'wrong-image' ? 'sha256:' + 'e'.repeat(64) : imageId) + ' linux/amd64',
          );
        }
        if (command.includes('rmdir --')) {
          calls.push('clean');
          return ok();
        }
        throw new Error('unexpected command');
      },
      upload: async (_file, remote, progress, signal) => {
        calls.push('upload');
        expect(remote).toBe(check.uploadFile);
        progress(archive.size);
        if (scenario === 'cancel') jobs.cancelUpload(id);
        signal?.throwIfAborted();
      },
      channel: async (command: string) => {
        calls.push('load');
        expect(command).toContain('flock -x');
        expect(command).toContain('image load --input');
        const output = new PassThrough();
        output.end('Loaded image: ' + label);
        return {
          input: new PassThrough(),
          output,
          error: new PassThrough(),
          done: Promise.resolve(0),
          stop: () => {},
        };
      },
    } satisfies Transport;
    let finished!: (value: ImageJob) => void;
    const done = new Promise<ImageJob>((resolve) => {
      finished = resolve;
    });
    const jobs = new ImageJobs(dir, {
      job: (job) => {
        if (job.status !== 'running') finished(job);
      },
      log: () => {},
    });
    jobs.import(id, { file }, check.server, async () => ({ transport }), check);
    const result = await done;
    expect((await jobs.list())[0].status).toBe(result.status);
    expect((await jobs.logs(id)).map(({ text }) => text).join('')).toContain('上传到：');
    if (scenario === 'cancel') {
      expect(result).toMatchObject({ status: 'cancelled', remoteFile: undefined });
      expect(calls).toEqual(['check', 'mkdir', 'upload', 'clean']);
    } else {
      expect(calls).toEqual([
        'check',
        'mkdir',
        'upload',
        'hash',
        'load',
        'verify',
        ...(scenario === 'success' ? ['clean'] : []),
      ]);
      expect(result.status).toBe(scenario === 'success' ? 'success' : 'failed');
      expect(result.remoteFile).toBe(scenario === 'success' ? undefined : check.uploadFile);
    }
  },
);
