// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppUpdater, latestReleaseUrl } from '../electron/app-updater';
const payload = Buffer.from('MZ cache fixture only');
const hash = createHash('sha256').update(payload).digest('hex');
const base = path.resolve('.test-data');
const dirs: string[] = [];
const key = randomBytes(32);
const protection = {
  async protect(value: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
  },
  async unprotect(value: Buffer) {
    const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
  },
};
function metadata(version = '1.5.7') {
  const name = `YOTOO-DeployCenter-${version}-Windows-x64-Setup.exe`;
  return {
    draft: false,
    prerelease: false,
    tag_name: 'v' + version,
    html_url: 'https://github.com/liwl1995/DeployCenter/releases/tag/v' + version,
    body: '# 更新\n\n- 保留缓存',
    published_at: '2026-11-16',
    assets: [
      {
        name,
        state: 'uploaded',
        size: payload.length,
        digest: 'sha256:' + hash,
        browser_download_url:
          'https://github.com/liwl1995/DeployCenter/releases/download/v' + version + '/' + name,
      },
    ],
  };
}
async function fixture() {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'update-cache-'));
  dirs.push(root);
  const directory = path.join(root, '中文 空格 数据', 'Updates');
  const fetch = vi.fn(async (url: string) =>
    url === latestReleaseUrl ? Response.json(metadata()) : new Response(new Uint8Array(payload)),
  );
  const launch = vi.fn().mockResolvedValue(undefined);
  const create = (protectedReceipt = true) =>
    new AppUpdater({
      currentVersion: '1.5.6',
      directory,
      fetch,
      emit: () => {},
      launch,
      installBlocked: () => undefined,
      ...(protectedReceipt ? { cacheProtection: protection } : {}),
    });
  return { root, directory, fetch, launch, create };
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    if (path.dirname(dir) !== base) throw new Error('测试目录越界');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
it('下载后重建实例，离线验证受保护凭据和文件，直接恢复可安装且不再下载', async () => {
  const f = await fixture(),
    first = f.create();
  await first.check();
  await first.download();
  f.fetch.mockRejectedValue(new Error('离线'));
  const restored = f.create();
  const state = await restored.restore();
  expect(state.stage).toBe('ready');
  expect(state.installerPath).toContain(f.directory);
  expect(state.release?.version).toBe('1.5.7');
  expect(f.fetch).toHaveBeenCalledTimes(2);
  // 默认启动检查即使离线失败，也要保留已恢复的可安装状态。
  expect((await restored.check()).stage).toBe('ready');
  await restored.install();
  expect(f.launch).toHaveBeenCalledTimes(1);
  expect((await restored.location()).file).toBe(state.installerPath);
});
it('旧版只有 setup.exe 也能联网匹配指纹后复用，无需请求安装包', async () => {
  const f = await fixture(),
    first = f.create(false);
  await first.check();
  const downloaded = await first.download();
  const folder = path.dirname(downloaded.installerPath!);
  const old = new Date(Date.now() - 3 * 86400000);
  await fs.utimes(folder, old, old);
  const restored = f.create();
  expect((await restored.restore()).stage).toBe('cached');
  await expect(restored.install()).rejects.toThrow('下载');
  const before = f.fetch.mock.calls.length;
  expect((await restored.check()).stage).toBe('ready');
  await restored.download();
  expect(f.fetch.mock.calls.length - before).toBe(1);
  expect(await fs.readdir(f.directory)).toHaveLength(1);
});
it('重启前安装包被篡改时不能恢复可安装，不会执行损坏文件', async () => {
  const f = await fixture(),
    first = f.create();
  await first.check();
  const downloaded = await first.download();
  await fs.writeFile(downloaded.installerPath!, Buffer.alloc(payload.length, 0));
  const restored = f.create();
  expect((await restored.restore()).stage).toBe('cached');
  expect((await restored.check()).stage).toBe('available');
  await expect(restored.install()).rejects.toThrow('下载');
  expect(f.launch).not.toHaveBeenCalled();
});
it('本地凭据被伪造或损坏时不信任元数据，联网核验仍可复用完整文件', async () => {
  const f = await fixture(),
    first = f.create();
  await first.check();
  const downloaded = await first.download();
  await fs.writeFile(path.join(path.dirname(downloaded.installerPath!), 'ready.bin'), 'forged');
  const restored = f.create();
  expect((await restored.restore()).stage).toBe('cached');
  expect((await restored.check()).stage).toBe('ready');
  expect(f.fetch).toHaveBeenCalledTimes(3);
});
it('同版本和旧版本缓存不能离线恢复成可安装', async () => {
  const f = await fixture(),
    first = f.create();
  await first.check();
  await first.download();
  const current = new AppUpdater({
    currentVersion: '1.5.7',
    directory: f.directory,
    fetch: f.fetch,
    emit: () => {},
    launch: f.launch,
    installBlocked: () => undefined,
    cacheProtection: protection,
  });
  expect((await current.restore()).stage).not.toBe('ready');
  await expect(current.install()).rejects.toThrow('下载');
});
it('缓存子目录为链接时既不读取也不删除外部安装包', async () => {
  const f = await fixture(),
    outside = path.join(f.root, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'setup.exe'), payload);
  await fs.mkdir(f.directory, { recursive: true });
  await fs.symlink(
    outside,
    path.join(f.directory, 'update-linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const updater = f.create();
  expect((await updater.restore()).stage).toBe('idle');
  expect((await updater.check()).stage).toBe('available');
  expect(await fs.readFile(path.join(outside, 'setup.exe'))).toEqual(payload);
});
it('重新检查失败保留已验证的安装包，打开位置不接受任意路径', async () => {
  const f = await fixture(),
    updater = f.create();
  await updater.check();
  const ready = await updater.download();
  f.fetch.mockRejectedValueOnce(new Error('离线'));
  expect((await updater.check()).stage).toBe('ready');
  expect((await updater.location()).file).toBe(ready.installerPath);
  await fs.unlink(ready.installerPath!);
  expect(await updater.location()).toEqual({ directory: f.directory });
});
