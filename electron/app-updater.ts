import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AppUpdate } from '../src/app-update';

const repository = 'https://github.com/liwl1995/DeployCenter';
export const latestReleaseUrl =
  'https://api.github.com/repos/liwl1995/DeployCenter/releases/latest';
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Release = NonNullable<AppUpdate['release']> & { url: string; hash: string };
type Options = {
  currentVersion: string;
  directory: string;
  fetch: Fetch;
  emit: (value: AppUpdate) => void;
  installBlocked: () => string | undefined;
  launch: (file: string, hash: string) => Promise<void>;
  now?: () => number;
};
/** 仅比较正式版本，避免按字符串排序把 1.10 判为旧于 1.9。 */
export function versionParts(value: string): number[] {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error('版本号不是受支持的正式版本');
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error('版本号超出范围');
  return parts;
}
export function newerVersion(next: string, current: string): boolean {
  const a = versionParts(next),
    b = versionParts(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
/** 每一跳重定向都校验，远端内容不能指定任意下载站或本机地址。 */
export function allowedUpdateUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
      return false;
    if (url.origin === 'https://api.github.com') return url.href === latestReleaseUrl;
    if (url.origin === 'https://github.com')
      return url.pathname.startsWith('/liwl1995/DeployCenter/releases/download/');
    return (
      ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(
        url.hostname,
      ) && url.pathname.startsWith('/github-production-release-asset/')
    );
  } catch {
    return false;
  }
}
export function parseRelease(value: unknown): Release {
  const r = value as Record<string, unknown> | null;
  if (!r || r.draft !== false || r.prerelease !== false || typeof r.tag_name !== 'string')
    throw new Error('未找到可用的正式版本');
  const version = versionParts(r.tag_name).join('.');
  if (r.html_url !== repository + '/releases/tag/' + r.tag_name) throw new Error('版本来源不匹配');
  const names = [
    `YOTOO-DeployCenter-${version}-Windows-x64-Setup.exe`,
    `YOTOO部署中心-${version}-x64-安装包.exe`,
  ];
  const assets = Array.isArray(r.assets)
    ? r.assets.filter((asset) => names.includes(asset?.name))
    : [];
  if (assets.length !== 1)
    throw new Error('该版本没有唯一的 Windows x64 安装包，请前往版本与源码页面查看');
  const a = assets[0];
  if (
    a.state !== 'uploaded' ||
    !Number.isSafeInteger(a.size) ||
    a.size <= 0 ||
    a.size > 2 * 1024 ** 3
  )
    throw new Error('安装包大小或发布状态无效');
  if (typeof a.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(a.digest))
    throw new Error('安装包缺少 SHA-256 校验信息，请前往版本与源码页面下载并核实');
  const expected =
    repository + '/releases/download/' + r.tag_name + '/' + encodeURIComponent(a.name);
  if (a.browser_download_url !== expected || !allowedUpdateUrl(expected))
    throw new Error('安装包下载地址不匹配');
  return {
    version,
    url: expected,
    hash: a.digest.slice(7).toLowerCase(),
    size: a.size,
    notes: typeof r.body === 'string' ? r.body.slice(0, 50000) : '该版本未提供更新说明。',
    publishedAt: typeof r.published_at === 'string' ? r.published_at : '',
  };
}

