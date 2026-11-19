import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { z } from 'zod';
import type { ImagePackage } from '../src/images';
import { fileHash } from './files';

export const imageReference = z
  .string()
  .max(240)
  .regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/,
    '请输入完整镜像名称和标签，例如 yotoo/crm:2.2.0',
  );
export const imagePlatform = z.enum(['linux/amd64', 'linux/arm64']);
const metadataLimit = 4 * 1024 * 1024;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const manifestSchema = z.tuple([
  z.object({
    Config: z.string(),
    RepoTags: z.tuple([imageReference]),
    Layers: z.array(z.string()).min(1),
  }),
]);
const blob = (digest: string) => 'blobs/sha256/' + digest.slice(7);
const ociIndex = z.object({
  manifests: z.tuple([
    z.object({
      digest,
      annotations: z.record(z.string(), z.string()).optional(),
    }),
  ]),
});
const ociManifest = z.object({ config: z.object({ digest }) });

function canonicalReference(reference: string) {
  const slash = reference.indexOf('/');
  if (slash < 0) return 'docker.io/library/' + reference;
  const domain = reference.slice(0, slash);
  if (!domain.includes('.') && !domain.includes(':') && domain !== 'localhost')
    return 'docker.io/' + reference;
  if (domain !== 'docker.io' && domain !== 'index.docker.io') return reference;
  const name = reference.slice(slash + 1);
  return 'docker.io/' + (name.includes('/') ? name : 'library/' + name);
}

