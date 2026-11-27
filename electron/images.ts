import { randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { acceptBuild } from '../src/validation';
import { imageIdentities, imageSize } from '../src/images';
import type { Database, Service } from '../src/model';
import type {
  ImageBuild,
  ImageCheck,
  ImageEngine,
  ImageJob,
  ImageLogChunk,
  ImagePackage,
  ImageSource,
} from '../src/images';
import { errorText } from './contracts';
import { inspectJar, jarPath, resolveBuild } from './files';
import { imagePlatform, imageReference, inspectImageArchive } from './image-archive';
import {
  checkImageImport,
  cleanImageUpload,
  createImageUpload,
  loadRemoteImage,
  verifyRemoteImage,
  verifyUploadedImage,
} from './image-import';
import { plainPath } from './managed-path';
import { MemoryCredentials } from './native-capabilities';
import { runProcess, stripAnsi, type ProcessOptions } from './process';
import type { Transport } from './ssh';

const absolute = z
  .string()
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !/[\r\n\0]/.test(value), '请选择绝对路径');
export const imageIdSchema = z.string().regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
export const imageEngineSchema = z.object({
  kind: z.enum(['windows', 'wsl']),
  distro: z
    .string()
    .min(1)
    .max(120)
    .refine((s) => !/[\u0000-\u001f]/.test(s) && !s.startsWith('-'))
    .optional(),
});
export const imageBuildSchema = z.object({
  serviceId: z.string().min(1).max(128),
  engine: imageEngineSchema,
  mode: z.enum(['build', 'existing']),
  jarPath: absolute.optional(),
  dockerfile: absolute,
  context: absolute,
  reference: imageReference,
  platform: imagePlatform,
});
export const imageSourceSchema = z.union([
  z.object({ buildId: imageIdSchema }),
  z.object({ file: absolute }),
]);

