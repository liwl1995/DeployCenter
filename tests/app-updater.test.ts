// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  AppUpdater,
  allowedUpdateUrl,
  latestReleaseUrl,
  newerVersion,
  parseRelease,
} from '../electron/app-updater';
import { installerScript } from '../electron/update-installer';

const bytes = Buffer.from('MZ installer fixture, never executed');
const hash = createHash('sha256').update(bytes).digest('hex');
const base = path.resolve('.test-data');
const dirs: string[] = [];
function release(version = '1.5.3') {
  const name = `YOTOO-DeployCenter-${version}-Windows-x64-Setup.exe`;
  return {
    tag_name: 'v' + version,
    draft: false,
    prerelease: false,
    html_url: 'https://github.com/liwl1995/DeployCenter/releases/tag/v' + version,
    body: '修复更新体验\n<script>不执行</script>',
    published_at: '2026-11-13T01:00:00Z',
    assets: [
      {
        name,
        state: 'uploaded',
        size: bytes.length,
        digest: 'sha256:' + hash,
        browser_download_url:
          'https://github.com/liwl1995/DeployCenter/releases/download/v' + version + '/' + name,
      },
    ],
  };
}
async function fixture() {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'updater-'));
  dirs.push(root);
  let metadata = release(),
    payload: Buffer<ArrayBufferLike> = bytes,
    blocked: string | undefined;
  const emit = vi.fn(),
    launch = vi.fn().mockResolvedValue(undefined);
  const fetch = vi.fn(async (url: string) =>
    url === latestReleaseUrl ? Response.json(metadata) : new Response(new Uint8Array(payload)),
  );
  const updater = new AppUpdater({
    currentVersion: '1.5.2',
    directory: path.join(root, 'Updates'),
    emit,
    fetch,
    launch,
    installBlocked: () => blocked,
  });
  return {
    root,
    updater,
    emit,
    launch,
    fetch,
    setMetadata: (r: ReturnType<typeof release>) => {
      metadata = r;
    },
    setPayload: (p: Buffer) => {
      payload = p;
    },
    block: (s?: string) => {
      blocked = s;
    },
  };
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    if (path.dirname(dir) !== base) throw new Error('测试目录越界');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
describe('应用更新', () => {
  it('按数值比较正式版本，拒绝预发布、错误格式和降级', () => {
    expect(newerVersion('v1.10.0', '1.9.9')).toBe(true);
    expect(newerVersion('1.5.2', '1.5.2')).toBe(false);
    expect(newerVersion('1.4.9', '1.5.2')).toBe(false);
    for (const version of ['1.5.3-beta.1', '1.05.3', '../1.2.3', '9007199254740993.0.0'])
      expect(() => newerVersion(version, '1.5.2')).toThrow();
  });
  it('只接受本仓库正式发布、唯一 x64 安装包和完整校验信息', () => {
    expect(parseRelease(release()).hash).toBe(hash);
    for (const change of [
      { prerelease: true },
      { draft: true },
      { assets: [] },
      { html_url: 'https://example.com' },
    ])
      expect(() => parseRelease({ ...release(), ...change })).toThrow();
    const r = release();
    expect(() => parseRelease({ ...r, assets: [...r.assets, ...r.assets] })).toThrow();
    expect(() => parseRelease({ ...r, assets: [{ ...r.assets[0], digest: null }] })).toThrow(
      /SHA-256/,
    );
    expect(() =>
      parseRelease({
        ...r,
        assets: [{ ...r.assets[0], browser_download_url: 'https://example.com/setup.exe' }],
      }),
    ).toThrow(/地址/);
  });
  it('限制所有重定向地址，禁止 HTTP、认证信息、其他仓库和本机地址', () => {
    expect(allowedUpdateUrl(latestReleaseUrl)).toBe(true);
    expect(
      allowedUpdateUrl(
        'https://release-assets.githubusercontent.com/github-production-release-asset/1/test?token=xx',
      ),
    ).toBe(true);
    for (const url of [
      'http://github.com/liwl1995/DeployCenter/releases/download/v1/a',
      'https://github.com.evil/a',
      'https://localhost/a',
      'https://github.com/other/repo/releases/download/v1/a',
      'file:///C:/test.exe',
      'https://user:pass@github.com/liwl1995/DeployCenter/releases/download/v1/a',
    ])
      expect(allowedUpdateUrl(url)).toBe(false);
  });
  it('检查不触发下载；旧版或同版本不允许安装或下载', async () => {
    const f = await fixture();
    expect((await f.updater.check()).stage).toBe('available');
    expect(f.fetch).toHaveBeenCalledTimes(1);
    await expect(f.updater.install()).rejects.toThrow(/下载/);
    f.setMetadata(release('1.5.1'));
    expect((await f.updater.check()).stage).toBe('current');
    await expect(f.updater.download()).rejects.toThrow(/新版本/);
    expect(f.launch).not.toHaveBeenCalled();
  });
  it('下载进度、大小、SHA 校验通过才就绪；重复下载不新增文件', async () => {
    const f = await fixture();
    await f.updater.check();
    expect((await f.updater.download()).stage).toBe('ready');
    expect(f.updater.state().received).toBe(bytes.length);
    expect(f.emit.mock.calls.some(([s]) => s.stage === 'verifying')).toBe(true);
    const folders = await fs.readdir(path.join(f.root, 'Updates'));
    expect(folders).toHaveLength(1);
    expect(await fs.readFile(path.join(f.root, 'Updates', folders[0], 'setup.exe'))).toEqual(bytes);
    await f.updater.download();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    await f.updater.install();
    expect(f.launch).toHaveBeenCalledWith(expect.stringContaining('setup.exe'), hash);
  });
  it('下载被篡改或大小不一致时删除本次文件，允许重试', async () => {
    const f = await fixture();
    await f.updater.check();
    f.setPayload(Buffer.alloc(bytes.length, 0));
    expect((await f.updater.download()).message).toContain('SHA-256');
    expect(await fs.readdir(path.join(f.root, 'Updates'))).toEqual([]);
    f.setPayload(Buffer.concat([bytes, bytes]));
    expect((await f.updater.download()).stage).toBe('error');
    f.setPayload(bytes);
    expect((await f.updater.download()).stage).toBe('ready');
  });
  it('运行中或中断任务阻止安装；安装前文件被篡改时再次阻止', async () => {
    const f = await fixture();
    await f.updater.check();
    await f.updater.download();
    f.block('任务未结束');
    await expect(f.updater.install()).rejects.toThrow('任务未结束');
    expect(f.updater.state().stage).toBe('ready');
    f.block();
    const folder = (await fs.readdir(path.join(f.root, 'Updates')))[0];
    await fs.writeFile(path.join(f.root, 'Updates', folder, 'setup.exe'), 'modified');
    await expect(f.updater.install()).rejects.toThrow('校验失败');
    expect(f.launch).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(f.root, 'Updates'))).toEqual([]);
  });
  it('异步校验期间新任务出现仍阻止安装；助手启动失败保持可重试', async () => {
    const f = await fixture();
    await f.updater.check();
    await f.updater.download();
    let calls = 0;
    const guard = vi
      .spyOn(f.updater['options'], 'installBlocked')
      .mockImplementation(() => (++calls > 1 ? '任务开始了' : undefined));
    await expect(f.updater.install()).rejects.toThrow('任务开始了');
    expect(f.launch).not.toHaveBeenCalled();
    guard.mockRestore();
    f.launch.mockRejectedValueOnce(new Error('系统不允许启动助手'));
    await expect(f.updater.install()).rejects.toThrow('系统不允许启动助手');
    expect(f.updater.state().stage).toBe('ready');
    expect(f.updater.isInstalling()).toBe(false);
  });
  it('离线、限流和恶意重定向均保留应用可用，不执行安装', async () => {
    const f = await fixture();
    f.fetch.mockRejectedValueOnce(new Error('网络不可用'));
    expect((await f.updater.check()).message).toContain('网络不可用');
    f.fetch.mockResolvedValueOnce(new Response('', { status: 429 }));
    expect((await f.updater.check()).message).toContain('限制');
    f.fetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://localhost/malware' } }),
    );
    expect((await f.updater.check()).message).toContain('不受信任');
    expect(f.launch).not.toHaveBeenCalled();
  });
  it('取消下载清理半成品，重复检查和下载不会并发', async () => {
    const f = await fixture();
    await f.updater.check();
    let start!: () => void;
    const began = new Promise<void>((resolve) => {
      start = resolve;
    });
    f.fetch.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      start();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(bytes.subarray(0, 2)));
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('Cancelled', 'AbortError')),
            );
          },
        }),
      );
    });
    const result = f.updater.download();
    await began;
    expect((await f.updater.check()).stage).toBe('downloading');
    expect((await f.updater.download()).stage).toBe('downloading');
    f.updater.cancel();
    expect((await result).stage).toBe('available');
    expect(await fs.readdir(path.join(f.root, 'Updates'))).toEqual([]);
  });
  it('缓存目录为链接时拒绝写入，外部文件保持原样', async () => {
    const f = await fixture(),
      outside = path.join(f.root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
    await fs.symlink(
      outside,
      path.join(f.root, 'Updates'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await f.updater.check();
    expect((await f.updater.download()).message).toContain('安全');
    expect(await fs.readdir(outside)).toEqual(['keep.txt']);
  });
  it('安装助手等待原进程退出、再次校验且不强杀，不静默安装；特殊路径按数据编码', () => {
    const directory = "D:\\程序 中文 ' $目录";
    const script = installerScript(
      directory + '\\setup.exe',
      hash,
      directory,
      directory + '\\log.txt',
      123,
    );
    expect(script.indexOf('$parent.WaitForExit()')).toBeLessThan(
      script.indexOf('[Diagnostics.Process]::Start'),
    );
    expect(script).toContain('[Security.Cryptography.SHA256]::Create()');
    expect(script).toContain('UPDATE_READY');
    expect(script).not.toMatch(/Stop-Process|taskkill|\/S\b/);
    expect(script).not.toContain(directory);
    expect(script).toContain(Buffer.from(directory, 'utf8').toString('base64'));
  });
});

it('仅清理过期且内容可识别的缓存，未知文件、链接和新缓存保留', async () => {
  const f = await fixture();
  const root = path.join(f.root, 'Updates');
  await fs.mkdir(root);
  for (const name of ['update-old', 'update-unknown', 'update-new']) {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(
      path.join(root, name, name === 'update-unknown' ? 'keep.txt' : 'setup.partial'),
      'keep',
    );
  }
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  for (const name of ['update-old', 'update-unknown'])
    await fs.utimes(path.join(root, name), old, old);
  await fs.symlink(
    path.join(root, 'update-unknown'),
    path.join(root, 'update-link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await f.updater.check();
  expect((await fs.readdir(root)).sort()).toEqual(['update-link', 'update-new', 'update-unknown']);
  expect(await fs.readFile(path.join(root, 'update-unknown', 'keep.txt'), 'utf8')).toBe('keep');
});