/** 使用现有安装向导完成覆盖升级，不引入独立的自动更新服务。 */
export class AppUpdater {
  private value: AppUpdate;
  private release?: Release;
  private abort?: AbortController;
  private folder?: string;
  private file?: string;
  private installing = false;
  private now: () => number;
  constructor(private options: Options) {
    this.now = options.now || Date.now;
    this.value = { currentVersion: options.currentVersion, stage: 'idle', received: 0, speed: 0 };
  }
  state(): AppUpdate {
    return structuredClone(this.value);
  }
  private publish(change: Partial<AppUpdate>) {
    this.value = { ...this.value, ...change };
    this.options.emit(this.state());
    return this.state();
  }
  private async response(url: string, signal: AbortSignal): Promise<Response> {
    for (let i = 0; i < 6; i++) {
      if (!allowedUpdateUrl(url)) throw new Error('已拒绝不受信任的更新地址');
      const response = await this.options.fetch(url, {
        redirect: 'manual',
        signal,
        headers: {
          'User-Agent': 'YOTOO-DeployCenter/' + this.options.currentVersion,
          ...(url === latestReleaseUrl
            ? { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
            : {}),
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('更新服务器返回了无效的重定向');
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 403 || response.status === 429)
          throw new Error('GitHub 暂时限制了访问，请稍后重试，或前往版本与源码页面下载');
        throw new Error(
          response.status === 404
            ? '暂未发布可用的正式版本'
            : '更新服务器响应异常（' + response.status + '）',
        );
      }
      return response;
    }
    throw new Error('更新服务器重定向次数过多');
  }
  async check(): Promise<AppUpdate> {
    if (this.abort || this.installing) return this.state();
    this.abort = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(20000)]);
    this.publish({ stage: 'checking', message: undefined });
    try {
      await this.pruneCache();
      const response = await this.response(latestReleaseUrl, signal);
      if (!response.body) throw new Error('更新服务器未返回版本信息');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > 2 * 1024 ** 2) throw new Error('更新说明过大，已停止读取');
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const release = parseRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (this.release?.hash !== release.hash) {
        await this.cleanup();
        this.file = undefined;
      }
      this.release = release;
      const { url: _url, hash: _hash, ...summary } = release;
      return this.publish({
        stage: newerVersion(release.version, this.options.currentVersion)
          ? this.file
            ? 'ready'
            : 'available'
          : 'current',
        release: summary,
        checkedAt: new Date(this.now()).toISOString(),
        received: this.file ? release.size : 0,
        speed: 0,
      });
    } catch (error) {
      return this.failure(error);
    } finally {
      this.abort = undefined;
    }
  }
  private failure(error: unknown) {
    return this.publish({
      stage: 'error',
      speed: 0,
      message:
        '更新未完成：' +
        (error instanceof Error
          ? error.name === 'AbortError' || error.name === 'TimeoutError'
            ? '连接超时或操作已取消，请检查网络后重试。'
            : error.message
          : '无法连接更新服务器，请检查网络后重试。'),
    });
  }
  private async safeRoot() {
    const root = path.resolve(this.options.directory);
    await fs.mkdir(root, { recursive: true });
    const stat = await fs.lstat(root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.realpath(root)).toLowerCase() !== root.toLowerCase()
    )
      throw new Error('更新缓存目录不是安全的本机目录');
    return root;
  }
  private async pruneCache() {
    const root = path.resolve(this.options.directory);
    try {
      await this.safeRoot();
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^update-[A-Za-z0-9]+$/.test(entry.name)) continue;
        const folder = path.join(root, entry.name);
        if (folder === this.folder) continue;
        const stat = await fs.lstat(folder);
        if (stat.isSymbolicLink() || this.now() - stat.mtimeMs < 24 * 3600 * 1000) continue;
        const names = await fs.readdir(folder);
        if (names.some((name) => !['setup.exe', 'setup.partial'].includes(name))) continue;
        const files = await Promise.all(names.map((name) => fs.lstat(path.join(folder, name))));
        if (files.some((file) => !file.isFile() || file.isSymbolicLink())) continue;
        for (const name of names) await fs.unlink(path.join(folder, name));
        await fs.rmdir(folder);
      }
    } catch {
      /* 缓存被占用或路径异常时保留，不影响检查版本。 */
    }
  }
  private async cleanup() {
    if (!this.folder) return;
    const root = path.resolve(this.options.directory),
      folder = path.resolve(this.folder);
    if (path.dirname(folder) !== root || !/^update-[A-Za-z0-9]+$/.test(path.basename(folder)))
      return;
    try {
      await this.safeRoot();
      if ((await fs.lstat(folder)).isSymbolicLink()) return;
      for (const name of ['setup.partial', 'setup.exe']) {
        const file = path.join(folder, name);
        const stat = await fs.lstat(file).catch(() => undefined);
        if (stat?.isFile() && !stat.isSymbolicLink()) await fs.unlink(file);
      }
      await fs.rmdir(folder);
    } catch {
      /* 被占用或存在非预期文件时保留现场，不扩大删除范围。 */
    }
    this.folder = undefined;
  }
  async download(): Promise<AppUpdate> {
    if (this.abort || this.installing) return this.state();
    const release = this.release;
    if (!release || !newerVersion(release.version, this.options.currentVersion))
      throw new Error('请先检查是否有新版本');
    if (this.file) return this.publish({ stage: 'ready', message: undefined });
    this.abort = new AbortController();
    const controller = this.abort;
    let timeout: ReturnType<typeof setTimeout>;
    const touch = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), 45000);
    };
    touch();
    this.publish({ stage: 'downloading', received: 0, speed: 0, message: undefined });
    try {
      await this.cleanup();
      const root = await this.safeRoot();
      this.folder = await fs.mkdtemp(path.join(root, 'update-'));
      const partial = path.join(this.folder, 'setup.partial');
      const response = await this.response(
        release.url,
        AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60 * 1000)]),
      );
      if (!response.body) throw new Error('下载内容为空');
      const reader = response.body.getReader(),
        output = await fs.open(partial, 'wx');
      const hash = createHash('sha256');
      let received = 0,
        lastEmit = this.now();
      const start = lastEmit;
      try {
        while (true) {
          const item = await reader.read();
          if (controller.signal.aborted) throw new Error('下载已取消');
          if (item.done) break;
          touch();
          received += item.value.length;
          if (received > release.size) throw new Error('安装包大小与发布信息不一致');
          hash.update(item.value);
          await output.writeFile(item.value);
          const now = this.now();
          if (now - lastEmit >= 200 || received === release.size) {
            this.publish({ received, speed: received / Math.max(0.1, (now - start) / 1000) });
            lastEmit = now;
          }
        }
        this.publish({ stage: 'verifying', received, speed: 0 });
        if (received !== release.size || hash.digest('hex') !== release.hash)
          throw new Error('安装包 SHA-256 校验失败，已删除下载文件，请重新下载');
        await output.sync();
      } finally {
        await output.close();
        await reader.cancel().catch(() => {});
      }
      this.file = path.join(this.folder, 'setup.exe');
      await fs.rename(partial, this.file);
      return this.publish({ stage: 'ready' });
    } catch (error) {
      this.file = undefined;
      await this.cleanup();
      return controller.signal.aborted
        ? this.publish({
            stage: 'available',
            received: 0,
            speed: 0,
            message: '下载已取消或连接超时，可以重新下载。',
          })
        : this.failure(error);
    } finally {
      clearTimeout(timeout!);
      this.abort = undefined;
    }
  }
  cancel() {
    if (this.value.stage === 'downloading') this.abort?.abort();
  }
  /** 安装前再查任务状态并重新读取文件校验，避免校验后被篡改。 */
  async install(): Promise<AppUpdate> {
    if (this.installing) throw new Error('正在启动安装向导');
    if (!this.file || !this.release || this.value.stage !== 'ready')
      throw new Error('请先下载并校验安装包');
    const blocked = this.options.installBlocked();
    if (blocked) throw new Error(blocked);
    this.installing = true;
    this.publish({ stage: 'installing', message: undefined });
    try {
      await this.safeRoot();
      if (!this.folder || (await fs.lstat(this.folder)).isSymbolicLink())
        throw new Error('更新缓存目录已变化');
      const file = await fs.open(this.file, 'r');
      const hash = createHash('sha256');
      let size = 0;
      try {
        if (!(await file.stat()).isFile() || (await fs.lstat(this.file)).isSymbolicLink())
          throw new Error('安装包文件不安全');
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          hash.update(chunk);
          size += chunk.length;
        }
      } finally {
        await file.close();
      }
      if (size !== this.release.size || hash.digest('hex') !== this.release.hash) {
        this.file = undefined;
        await this.cleanup();
        throw new Error('安装包校验失败，请重新下载');
      }
      const reason = this.options.installBlocked();
      if (reason) throw new Error(reason);
      await this.options.launch(this.file!, this.release.hash);
      return this.state();
    } catch (error) {
      this.installing = false;
      this.publish({
        stage: this.file ? 'ready' : 'error',
        message: String(error instanceof Error ? error.message : error),
      });
      throw error;
    }
  }
  isInstalling() {
    return this.installing;
  }
  dispose() {
    this.abort?.abort();
  }
}
