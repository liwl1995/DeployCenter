import fs, { createReadStream, openAsBlob } from 'node:fs';
import { access, copyFile, mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BlobReader, ZipReader, TextWriter } from '@zip.js/zip.js';
import type { Artifact, Database, Service } from '../src/model';
import { runBatch, runProcess, splitArguments, type ProcessOptions } from './process';
import type { ServiceInfo } from '../src/platform';

export const resolveLocal = (root: string, value: string) =>
  path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
export const jarPath = (s: Service) => path.join(resolveLocal(s.root, s.jarDir), s.jarName);
export async function fileHash(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
export async function inspectJar(
  file: string,
  signal?: AbortSignal,
  full = true,
): Promise<Artifact> {
  const absolute = path.resolve(file);
  const item = await stat(absolute).catch(() => {
    throw new Error('JAR 文件不存在：' + absolute);
  });
  if (!item.isFile() || item.size === 0 || !/\.jar$/i.test(absolute))
    throw new Error('请选择非空的 .jar 文件：' + absolute);
  const reader = new ZipReader(new BlobReader(await openAsBlob(absolute)), {
    useWebWorkers: false,
    checkCrc32: true,
    checkOverlappingEntry: true,
  });
  let hasManifest = false,
    total = 0;
  try {
    const entries = await reader.getEntries();
    for (const entry of entries) {
      if (signal?.aborted) throw new Error('操作已取消');
      if (entry.directory) continue;
      total += entry.uncompressedSize;
      if (total > Math.max(item.size * 200, 4 * 1024 ** 3))
        throw new Error('JAR 解压体积异常，拒绝校验');
      if (entry.encrypted) throw new Error('JAR 含加密条目，不能作为 Java 运行产物');
      if (entry.filename === 'META-INF/MANIFEST.MF') {
        const text = await entry.getData!(new TextWriter(), { checkCrc32: true, signal });
        if (!/^Manifest-Version\s*:/m.test(text)) throw new Error('Manifest 缺少 Manifest-Version');
        hasManifest = true;
      } else if (full)
        await entry.getData!(new WritableStream<Uint8Array>({ write() {} }), {
          checkCrc32: true,
          signal,
        });
    }
    if (!hasManifest) throw new Error('JAR 缺少 META-INF/MANIFEST.MF');
  } catch (e) {
    throw new Error(`JAR 完整性检查失败：${e instanceof Error ? e.message : e}`);
  } finally {
    await reader.close();
  }
  const sha256 = full ? await fileHash(absolute, signal) : undefined;
  const after = await stat(absolute);
  if (after.size !== item.size || after.mtimeMs !== item.mtimeMs)
    throw new Error('校验期间 JAR 已变化，请重新选择或重新构建');
  return {
    path: absolute,
    originalPath: absolute,
    name: path.basename(absolute),
    size: item.size,
    modified: item.mtime.toISOString(),
    exists: true,
    source: 'file',
    sha256,
  };
}
/** 主页面只读元数据；完整 ZIP/CRC/哈希仍在选择与正式部署准备时校验。 */
export async function serviceInfo(service: Service, file = jarPath(service)): Promise<ServiceInfo> {
  const absolute = path.resolve(file);
  const artifact: Artifact = {
    name: path.basename(absolute),
    path: absolute,
    size: 0,
    modified: new Date(0).toISOString(),
    exists: false,
    source: 'file',
  };
  let artifactError: string | undefined;
  try {
    const item = await stat(absolute);
    if (!item.isFile()) throw new Error('配置的 JAR 路径不是普通文件');
    artifact.exists = true;
    artifact.size = item.size;
    artifact.modified = item.mtime.toISOString();
  } catch (error) {
    artifactError =
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'JAR 文件不存在，请先构建或选择其他文件。'
        : '无法读取 JAR：' + String(error);
  }
  return {
    artifact,
    artifactError,
    git: await gitInfo(service.root),
    checkedAt: new Date().toISOString(),
  };
}

export async function snapshotJar(
  file: string,
  taskId: string,
  dataDir: string,
  signal?: AbortSignal,
): Promise<Artifact> {
  if (!/^DC-[a-zA-Z0-9-]+$/.test(taskId)) throw new Error('任务标识无效');
  const dir = path.join(dataDir, 'artifacts', taskId);
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, path.basename(file));
  const before = await stat(file);
  await copyFile(file, dest, fs.constants.COPYFILE_EXCL);
  const after = await stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error('生成产物快照时源 JAR 发生变化，请重试');
  const result = await inspectJar(dest, signal);
  result.originalPath = path.resolve(file);
  result.modified = before.mtime.toISOString();
  return result;
}
export async function resolveBuild(
  s: Service,
  jdks: Database['jdks'],
  tempRoot: string,
  options: ProcessOptions = {},
) {
  const root = path.resolve(s.root),
    cwd = resolveLocal(root, s.workDir);
  const jdk = jdks.find((j) => j.name === s.jdk);
  if (!jdk) throw new Error('未配置构建 JDK：' + s.jdk);
  const java = path.join(jdk.path, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const javac = path.join(jdk.path, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
  await access(java).catch(() => {
    throw new Error('JDK 中不存在 java：' + java);
  });
  await access(javac).catch(() => {
    throw new Error('必须选择完整 JDK（缺少 javac）：' + jdk.path);
  });
  if (!(await stat(cwd)).isDirectory()) throw new Error('构建工作目录不存在：' + cwd);
  const cmdWrapper = path.join(root, 'mvnw.cmd'),
    shellWrapper = path.join(root, 'mvnw');
  const wrapper = fs.existsSync(cmdWrapper)
    ? cmdWrapper
    : fs.existsSync(shellWrapper)
      ? shellWrapper
      : undefined;
  if (s.tool === 'wrapper' && !wrapper)
    throw new Error('项目缺少 Maven Wrapper，禁止回退本地 Maven');
  const tool =
    s.tool === 'wrapper' || (s.tool === 'auto' && wrapper)
      ? wrapper!
      : s.mavenPath
        ? path.resolve(s.mavenPath)
        : process.platform === 'win32'
          ? 'mvn.cmd'
          : 'mvn';
  const env = {
    ...process.env,
    JAVA_HOME: path.resolve(jdk.path),
    PATH:
      path.join(jdk.path, 'bin') + path.delimiter + (process.env.PATH || process.env.Path || ''),
  };
  const checked = await runProcess(java, ['-version'], { ...options, env, timeout: 15000 });
  if (checked.code !== 0) throw new Error('JDK 不可用：' + checked.stderr);
  const args = splitArguments(s.args);
  if (s.profiles.trim()) args.push('-P' + s.profiles.trim());
  return {
    tool,
    args,
    cwd,
    env,
    java,
    jdkPath: jdk.path,
    run: (opts: ProcessOptions) =>
      process.platform === 'win32' && tool === shellWrapper
        ? runProcess('bash.exe', [tool, ...args], { ...opts, cwd, env })
        : runBatch(tool, args, tempRoot, { ...opts, cwd, env }),
  };
}
export async function gitInfo(root: string): Promise<Service['git'] & { dirty: boolean }> {
  const query = (args: string[]) => runProcess('git', ['-C', root, ...args], { timeout: 10000 });
  try {
    const [branch, commit, time, dirty] = await Promise.all([
      query(['branch', '--show-current']),
      query(['rev-parse', 'HEAD']),
      query(['show', '-s', '--format=%cI', 'HEAD']),
      query(['status', '--porcelain']),
    ]);
    if (commit.code) throw new Error();
    return {
      branch: branch.stdout.trim() || '(detached)',
      commit: commit.stdout.trim(),
      time: time.stdout.trim(),
      dirty: !!dirty.stdout.trim(),
    };
  } catch {
    return {
      branch: '非 Git 项目',
      commit: '待计算 JAR 哈希',
      time: new Date(0).toISOString(),
      dirty: false,
    };
  }
}
export async function detectJdks(): Promise<Database['jdks']> {
  const candidates = new Set<string>();
  if (process.env.JAVA_HOME) candidates.add(process.env.JAVA_HOME);
  const roots = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Java'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Eclipse Adoptium'),
    path.join(process.env.USERPROFILE || '', '.jdks'),
    'E:\\dev\\jdk',
  ];
  for (const root of roots) {
    try {
      for (const item of await import('node:fs/promises').then((f) =>
        f.readdir(root, { withFileTypes: true }),
      ))
        if (item.isDirectory()) candidates.add(path.join(root, item.name));
    } catch {}
  }
  const result: Database['jdks'] = [];
  for (const candidate of candidates) {
    const release = await import('node:fs/promises')
      .then((f) => f.readFile(path.join(candidate, 'release'), 'utf8'))
      .catch(() => '');
    const version = release.match(/JAVA_VERSION="([^"]+)"/)?.[1];
    if (version && fs.existsSync(path.join(candidate, 'bin', 'javac.exe')))
      result.push({
        name: 'JDK ' + (version.startsWith('1.8') ? '8' : version.split('.')[0]),
        path: candidate,
      });
  }
  return result.filter(
    (x, i, all) => all.findIndex((y) => y.path.toLowerCase() === x.path.toLowerCase()) === i,
  );
}
export async function checkJdk(dir: string) {
  const file = path.join(dir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const result = await runProcess(file, ['-version'], { timeout: 15000 });
  if (result.code) throw new Error(result.stderr);
  return result.stderr || result.stdout;
}
export async function touchAndSync(file: string, text: string) {
  const handle = await open(file, 'w', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}