function tarName(value: string) {
  const name = value.replace(/^\.\//, '').replace(/\/$/, '');
  if (
    !name ||
    /[\\:\0]/.test(name) ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('镜像包包含无法安全读取的 TAR 路径');
  return name;
}

/** 逐块扫描 Docker 归档，只缓存少量元数据，不把镜像层解包到本机。 */
async function scan(file: string, compressed: boolean, wanted: Set<string>) {
  const source = createReadStream(file);
  const unzip = compressed ? createGunzip() : undefined;
  if (unzip) {
    source.on('error', (error) => unzip.destroy(error));
    source.pipe(unzip);
  }
  const entries = new Set<string>();
  const values = new Map<string, Buffer>();
  let header: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let remaining = 0,
    padding = 0,
    zeroHeaders = 0;
  let value: Buffer | undefined,
    valueOffset = 0;
  try {
    for await (const chunk of unzip || source) {
      let data = chunk as Buffer;
      while (data.length) {
        if (zeroHeaders === 2) {
          if (data.some((byte) => byte !== 0)) throw new Error('镜像包包含非标准的尾部数据');
          break;
        }
        if (remaining) {
          const count = Math.min(remaining, data.length);
          if (value) {
            data.copy(value, valueOffset, 0, count);
            valueOffset += count;
          }
          remaining -= count;
          data = data.subarray(count);
          continue;
        }
        if (padding) {
          const count = Math.min(padding, data.length);
          padding -= count;
          data = data.subarray(count);
          continue;
        }
        const count = Math.min(512 - header.length, data.length);
        header = Buffer.concat([header, data.subarray(0, count)]);
        data = data.subarray(count);
        if (header.length !== 512) continue;
        if (header.every((byte) => byte === 0)) {
          zeroHeaders += 1;
          header = Buffer.alloc(0);
          continue;
        }
        if (zeroHeaders) throw new Error('镜像包 TAR 结束块无效');
        const field = (from: number, to: number) =>
          header.toString('utf8', from, to).split('\0')[0];
        const size = field(124, 136).trim();
        const checksum = header.reduce(
          (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
          0,
        );
        const type = header[156];
        const name = tarName([field(345, 500), field(0, 100)].filter(Boolean).join('/'));
        if (Number.parseInt(field(148, 156).trim(), 8) !== checksum || !/^[0-7]+$/.test(size))
          throw new Error('镜像包 TAR 头部无效');
        if (type !== 0 && type !== 48 && type !== 53)
          throw new Error('镜像包包含链接或不受支持的扩展 TAR 条目');
        remaining = Number.parseInt(size, 8);
        if (type === 53 && remaining !== 0) throw new Error('镜像包目录条目无效');
        padding = (512 - (remaining % 512)) % 512;
        value = undefined;
        valueOffset = 0;
        if (type !== 53) {
          if (entries.has(name) || entries.size >= 100_000)
            throw new Error('镜像包条目重复或超出限制');
          entries.add(name);
          if (wanted.has(name)) {
            if (remaining > metadataLimit) throw new Error('镜像包元数据过大');
            values.set(name, (value = Buffer.alloc(remaining)));
          }
        }
        header = Buffer.alloc(0);
      }
    }
    if (zeroHeaders !== 2) throw new Error('镜像包 TAR 内容不完整');
    return { entries, values };
  } finally {
    unzip?.destroy();
    source.destroy();
  }
}

function json(values: Map<string, Buffer>, name: string): unknown {
  try {
    return JSON.parse(values.get(name)!.toString('utf8'));
  } catch {
    throw new Error('镜像包缺少有效的 ' + name);
  }
}

export async function inspectImageArchive(file: string): Promise<ImagePackage> {
  if (!/\.tar(?:\.gz)?$/i.test(file)) throw new Error('请选择 .tar 或 .tar.gz 镜像包');
  const original = await lstat(file);
  if (!original.isFile() || original.size < 2) throw new Error('请选择有效的非空镜像包');
  const fd = await open(file, 'r');
  const magic = Buffer.alloc(2);
  try {
    await fd.read(magic);
  } finally {
    await fd.close();
  }
  const compressed = /\.gz$/i.test(file);
  if (compressed !== (magic[0] === 0x1f && magic[1] === 0x8b))
    throw new Error('镜像包实际压缩格式与扩展名不符');
  const { entries, values } = await scan(
    file,
    compressed,
    new Set(['manifest.json', 'index.json']),
  );
  const manifest = manifestSchema.safeParse(json(values, 'manifest.json'));
  if (!manifest.success) throw new Error('请选择仅包含一个镜像、一个标签的 Docker 镜像包');
  const [{ Config, RepoTags, Layers }] = manifest.data;
  const configName = tarName(Config);
  if (!entries.has(configName) || Layers.some((layer) => !entries.has(tarName(layer))))
    throw new Error('镜像包缺少镜像配置或镜像层');

  // Docker 的新版归档还带有 OCI 索引，不能让索引额外引入镜像或其他标签。
  let indexed: string | undefined;
  const manifestIds: string[] = [];
  if (values.has('index.json')) {
    const index = ociIndex.safeParse(json(values, 'index.json'));
    if (!index.success) throw new Error('镜像包包含多个 OCI 镜像，请只导出一个平台和标签');
    const [{ digest: hash, annotations }] = index.data.manifests;
    const shortTag = RepoTags[0].split(':').at(-1);
    const original = annotations?.['io.containerd.image.name'];
    const tag = annotations?.['org.opencontainers.image.ref.name'];
    const expected = canonicalReference(RepoTags[0]);
    if (
      (tag && tag !== shortTag && canonicalReference(tag) !== expected) ||
      (original && canonicalReference(original) !== expected)
    )
      throw new Error('镜像包中的 OCI 标签与 Docker 标签不一致');
    manifestIds.push(hash);
    indexed = blob(hash);
  }
  const metadata = await scan(
    file,
    compressed,
    new Set(indexed ? [configName, indexed] : [configName]),
  );
  const config = z
    .object({ os: z.string(), architecture: z.string() })
    .parse(json(metadata.values, configName));
  const platform = imagePlatform.safeParse(config.os + '/' + config.architecture);
  if (!platform.success) throw new Error('镜像包只支持 Linux amd64 或 arm64');
  const imageId =
    'sha256:' + createHash('sha256').update(metadata.values.get(configName)!).digest('hex');
  if (indexed) {
    const top = json(metadata.values, indexed);
    const correctDigest = (data: Buffer, hash: string) =>
      'sha256:' + createHash('sha256').update(data).digest('hex') === hash;
    if (!correctDigest(metadata.values.get(indexed)!, manifestIds[0]))
      throw new Error('镜像包中的 OCI 清单摘要无效');
    let manifest = ociManifest.safeParse(top);
    if (!manifest.success) {
      // containerd 的单平台构建也可能由一层镜像索引指向真正的清单。
      const nested = ociIndex.safeParse(top);
      if (!nested.success) throw new Error('镜像包只支持单平台 OCI 镜像');
      const [{ digest: hash, annotations }] = nested.data.manifests;
      if (
        annotations?.['io.containerd.image.name'] ||
        annotations?.['org.opencontainers.image.ref.name']
      )
        throw new Error('镜像包中的嵌套 OCI 清单包含额外标签');
      const name = blob(hash);
      const { values } = await scan(file, compressed, new Set([name]));
      manifest = ociManifest.safeParse(json(values, name));
      if (!correctDigest(values.get(name)!, hash)) throw new Error('镜像包中的 OCI 清单摘要无效');
      manifestIds.push(hash);
    }
    if (!manifest.success || manifest.data.config.digest !== imageId)
      throw new Error('镜像包中的 OCI 配置与 Docker 配置不一致');
  }
  const hash = await fileHash(file);
  const current = await lstat(file);
  if (
    current.size !== original.size ||
    current.mtimeMs !== original.mtimeMs ||
    current.ctimeMs !== original.ctimeMs ||
    current.ino !== original.ino ||
    !current.isFile()
  )
    throw new Error('镜像包在校验时发生变化，请重新选择');
  return {
    path: file,
    name: path.basename(file),
    size: original.size,
    hash,
    reference: RepoTags[0],
    platform: platform.data,
    imageId,
    manifestIds,
  };
}