export async function imageDistributions(signal?: AbortSignal) {
  if (process.platform !== 'win32') return [];
  const result = await runProcess('wsl.exe', ['--list', '--quiet'], {
    timeout: 15_000,
    encoding: 'utf16le',
    signal,
    env: { ...process.env, WSL_UTF8: '0' },
  });
  if (result.code) throw new Error('无法读取 WSL 发行版，请检查 Windows 中是否已安装 WSL');
  return [
    ...new Set(
      result.stdout
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

const executable = process.platform === 'win32' ? 'docker.exe' : 'docker';
// 让 Linux 侧停止自己的 Docker 客户端，避免只结束 Windows 的 wsl.exe。
const cancellableWsl =
  'exec 3<&0; "$@" & child=$!; ' +
  '(IFS= read -r _ <&3; kill -TERM "$child" 2>/dev/null) & watcher=$!; ' +
  'wait "$child"; status=$?; kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null; exit "$status"';
function dockerRun(engine: ImageEngine, args: string[], options: ProcessOptions = {}) {
  return engine.kind === 'windows'
    ? runProcess(executable, args, {
        ...options,
        env: { ...process.env, BUILDX_NO_DEFAULT_ATTESTATIONS: '1' },
      })
    : runProcess(
        'wsl.exe',
        [
          '-d',
          engine.distro!,
          '--exec',
          ...(options.signal ? ['sh', '-c', cancellableWsl, 'yotoo-docker'] : []),
          'env',
          'BUILDX_NO_DEFAULT_ATTESTATIONS=1',
          'docker',
          ...args,
        ],
        {
          ...options,
          cancelWithStdin: !!options.signal,
          env: { ...process.env, WSL_UTF8: '1' },
        },
      );
}
export async function probeImageEngine(engine: ImageEngine, signal?: AbortSignal) {
  if (engine.kind === 'wsl') {
    if (!engine.distro) throw new Error('请选择实际运行 Docker 的 WSL 发行版');
    if (!(await imageDistributions(signal)).includes(engine.distro))
      throw new Error('所选 WSL 发行版不存在');
  }
  const result = await dockerRun(
    engine,
    ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}} · Docker {{.Server.Version}}'],
    {
      timeout: engine.kind === 'wsl' ? 90_000 : 30_000,
      encoding: 'utf8',
      signal,
    },
  ).catch((error) => {
    throw new Error('无法运行 Docker CLI：' + errorText(error));
  });
  if (result.code || !result.stdout.trim().startsWith('linux/'))
    throw new Error(
      '无法连接 Linux Docker 引擎，请确认 Docker 已启动且当前用户有访问权限。' +
        (result.stderr.trim() ? '\n' + result.stderr.trim() : ''),
    );
  return result.stdout.trim();
}
async function dockerPath(engine: ImageEngine, absolute: string, signal?: AbortSignal) {
  if (engine.kind === 'windows') return absolute;
  const result = await runProcess(
    'wsl.exe',
    ['-d', engine.distro!, '--exec', 'wslpath', '-a', '-u', absolute],
    {
      timeout: 90_000,
      encoding: 'utf8',
      signal,
      env: { ...process.env, WSL_UTF8: '1' },
    },
  );
  if (result.code || !result.stdout.trim().startsWith('/') || /[\r\n\0]/.test(result.stdout.trim()))
    throw new Error('WSL 无法访问此 Windows 路径：' + absolute);
  return result.stdout.trim();
}

type JobRun = {
  log: (text: string) => void;
  checkpoint: () => Promise<void>;
  stage: (index: number, action: () => Promise<void>) => Promise<void>;
};
type ImageEvents = {
  job: (job: ImageJob) => void;
  log: (id: string, chunks: ImageLogChunk[]) => void;
};
const tailBytes = 4 * 1024 * 1024;

export class ImageJobs {
  readonly directory: string;
  private active?: ImageJob;
  private uploadAbort?: AbortController;
  private buildAbort?: AbortController;
  private buildingJar = false;
  private liveLogs?: { id: string; persist: () => Promise<void> };
  constructor(
    private readonly dataDir: string,
    private readonly emit: ImageEvents,
  ) {
    this.directory = path.join(dataDir, 'images');
  }

  busy() {
    return !!this.active;
  }
  usingMaven() {
    return this.buildingJar;
  }
  cancelUpload(id: string) {
    if (this.active?.id !== id || !this.uploadAbort)
      throw new Error('当前已离开上传阶段，不能取消');
    this.active.cancelling = true;
    this.uploadAbort.abort();
    this.emit.job(this.active);
  }
  cancelBuild(id: string) {
    if (this.active?.id !== id || this.active.kind !== 'build' || !this.buildAbort)
      throw new Error('镜像构建已结束或正在保存最终镜像包。');
    if (this.active.cancelling) return;
    this.active.cancelling = true;
    this.buildAbort.abort();
    this.emit.job(this.active);
  }
  private jobDirectory(id: string) {
    return plainPath(path.join(this.directory, imageIdSchema.parse(id)));
  }
  async list() {
    const entries = await readdir(plainPath(this.directory)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    const jobs: ImageJob[] = [];
    await Promise.all(
      entries
        .filter((entry) => imageIdSchema.safeParse(entry).success)
        .map(async (entry) => {
          try {
            const dir = this.jobDirectory(entry);
            const job: ImageJob = JSON.parse(
              await readFile(plainPath(path.join(dir, 'job.json')), 'utf8'),
            );
            if (job.id !== entry || !Array.isArray(job.stages)) return;
            if (job.id === this.active?.id) return;
            if (job.status === 'running') {
              job.status = 'interrupted';
              job.message =
                job.kind === 'import'
                  ? '应用上次退出，远程导入结果待核实。'
                  : '应用上次退出，构建没有完成。';
              for (const stage of job.stages)
                if (stage.status === 'running') stage.status = 'failed';
            }
            if (job.kind === 'build' && job.archive) {
              if (path.basename(job.archive.name) !== job.archive.name) return;
              job.archive.path = plainPath(path.join(dir, job.archive.name));
            }
            jobs.push(job);
          } catch (error) {
            // 迁移或异常退出后保留无法读取的原始文件，列表仍展示其余任务。
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
              console.warn('无法读取镜像任务记录', entry, errorText(error));
          }
        }),
    );
    if (this.active) jobs.push(this.active);
    return jobs.sort((a, b) => b.started - a.started);
  }

  async logs(id: string) {
    if (this.liveLogs?.id === id) await this.liveLogs.persist();
    const file = plainPath(path.join(this.jobDirectory(id), 'logs.jsonl'));
    const fd = await open(file, 'r').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (!fd) return [];
    try {
      const { size } = await fd.stat();
      const start = Math.max(0, size - tailBytes);
      const data = Buffer.alloc(size - start);
      const { bytesRead } = await fd.read(data, 0, data.length, start);
      const lines = data.subarray(0, bytesRead).toString('utf8').split('\n');
      if (start) lines.shift();
      lines.pop(); // 并发写入时丢弃尚未写完的最后一行，实时事件仍会补齐。
      return lines.filter(Boolean).map((line): ImageLogChunk => JSON.parse(line));
    } finally {
      await fd.close();
    }
  }

  async archive(source: ImageSource) {
    if ('file' in source) return inspectImageArchive(source.file);
    const job = (await this.list()).find((candidate) => candidate.id === source.buildId);
    if (job?.kind !== 'build' || job.status !== 'success' || !job.archive)
      throw new Error('请选择已生成的镜像包');
    const archive = await inspectImageArchive(job.archive.path);
    if (archive.hash !== job.archive.hash) throw new Error('镜像包内容已发生变化，请重新构建');
    return archive;
  }

  private start(job: ImageJob, action: (job: ImageJob, dir: string, run: JobRun) => Promise<void>) {
    if (this.active) throw new Error('已有镜像任务正在执行，请等待完成');
    const dir = this.jobDirectory(job.id);
    this.active = job;
    void this.execute(job, dir, action);
    this.emit.job(job);
    return job;
  }

  private async execute(
    job: ImageJob,
    dir: string,
    action: (job: ImageJob, dir: string, run: JobRun) => Promise<void>,
  ) {
    let offset = 0,
      current: ImageJob['stages'][number] | undefined;
    let chunks: ImageLogChunk[] = [],
      timer: ReturnType<typeof setTimeout> | undefined;
    let writes = Promise.resolve(),
      logError: string | undefined;
    const save = async () => {
      const target = path.join(dir, 'job.json');
      await writeFile(plainPath(target + '.next'), JSON.stringify(job), 'utf8');
      await rename(target + '.next', plainPath(target));
    };
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!chunks.length) return;
      const batch = chunks;
      chunks = [];
      writes = writes
        .then(() =>
          appendFile(
            plainPath(path.join(dir, 'logs.jsonl')),
            batch.map((chunk) => JSON.stringify(chunk) + '\n').join(''),
          ),
        )
        .catch((error) => {
          logError = errorText(error);
        });
      this.emit.log(job.id, batch);
    };
    this.liveLogs = {
      id: job.id,
      persist: () => {
        flush();
        return writes;
      },
    };
    const log = (raw: string) => {
      const text = stripAnsi(raw).replace(/\r(?!\n)/g, '\n');
      if (!text) return;
      chunks.push({ text, offset, time: Date.now(), step: current?.name || '任务' });
      offset += Buffer.byteLength(text);
      timer ??= setTimeout(flush, 80);
    };
    const stage: JobRun['stage'] = async (index, step) => {
      current = job.stages[index];
      current.status = 'running';
      current.started = Date.now();
      // 导入期间持久化现场路径，方便应用异常退出后查找原始文件。
      await save();
      this.emit.job(job);
      log('开始：' + current.name + '\n');
      await step();
      log('\n完成：' + current.name + '\n');
      current.status = 'success';
      current.finished = Date.now();
      this.emit.job(job);
    };
    try {
      await mkdir(plainPath(this.directory), { recursive: true });
      await mkdir(dir);
      await save();
      await action(job, dir, { log, stage, checkpoint: save });
      job.status = 'success';
    } catch (error) {
      job.status = job.cancelling ? 'cancelled' : 'failed';
      job.message = job.kind === 'build' && job.cancelling ? '镜像构建已取消，未生成镜像包。' : errorText(error);
      if (current?.status === 'running') {
        current.status = 'failed';
        current.finished = Date.now();
      }
      log('\n' + (job.cancelling ? '[WARNING] ' : '[ERROR] ') + job.message + '\n');
    } finally {
      flush();
      await writes;
      if (logError)
        job.message = [job.message, '完整日志未能写入：' + logError].filter(Boolean).join('；');
      job.finished = Date.now();
      await save().catch((error) => {
        job.message = [job.message, '任务记录未能保存：' + errorText(error)]
          .filter(Boolean)
          .join('；');
      });
      this.buildingJar = false;
      this.buildAbort = undefined;
      this.liveLogs = undefined;
      this.active = undefined;
      this.emit.job(job);
    }
  }

  build(request: ImageBuild, service: Service, db: Database) {
    if (this.busy()) throw new Error('已有镜像任务正在执行，请等待完成');
    const abort = new AbortController();
    const { signal } = abort;
    const job: ImageJob = {
      id: randomUUID(),
      name: service.name,
      kind: 'build',
      status: 'running',
      started: Date.now(),
      stages: [
        request.mode === 'build' ? '构建与校验 JAR' : '校验现有 JAR',
        '构建镜像',
        '导出与校验',
      ].map((name) => ({ name, status: 'pending' })),
    };
    const started = this.start(job, async (task, dir, { log, stage }) => {
      let jarArgument: string | undefined;
      await stage(0, async () => {
        log('检查本地构建环境：' + (request.engine.distro || 'Windows Docker') + '\n');
        signal.throwIfAborted();
        log((await probeImageEngine(request.engine, signal)) + '\n');
        if (
          !(await stat(request.context)).isDirectory() ||
          !(await stat(request.dockerfile)).isFile()
        )
          throw new Error('请选择可用的构建目录和 Dockerfile');
        const context = await realpath(request.context);
        const relative = path.relative(context, await realpath(this.dataDir));
        if (
          !relative ||
          (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
        )
          throw new Error('构建目录包含部署中心的数据目录，请选择更具体的项目目录');
        const configuredJar = jarPath(service);
        const file =
          request.mode === 'existing' && request.jarPath ? request.jarPath : configuredJar;
        if (path.relative(configuredJar, file)) {
          const selected = path.relative(context, await realpath(file));
          if (
            !selected ||
            path.isAbsolute(selected) ||
            selected === '..' ||
            selected.startsWith('..' + path.sep)
          )
            throw new Error('所选 JAR 必须位于 Docker 构建目录内');
          // 只有显式声明构建参数的 Dockerfile 才能接收临时选择的产物，避免悄悄使用默认 JAR。
          const dockerfile = await readFile(request.dockerfile, { encoding: 'utf8', signal });
          if (!/^\s*ARG[\t ]+YOTOO_JAR_FILE(?=[\t =\r\n]|$)/im.test(dockerfile))
            throw new Error('Dockerfile 需声明 ARG YOTOO_JAR_FILE 并通过它引用所选 JAR');
          jarArgument = selected.split(path.sep).join('/');
        }
        if (request.mode === 'build') {
          const resolved = await resolveBuild(service, db.jdks, path.join(this.dataDir, 'tmp'), { signal });
          log('Maven 工作目录：' + resolved.cwd + '\n使用 JDK：' + resolved.jdkPath + '\n');
          log([resolved.tool, ...resolved.args].join(' ') + '\n');
          const started = Date.now();
          const run = await resolved.run({
            timeout: (service.buildTimeout || 1800) * 1000,
            encoding: service.logEncoding,
            onData: log,
            signal,
          });
          const output = await stat(file).catch(() => undefined);
          if (
            !acceptBuild(
              {
                exitCode: run.code,
                successMarker: run.successMarker,
                validJar: !!output?.isFile() && output.size > 0,
                modified: output?.mtimeMs || 0,
                started,
              },
              db.settings.allowMavenNonzero,
            )
          )
            throw new Error(
              'Maven 构建未通过，产物必须存在且晚于本次构建开始（退出码 ' + run.code + '）',
            );
          if (run.code) log('[WARNING] 按构建兼容设置接受异常退出码，已确认 JAR 更新。\n');
        }
        log('校验 JAR：' + file + '\n');
        const jar = await inspectJar(file, signal);
        log(
          'JAR 已校验 · ' + imageSize(jar.size) + '\nDockerfile 必须能从构建目录引用所需文件。\n',
        );
      });
      let builtId: string;
      await stage(1, async () => {
        const options = { timeout: 60 * 60_000, encoding: 'utf8', onData: log, signal } as const;
        const [file, context] = await Promise.all([
          dockerPath(request.engine, request.dockerfile, signal),
          dockerPath(request.engine, request.context, signal),
        ]);
        log(`构建 ${request.reference} · ${request.platform}\n`);
        const result = await dockerRun(
          request.engine,
          [
            'build',
            '--progress=plain',
            '--platform',
            request.platform,
            '--file',
            file,
            '--tag',
            request.reference,
            ...(jarArgument ? ['--build-arg', 'YOTOO_JAR_FILE=' + jarArgument] : []),
            context,
          ],
          options,
        );
        if (result.code)
          throw new Error('Docker 构建失败（退出码 ' + result.code + '），请查看构建输出');
        const info = await dockerRun(request.engine, [
          'image',
          'inspect',
          '--format',
          '{{.Id}} {{.Os}}/{{.Architecture}}',
          request.reference,
        ], { signal });
        const [id, platform] = info.stdout.trim().split(' ');
        if (info.code || platform !== request.platform || !/^sha256:[a-f0-9]{64}$/.test(id))
          throw new Error('构建没有生成所选平台的本地镜像');
        builtId = id;
      });
      await stage(2, async () => {
        const label = request.reference.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 100);
        const name = `${label}-${request.platform.split('/')[1]}.tar`;
        const pending = plainPath(path.join(dir, 'export.partial.tar'));
        const output = plainPath(path.join(dir, name));
        try {
          log('正在导出：' + name + '\n');
          const result = await dockerRun(
            request.engine,
            [
              'image',
              'save',
              '--output',
              await dockerPath(request.engine, pending, signal),
              request.reference,
            ],
            {
              timeout: 60 * 60_000,
              encoding: 'utf8',
              onData: log,
              signal,
            },
          );
          if (result.code) throw new Error('导出镜像包失败（退出码 ' + result.code + '）');
          log('正在校验镜像包并计算 SHA-256。\n');
          const archive = await inspectImageArchive(pending, signal);
          if (
            archive.reference !== request.reference ||
            archive.platform !== request.platform ||
            !imageIdentities(archive).includes(builtId)
          )
            throw new Error('导出的镜像与本次构建结果不一致');
          signal.throwIfAborted();
          // 发布最终文件已进入提交阶段，取消只能在此之前生效。
          this.buildAbort = undefined;
          await rename(pending, output);
          task.archive = { ...archive, name, path: output };
          log(`镜像包已生成：${output}\nSHA-256：${archive.hash}\n`);
        } finally {
          await rm(pending, { force: true }).catch((error) =>
            log('[WARNING] 临时文件待清理：' + errorText(error) + '\n'),
          );
        }
      });
    });
    this.buildAbort = abort;
    this.buildingJar = request.mode === 'build';
    return started;
  }

  import(
    id: string,
    source: ImageSource,
    server: string,
    connect: () => Promise<{ transport: Transport; credential?: string }>,
    checked: ImageCheck,
  ) {
    const job: ImageJob = {
      id,
      name: checked.archive.reference,
      kind: 'import',
      status: 'running',
      started: Date.now(),
      server,
      stages: [
        '连接与检查',
        '上传镜像包',
        '核对 SHA-256',
        '加载镜像',
        '核验服务器镜像',
        '清理临时包',
      ].map((name) => ({ name, status: 'pending' })),
    };
    return this.start(job, async (task, _dir, { log, stage, checkpoint }) => {
      let transport: Transport | undefined,
        packageFile: ImagePackage,
        alreadyPresent = false,
        remoteDirectory: string;
      let loadAttempted = false;
      let secret = new MemoryCredentials({});
      try {
        await stage(0, async () => {
          log('校验本机镜像包并连接 ' + server + '。\n');
          packageFile = await this.archive(source);
          if (checked.archive.hash !== packageFile.hash)
            throw new Error('镜像包内容已变化，请重新检查并确认');
          const response = await connect();
          const credential = response.credential;
          if (credential) secret = new MemoryCredentials({ image: credential });
          transport = response.transport;
          await transport.connect();
          const check = await checkImageImport(transport, server, packageFile);
          if (check.remoteDirectory !== checked.remoteDirectory)
            throw new Error('远程目录已变更，请重新检查并确认');
          // 仅核验的确认只允许执行只读操作。
          if (checked.alreadyPresent && !check.alreadyPresent)
            throw new Error('服务器上的相同镜像已不存在，请重新检查并确认上传与导入');
          alreadyPresent = check.alreadyPresent;
          remoteDirectory = check.remoteDirectory;
          task.archive = packageFile;
          log(`Docker 平台 ${packageFile.platform} · 临时目录可用 ${imageSize(check.free)}\n`);
        });
        if (!alreadyPresent) {
          const abort = new AbortController();
          this.uploadAbort = abort;
          await stage(1, async () => {
            abort.signal.throwIfAborted();
            const remote = await createImageUpload(
              transport!,
              remoteDirectory,
              task.id,
              /\.gz$/i.test(packageFile.name),
            );
            task.remoteFile = remote;
            await checkpoint();
            this.emit.job(task);
            if (remote !== checked.uploadFile) throw new Error('实际上传路径与确认路径不一致');
            log('上传到：' + remote + '\n');
            const started = Date.now();
            let last = 0;
            await transport!.upload(
              packageFile.path,
              remote,
              (bytes) => {
                const now = Date.now();
                if (bytes < packageFile.size && now - last < 200) return;
                last = now;
                task.upload = {
                  bytes,
                  size: packageFile.size,
                  speed: (bytes * 1000) / Math.max(1, now - started),
                };
                this.emit.job(task);
              },
              AbortSignal.any([abort.signal, AbortSignal.timeout(60 * 60_000)]),
            );
            abort.signal.throwIfAborted();
          }).finally(() => {
            this.uploadAbort = undefined;
          });
          await stage(2, async () => {
            await verifyUploadedImage(transport!, task.remoteFile!, packageFile.hash);
            log('上传文件的 SHA-256 与本机一致。\n');
          });
          await stage(3, async () => {
            loadAttempted = true;
            await loadRemoteImage(transport!, task.remoteFile!, packageFile, (text) =>
              log(secret.redact(text)),
            );
          });
        } else {
          for (const index of [1, 2, 3, 5]) task.stages[index].status = 'skipped';
          log('服务器已有同一镜像，直接核验，无需上传或加载。\n');
        }
        await stage(4, async () => {
          task.remoteImageId = await verifyRemoteImage(transport!, packageFile);
          log(
            `已核验 ${packageFile.reference} · ${packageFile.platform} · ${task.remoteImageId}\n`,
          );
        });
        if (task.remoteFile) {
          try {
            await stage(5, async () => {
              await cleanImageUpload(transport!, task.remoteFile!);
              task.remoteFile = undefined;
              log('远程临时包已删除，本机镜像包保留。\n');
            });
          } catch (error) {
            task.stages[5].status = 'failed';
            task.stages[5].finished = Date.now();
            task.message = '镜像已核验，远程临时包待清理：' + task.remoteFile;
            log('[WARNING] ' + secret.redact(errorText(error)) + '\n');
          }
        }
      } catch (error) {
        if (transport && task.remoteFile && !loadAttempted) {
          await cleanImageUpload(transport, task.remoteFile)
            .then(() => {
              task.remoteFile = undefined;
            })
            .catch(() => {});
        }
        const message = task.cancelling
          ? '已取消上传，未加载镜像'
          : secret.redact(errorText(error));
        throw new Error(
          task.remoteFile ? message + '；保留远程临时包：' + task.remoteFile : message,
        );
      } finally {
        transport?.close();
        secret.clear();
      }
    });
  }
}
