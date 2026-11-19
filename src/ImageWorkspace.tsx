import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Circle, Container, Hammer, Loader2, Minus, X } from 'lucide-react';
import { AppPageHeader } from './design/shell/AppPageHeader';
import { Button } from './design/ui/button';
import { PageTabs } from './design/ui/page-tabs';
import { SegmentedControl } from './design/ui/segmented-control';
import { BuildArtifactChoice } from './BuildArtifactChoice';
import { CompactStatus, historyDay, type CompactTone } from './compact-list';
import {
  type ImageBuild,
  type ImageCheck,
  type ImageEngine,
  type ImageJob,
  type ImageLogChunk,
  type ImagePackage,
  type ImageSource,
  imageSize,
} from './images';
import { LogAccumulator, type LogLine } from './log-model';
import { VirtualLogs } from './LogViewer';
import { fmtTime, localJar, seconds, type Artifact, type Database, type Service } from './model';
import { type DesktopAPI } from './platform';
import { Badge, Field, Modal, PathInput } from './ui';
import { UploadProgress } from './UploadProgress';

type ImageTab = 'build' | 'packages' | 'import';
type PackageFilter = 'running' | 'finished' | 'all';
const packageFilters = [
  { value: 'running', label: '执行中' },
  { value: 'finished', label: '已结束' },
  { value: 'all', label: '全部' },
] as const;
const tabs = [
  { value: 'build', label: '构建镜像包' },
  { value: 'packages', label: '镜像包' },
  { value: 'import', label: '导入到服务器' },
] as const;
const jobStatus = {
  running: '执行中',
  success: '已完成',
  failed: '失败',
  interrupted: '中断',
  cancelled: '已取消',
};
const jobTone: Record<ImageJob['status'], CompactTone> = {
  running: 'progress',
  success: 'good',
  failed: 'bad',
  interrupted: 'warn',
  cancelled: 'neutral',
};
const stageStatus = {
  running: '进行中',
  success: '已完成',
  failed: '失败',
  pending: '等待',
  skipped: '已跳过',
};
const stageIcons = { running: Loader2, success: Check, failed: X, pending: Circle, skipped: Minus };
const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': Error:\s*/,
    '',
  );

export function ImageWorkspace({
  api,
  db,
  serviceId,
  saved,
  followLogs,
  dataDir,
}: {
  api: DesktopAPI;
  db: Database;
  serviceId: string;
  saved: string[];
  followLogs: boolean;
  dataDir: string;
}) {
  const [page, setPage] = useState<ImageTab>('build');
  const [packageFilter, setPackageFilter] = useState<PackageFilter>('running');
  const [jobs, setJobs] = useState<ImageJob[]>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [directory, setDirectory] = useState(dataDir + '\\images');
  const [taskId, setTaskId] = useState('');
  const tabsId = useId();
  const packageScroll = useRef<HTMLDivElement>(null);
  const packageReturn = useRef<{ id: string; top: number }>(undefined);
  const [importBuild, setImportBuild] = useState('');
  const [selected, setSelected] = useState(serviceId);
  const service = db.services.find((entry) => entry.id === selected) || db.services[0];
  const busy = jobs?.some((job) => job.status === 'running') ?? false;
  const task = jobs?.find((job) => job.id === taskId);
  const record = (job: ImageJob) => {
    setJobs((previous) =>
      [job, ...(previous || []).filter((item) => item.id !== job.id)].sort(
        (a, b) => b.started - a.started,
      ),
    );
  };
  useEffect(() => {
    let alive = true;
    const live = new Map<string, ImageJob>();
    setError('');
    const stop = api.onEvent((event) => {
      if (event.kind !== 'image-job') return;
      live.set(event.job.id, event.job);
      record(event.job);
    });
    void api
      .listImageJobs()
      .then(({ directory, jobs }) => {
        if (!alive) return;
        setDirectory(directory);
        setJobs(
          [...live.values(), ...jobs.filter((job) => !live.has(job.id))].sort(
            (a, b) => b.started - a.started,
          ),
        );
      })
      .catch((error) => {
        if (alive) setError(message(error));
      });
    return () => {
      alive = false;
      stop();
    };
  }, [api, reload]);
  useLayoutEffect(() => {
    const saved = packageReturn.current;
    const list = packageScroll.current;
    if (taskId || page !== 'packages' || !saved || !list) return;
    list.scrollTop = saved.top;
    const row = list.querySelector<HTMLElement>(`[data-image-job="${CSS.escape(saved.id)}"]`);
    (row || list.querySelector<HTMLElement>('[aria-pressed="true"]'))?.focus({
      preventScroll: true,
    });
    packageReturn.current = undefined;
  }, [page, taskId]);
  const openTask = (id: string) => {
    packageReturn.current = { id, top: packageScroll.current?.scrollTop || 0 };
    setTaskId(id);
  };
  return (
    <section className="image-workspace">
      <AppPageHeader
        className="desktop-page-header"
        title={
          task ? task.name + ' · ' + (task.kind === 'build' ? '镜像构建' : '镜像导入') : '镜像工具'
        }
        truncateTitle
        icon={!task ? <Container size={20} strokeWidth={1.5} /> : undefined}
        actions={task ? <ImageTaskActions job={task} onBack={() => setTaskId('')} /> : undefined}
      />
      {task ? (
        <ImageTask key={task.id} api={api} job={task} followLogs={followLogs} />
      ) : (
        <>
          <PageTabs<ImageTab>
            className="service-workspace-tabs"
            aria-label="镜像工具"
            value={page}
            onValueChange={setPage}
            items={[...tabs]}
            idPrefix={tabsId}
            controls={(value) => tabsId + '-panel-' + value}
          />
          {error && (
            <div className="image-list-error warning row spread" role="alert">
              {error}
              <Button variant="neutral" size="compact" onClick={() => setReload(reload + 1)}>
                重新读取
              </Button>
            </div>
          )}
          <div
            className="image-panel"
            role="tabpanel"
            id={tabsId + '-panel-build'}
            aria-labelledby={tabsId + '-build'}
            hidden={page !== 'build'}
          >
            {service ? (
              <BuildImageForm
                key={service.id}
                api={api}
                directory={directory}
                service={service}
                services={db.services}
                selectService={setSelected}
                busy={busy}
                onStart={(job) => {
                  record(job);
                  setPackageFilter('running');
                  setPage('packages');
                }}
              />
            ) : (
              <p className="empty">请先在服务管理中添加服务，再构建镜像包。</p>
            )}
          </div>
          <div
            className="image-content"
            ref={packageScroll}
            role="tabpanel"
            id={tabsId + '-panel-packages'}
            aria-labelledby={tabsId + '-packages'}
            hidden={page !== 'packages'}
          >
            <ImagePackages
              jobs={jobs}
              error={error}
              filter={packageFilter}
              onFilter={setPackageFilter}
              onBuild={() => setPage('build')}
              onTask={openTask}
              onCancelBuild={(id) => {
                setError('');
                void api.cancelImageBuild(id).catch((error) => setError(String(error)));
              }}
              onImport={(id) => {
                setImportBuild(id);
                setPage('import');
              }}
            />
          </div>
          <div
            className="image-panel"
            role="tabpanel"
            id={tabsId + '-panel-import'}
            aria-labelledby={tabsId + '-import'}
            hidden={page !== 'import'}
          >
            {page === 'import' && (
              <ImportImageForm
                api={api}
                db={db}
                saved={saved}
                jobs={jobs || []}
                initialBuild={importBuild}
                busy={busy}
                record={record}
                followLogs={followLogs}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}

function BuildImageForm({
  api,
  directory,
  service,
  services,
  selectService,
  busy,
  onStart,
}: {
  api: DesktopAPI;
  directory: string;
  service: Service;
  services: Service[];
  selectService: (value: string) => void;
  busy: boolean;
  onStart: (job: ImageJob) => void;
}) {
  const [engine, setEngine] = useState<ImageEngine['kind']>('wsl');
  const [distributions, setDistributions] = useState<string[]>();
  const [distro, setDistro] = useState('');
  const [wslError, setWslError] = useState('');
  const [engineResult, setEngineResult] = useState('');
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<ImageBuild['mode']>('existing');
  const [jarFile, setJarFile] = useState<string>();
  const [artifact, setArtifact] = useState<Artifact>();
  const [dockerfile, setDockerfile] = useState(
    service.root.replace(/[\\/]+$/, '') + '\\Dockerfile',
  );
  const [context, setContext] = useState(service.root);
  const [name, setName] = useState(service.code.toLowerCase().replace(/[^a-z0-9_.-]/g, '-'));
  const [tag, setTag] = useState('latest');
  const [platform, setPlatform] = useState<ImageBuild['platform']>('linux/amd64');
  useEffect(() => {
    if (mode !== 'existing') return;
    let active = true;
    setArtifact(undefined);
    void api
      .serviceInfo(service.id, jarFile)
      .then(({ artifact }) => {
        if (active) setArtifact(artifact);
      })
      .catch(() => {
        if (active)
          setArtifact({
            name: service.jarName,
            path: '',
            modified: '',
            size: 0,
            exists: false,
            source: 'unknown',
          });
      });
    return () => {
      active = false;
    };
  }, [api, service.id, service.jarName, jarFile, mode]);
  const pickJar = async () => {
    try {
      const file = await api.choose('jar');
      if (file) {
        setError('');
        setJarFile(file);
      }
    } catch (error) {
      setError(message(error));
    }
  };
  useEffect(() => {
    let alive = true;
    if (engine === 'wsl')
      void api
        .imageDistributions()
        .then((values) => {
          if (alive) {
            setDistributions(values);
            setDistro((old) =>
              values.includes(old)
                ? old
                : values.find((value) => !/^docker-desktop/i.test(value)) || values[0] || '',
            );
            setWslError(values.length ? '' : '未找到 WSL 发行版，可切换到 Windows Docker。');
          }
        })
        .catch((error) => {
          if (alive) {
            setDistributions([]);
            setWslError(message(error));
          }
        });
    return () => {
      alive = false;
    };
  }, [api, engine]);
  const selection = { kind: engine, distro: engine === 'wsl' ? distro || undefined : undefined };
  const ready = engine === 'windows' || !!distro;
  const checkEngine = async () => {
    setChecking(true);
    setEngineResult('');
    setError('');
    try {
      setEngineResult(await api.probeImageEngine(selection));
    } catch (error) {
      setError(message(error));
    } finally {
      setChecking(false);
    }
  };
  const start = async () => {
    if (!ready || starting || busy) return;
    setStarting(true);
    setError('');
    try {
      onStart(
        await api.startImageBuild({
          serviceId: service.id,
          engine: selection,
          mode,
          jarPath: mode === 'existing' ? jarFile : undefined,
          dockerfile,
          context,
          reference: name.trim() + ':' + tag.trim(),
          platform,
        }),
      );
    } catch (error) {
      setError(message(error));
    } finally {
      setStarting(false);
    }
  };
  return (
    <form
      className="image-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <div className="image-content image-config">
        <div className="card-head">
          <h2>构建配置</h2>
        </div>
        <div className="form-grid">
          <Field label="服务">
            <select value={service.id} onChange={(event) => selectService(event.target.value)}>
              {services.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="field">
            <span className="field-label">构建环境</span>
            <div className="row wrap">
              <SegmentedControl
                aria-label="构建环境"
                size="sm"
                value={engine}
                onValueChange={(value) => {
                  setEngine(value);
                  setEngineResult('');
                  setError('');
                }}
                items={[
                  { value: 'wsl', label: 'WSL', disabled: checking },
                  { value: 'windows', label: 'Windows Docker', disabled: checking },
                ]}
              />
              <Button
                type="button"
                variant="neutral"
                size="compact"
                disabled={!ready || checking}
                onClick={() => void checkEngine()}
              >
                {checking ? '检测中…' : '检测环境'}
              </Button>
            </div>
          </div>
          {engine === 'wsl' && (
            <Field label="WSL 发行版" hint={wslError || undefined}>
              <select
                value={distro}
                disabled={checking || !distributions?.length}
                onChange={(event) => {
                  setDistro(event.target.value);
                  setEngineResult('');
                }}
              >
                {!distributions?.length && (
                  <option value="">{distributions ? '暂无发行版' : '正在读取发行版…'}</option>
                )}
                {distributions?.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </Field>
          )}
          {engineResult && (
            <p className="note wide" role="status">
              {engineResult}
            </p>
          )}
          <div className="field wide image-artifact">
            <BuildArtifactChoice
              name={
                mode === 'existing'
                  ? artifact?.name || jarFile?.split(/[\\/]/).at(-1) || service.jarName
                  : service.jarName
              }
              summary={
                mode === 'build'
                  ? '先按服务配置重新构建 JAR'
                  : !artifact
                    ? '正在检查本地 JAR…'
                    : artifact.exists
                      ? imageSize(artifact.size) + ' · ' + fmtTime(artifact.modified)
                      : '尚无可用 JAR'
              }
              mode={mode === 'build' ? 'rebuild' : 'existing'}
              onMode={(value) => setMode(value === 'rebuild' ? 'build' : 'existing')}
              onPick={() => void pickJar()}
            />
            <small className="path">{(mode === 'existing' && jarFile) || localJar(service)}</small>
            {mode === 'existing' && jarFile && (
              <div className="row wrap">
                <small>
                  所选文件须在构建目录内，Dockerfile 通过 <code>YOTOO_JAR_FILE</code> 参数引用。
                </small>
                <Button
                  type="button"
                  variant="link"
                  size="compact"
                  onClick={() => setJarFile(undefined)}
                >
                  使用服务默认 JAR
                </Button>
              </div>
            )}
          </div>
          <Field label="Dockerfile">
            <PathInput
              browseOnly
              label="Dockerfile"
              kind="dockerfile"
              value={dockerfile}
              onChange={setDockerfile}
              onError={(error) => setError(message(error))}
            />
          </Field>
          <Field label="构建目录">
            <PathInput
              browseOnly
              label="构建目录"
              kind="directory"
              value={context}
              onChange={setContext}
              onError={(error) => setError(message(error))}
            />
          </Field>
          <Field label="镜像名">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              placeholder="例如 yotoo/crm"
            />
          </Field>
          <Field label="版本标签">
            <input value={tag} onChange={(event) => setTag(event.target.value)} required />
          </Field>
          <Field label="目标平台">
            <select
              value={platform}
              onChange={(event) => setPlatform(event.target.value as ImageBuild['platform'])}
            >
              <option>linux/amd64</option>
              <option>linux/arm64</option>
            </select>
          </Field>
        </div>
        <p className="note">
          保存到 <code className="path">{directory}</code>
        </p>
        {error && (
          <p className="warning" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="deployment-footer image-footer" role="group" aria-label="镜像构建操作">
        <Button type="submit" disabled={!ready || busy || starting}>
          <Hammer size={16} />
          {starting ? '正在启动…' : '构建并导出'}
        </Button>
      </footer>
    </form>
  );
}

function ImagePackages({
  jobs,
  error,
  filter,
  onFilter,
  onTask,
  onImport,
  onBuild,
  onCancelBuild,
}: {
  jobs?: ImageJob[];
  error: string;
  filter: PackageFilter;
  onFilter: (filter: PackageFilter) => void;
  onTask: (id: string) => void;
  onImport: (id: string) => void;
  onBuild: () => void;
  onCancelBuild: (id: string) => void;
}) {
  const visible = (jobs || []).filter(
    (job) =>
      filter === 'all' ||
      (filter === 'running' ? job.status === 'running' : job.status !== 'running'),
  );
  const now = useImageTime(visible.some((job) => job.status === 'running'));
  return (
    <section className="image-package-section">
      <div className="row spread">
        <SegmentedControl<PackageFilter>
          aria-label="镜像任务状态筛选"
          size="sm"
          items={[...packageFilters]}
          value={filter}
          onValueChange={onFilter}
        />
        <Button size="compact" onClick={onBuild}>
          构建镜像包
        </Button>
      </div>
      {!jobs && !error ? (
        <p className="note" role="status">
          正在读取镜像任务…
        </p>
      ) : !jobs ? null : !visible.length ? (
        <div className="empty service-empty">
          <strong>{jobs.length ? '当前状态下暂无镜像任务' : '暂无镜像任务'}</strong>
          {jobs.length > 0 && (
            <Button variant="link" size="compact" onClick={() => onFilter('all')}>
              查看全部任务
            </Button>
          )}
        </div>
      ) : (
        <table className="compact-table history-table image-package-table" aria-label="镜像包列表">
          <colgroup>
            <col className="history-state-col" />
            <col />
            <col className="image-reference-col" />
            <col className="history-time-col" />
            <col className="history-elapsed-col" />
            <col className="image-action-col" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">状态</th>
              <th scope="col">任务 · 镜像包</th>
              <th scope="col">镜像标签／服务器</th>
              <th scope="col">开始</th>
              <th scope="col">耗时</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((job, index) => {
              const name = job.kind === 'build' ? job.archive?.name || job.name : job.name;
              const detail = job.kind === 'import' ? job.server : job.archive?.reference;
              const started = new Date(job.started).toISOString();
              const day = historyDay(started);
              const previous = visible[index - 1];
              const newDay =
                !previous || historyDay(new Date(previous.started).toISOString()).key !== day.key;
              const elapsed =
                job.finished || job.status === 'running'
                  ? seconds(((job.finished || now) - job.started) / 1000)
                  : '—';
              const status =
                job.status === 'running'
                  ? job.kind === 'build'
                    ? job.cancelling ? '正在取消' : '正在构建'
                    : '正在导入'
                  : jobStatus[job.status];
              return (
                <Fragment key={job.id}>
                  {newDay && (
                    <tr className="history-day">
                      <td colSpan={6}>{day.label}</td>
                    </tr>
                  )}
                  <tr
                    className="compact-data-row"
                    data-image-job={job.id}
                    tabIndex={0}
                    aria-label={'查看镜像任务：' + name}
                    onClick={(event) => {
                      if (!(event.target as HTMLElement).closest('button')) onTask(job.id);
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.target !== event.currentTarget ||
                        !['Enter', ' '].includes(event.key)
                      )
                        return;
                      event.preventDefault();
                      onTask(job.id);
                    }}
                  >
                    <td>
                      <CompactStatus tone={jobTone[job.status]} label={status} />
                    </td>
                    <td>
                      <div className="history-content">
                        <span className="history-operation">
                          {job.kind === 'build' ? '构建' : '导入'}
                        </span>
                        <strong className="compact-ellipsis" title={name}>
                          {name}
                        </strong>
                      </div>
                    </td>
                    <td>
                      <span className="compact-ellipsis" title={detail}>
                        {detail || '—'}
                      </span>
                    </td>
                    <td>
                      <time dateTime={started} title={fmtTime(started)}>
                        {fmtTime(started).slice(11, 16)}
                      </time>
                    </td>
                    <td>
                      <span className="compact-ellipsis" title={elapsed}>
                        {elapsed}
                      </span>
                    </td>
                    <td>
                      {job.kind === 'build' && job.status === 'running' && (
                        <Button
                          variant="neutral"
                          size="compact"
                          disabled={job.cancelling}
                          onClick={() => onCancelBuild(job.id)}
                        >
                          {job.cancelling ? '正在取消…' : '取消构建'}
                        </Button>
                      )}
                      {job.kind === 'build' && job.status === 'success' && job.archive && (
                        <Button variant="neutral" size="compact" onClick={() => onImport(job.id)}>
                          导入到服务器
                        </Button>
                      )}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function useImageLogs(api: DesktopAPI, id: string) {
  const [entries, setEntries] = useState<LogLine[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const accumulator = new LogAccumulator();
    let loading = true,
      alive = true;
    let pending: ImageLogChunk[] = [];
    const append = (chunks: ImageLogChunk[]) => {
      for (const { text, offset, step, time } of chunks)
        accumulator.append(id, text, offset, { step, time });
      setEntries([...accumulator.entries]);
    };
    const stop = api.onEvent((event) => {
      if (event.kind !== 'image-log' || event.id !== id) return;
      if (loading) pending.push(...event.chunks);
      else append(event.chunks);
    });
    void api
      .readImageLogs(id)
      .catch((error) => {
        if (alive) setError('读取日志失败：' + message(error));
        return [];
      })
      .then((chunks) => {
        if (!alive) return;
        loading = false;
        append([...chunks, ...pending].sort((a, b) => a.offset - b.offset));
        pending = [];
      });
    return () => {
      alive = false;
      stop();
    };
  }, [api, id]);
  return { entries, error };
}

function useImageTime(running: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}
function ImageTaskActions({ job, onBack }: { job: ImageJob; onBack: () => void }) {
  const now = useImageTime(job.status === 'running');
  return (
    <>
      <Badge
        kind={
          job.status === 'failed'
            ? 'danger'
            : job.status === 'success'
              ? 'good'
              : job.status === 'interrupted'
                ? 'warn'
                : ''
        }
      >
        {jobStatus[job.status]}
      </Badge>
      <span className="task-duration">{seconds(((job.finished || now) - job.started) / 1000)}</span>
      <Button variant="neutral" size="compact" onClick={onBack}>
        <ArrowLeft size={16} />
        返回镜像包
      </Button>
    </>
  );
}

function ImageTask({
  api,
  job,
  followLogs,
}: {
  api: DesktopAPI;
  job: ImageJob;
  followLogs: boolean;
}) {
  const [focus, setFocus] = useState<{ name: string; nonce: number }>();
  return (
    <div className="task-page image-task">
      <ImageStages job={job} onStage={(name) => setFocus({ name, nonce: Date.now() })} />
      {job.message && (
        <p
          className={job.status === 'failed' ? 'warning image-failure' : 'warning'}
          role={job.status === 'failed' ? 'alert' : 'status'}
        >
          {job.message}
        </p>
      )}
      <ImageTaskLogs api={api} job={job} followLogs={followLogs} focus={focus} />
      {job.archive && job.kind === 'build' && (
        <div className="image-result">
          <strong className="task-tone-success">
            镜像包已生成 · {imageSize(job.archive.size)}
          </strong>
          <code className="path">{job.archive.path}</code>
          <small className="path">SHA-256 {job.archive.hash}</small>
        </div>
      )}
    </div>
  );
}

function ImageStages({ job, onStage }: { job: ImageJob; onStage?: (name: string) => void }) {
  const now = useImageTime(job.status === 'running');
  return (
    <div
      className="task-stages"
      role="group"
      aria-label={job.kind === 'build' ? '构建阶段' : '导入阶段'}
    >
      {job.stages.map((stage) => {
        const Icon = stageIcons[stage.status];
        const contents = (
          <>
            {job.kind === 'build' && (
              <Icon
                size={16}
                aria-hidden="true"
                className={stage.status === 'running' ? 'spin' : undefined}
              />
            )}
            <span>
              <strong>{stage.name}</strong>
              <small>
                {stageStatus[stage.status]}
                {stage.started
                  ? ' · ' +
                    seconds(((stage.finished || job.finished || now) - stage.started) / 1000)
                  : ''}
              </small>
            </span>
          </>
        );
        const className = 'task-stage task-tone-' + stage.status;
        return onStage ? (
          <button
            type="button"
            key={stage.name}
            className={className}
            onClick={() => onStage(stage.name)}
          >
            {contents}
          </button>
        ) : (
          <div key={stage.name} className={className}>
            {contents}
          </div>
        );
      })}
    </div>
  );
}

function ImageTaskLogs({
  api,
  job,
  followLogs,
  focus,
}: {
  api: DesktopAPI;
  job: ImageJob;
  followLogs: boolean;
  focus?: { name: string; nonce: number };
}) {
  const { entries, error } = useImageLogs(api, job.id);
  const upload =
    job.status === 'running' && job.stages[1]?.status === 'running' ? job.upload : undefined;
  return (
    <div className="task-log-card image-logs">
      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      <VirtualLogs
        entries={entries}
        compact
        initialFollow={followLogs}
        focusStep={focus}
        trailing={
          upload ? (
            <UploadProgress
              upload={{
                ...upload,
                total: upload.size,
                percent: Math.floor((upload.bytes * 100) / upload.size),
              }}
            />
          ) : undefined
        }
      />
    </div>
  );
}

function PackageSummary({ archive }: { archive: ImagePackage }) {
  return (
    <dl className="image-facts">
      <dt>镜像包</dt>
      <dd className="path">
        {archive.name} · {imageSize(archive.size)}
      </dd>
      <dt>镜像标签</dt>
      <dd className="path">{archive.reference}</dd>
      <dt>平台</dt>
      <dd>{archive.platform}</dd>
      <dt>SHA-256</dt>
      <dd className="path">{archive.hash}</dd>
    </dl>
  );
}

function ImportImageForm({
  api,
  db,
  saved,
  jobs,
  initialBuild,
  busy,
  record,
  followLogs,
}: {
  api: DesktopAPI;
  db: Database;
  saved: string[];
  jobs: ImageJob[];
  initialBuild: string;
  busy: boolean;
  record: (job: ImageJob) => void;
  followLogs: boolean;
}) {
  const packages = jobs.filter(
    (job) => job.kind === 'build' && job.status === 'success' && job.archive,
  );
  const [sourceKind, setSourceKind] = useState<'build' | 'file'>(
    packages.length ? 'build' : 'file',
  );
  const [buildId, setBuildId] = useState(initialBuild || packages[0]?.id || '');
  const [file, setFile] = useState('');
  const [serverId, setServerId] = useState(db.servers[0]?.id || '');
  const [credential, setCredential] = useState('');
  const [active, setActive] = useState('');
  const [opened, setOpened] = useState<'inspect' | 'check' | 'confirm' | 'task'>();
  const [archive, setArchive] = useState<ImagePackage>();
  const [check, setCheck] = useState<ImageCheck & { token: string }>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const credentialId = useId();
  const focusFrom = useRef<HTMLElement>(undefined);
  const server = db.servers.find((entry) => entry.id === serverId);
  const task = jobs.find((entry) => entry.id === active);
  const source: ImageSource | undefined =
    sourceKind === 'file' ? (file ? { file } : undefined) : buildId ? { buildId } : undefined;
  const clearCheck = () => {
    setCheck(undefined);
    setArchive(undefined);
    setError('');
  };
  const close = () => {
    setOpened(undefined);
    setError('');
  };
  const open = async (next: 'inspect' | 'check' | 'confirm', button: HTMLElement) => {
    if (!source || working) return;
    focusFrom.current = button;
    setError('');
    setOpened(next);
    if (next === 'confirm' && check) return;
    setWorking(true);
    try {
      if (next === 'inspect') setArchive(await api.inspectImagePackage(source));
      else if (server) setCheck(await api.checkImageImport(source, server.id, credential));
    } catch (error) {
      setError(message(error));
    } finally {
      setWorking(false);
    }
  };
  const start = async () => {
    if (!check) return;
    setWorking(true);
    setError('');
    try {
      const job = await api.startImageImport(check.token, credential);
      record(job);
      setActive(job.id);
      setCredential('');
      setCheck(undefined);
      setOpened('task');
    } catch (error) {
      setCheck(undefined);
      setError(message(error));
    } finally {
      setWorking(false);
    }
  };
  const cancelUpload = async () => {
    if (!task) return;
    try {
      await api.cancelImageUpload(task.id);
    } catch (error) {
      setError(message(error));
    }
  };
  return (
    <section className="image-panel" aria-label="导入到服务器">
      <div className="image-content image-config">
        <div className="card-head">
          <h2>导入到服务器</h2>
        </div>
        <div className="form-grid">
          <div className="field wide">
            <span className="field-label">镜像来源</span>
            <div>
              <SegmentedControl
                aria-label="镜像来源"
                size="sm"
                value={sourceKind}
                onValueChange={(value) => {
                  setSourceKind(value);
                  clearCheck();
                }}
                items={[
                  { value: 'build', label: '已构建的镜像包' },
                  { value: 'file', label: '本机文件' },
                ]}
              />
            </div>
          </div>
          {sourceKind === 'build' ? (
            <Field label="镜像包">
              <select
                value={buildId}
                onChange={(event) => {
                  setBuildId(event.target.value);
                  clearCheck();
                }}
              >
                <option value="">请选择</option>
                {packages.map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.archive?.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="镜像包" hint="支持由 Docker 导出的单平台 .tar 和 .tar.gz。">
              <PathInput
                browseOnly
                label="镜像包"
                kind="image-archive"
                value={file}
                onChange={(value) => {
                  setFile(value);
                  clearCheck();
                }}
                onError={(error) => setError(message(error))}
              />
            </Field>
          )}
          <Field label="服务器">
            <select
              value={serverId}
              onChange={(event) => {
                setServerId(event.target.value);
                setCredential('');
                clearCheck();
              }}
            >
              <option value="">请选择</option>
              {db.servers.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </Field>
          {server && server.auth !== 'alias' && !saved.includes(server.id) && (
            <div className="field wide">
              <label htmlFor={credentialId}>
                {server.auth === 'password' ? 'SSH 登录密码' : '私钥口令（如需要）'}
              </label>
              <input
                id={credentialId}
                type="password"
                value={credential}
                autoComplete="off"
                onChange={(event) => {
                  setCredential(event.target.value);
                  clearCheck();
                }}
              />
              <small>仅用于本次检查和导入。</small>
            </div>
          )}
        </div>
        <p className="note">
          镜像包临时上传到 <code>~/.deploy-center/image-imports/任务编号/</code>
          。镜像通过核验后清理远端临时包，本机文件保留。
        </p>
        {!opened && error && (
          <p className="warning" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="deployment-footer image-footer" role="group" aria-label="镜像导入操作">
        <Button
          variant="neutral"
          disabled={!source}
          onClick={(event) => void open('inspect', event.currentTarget)}
        >
          镜像包信息
        </Button>
        <Button
          variant="neutral"
          disabled={!source || !server}
          onClick={(event) => void open('check', event.currentTarget)}
        >
          导入前检查
        </Button>
        <Button
          disabled={!source || !server || busy}
          onClick={(event) => void open('confirm', event.currentTarget)}
        >
          导入镜像
        </Button>
        {task && (
          <Button
            variant="quiet"
            onClick={(event) => {
              focusFrom.current = event.currentTarget;
              setOpened('task');
            }}
          >
            查看本次导入
          </Button>
        )}
      </footer>
      {opened && (
        <Modal
          wide
          title={
            opened === 'inspect'
              ? '镜像包信息'
              : opened === 'check'
                ? '导入前检查'
                : opened === 'confirm'
                  ? '确认导入镜像'
                  : '导入镜像'
          }
          returnFocus={focusFrom.current}
          onClose={close}
          closeDisabled={working}
          footer={
            <>
              <Button variant="neutral" disabled={working} onClick={close}>
                {opened === 'confirm' ? '返回' : '关闭'}
              </Button>
              {opened === 'check' && (
                <Button disabled={working || !check || busy} onClick={() => setOpened('confirm')}>
                  继续导入
                </Button>
              )}
              {opened === 'confirm' && (
                <Button disabled={working || !check || busy} onClick={() => void start()}>
                  确认导入
                </Button>
              )}
              {opened === 'task' &&
                task?.status === 'running' &&
                task.stages[1]?.status === 'running' && (
                  <Button
                    variant="neutral"
                    disabled={task.cancelling}
                    onClick={() => void cancelUpload()}
                  >
                    {task.cancelling ? '正在取消…' : '取消上传'}
                  </Button>
                )}
            </>
          }
        >
          {working && (
            <p role="status" className="row">
              <Loader2 size={16} className="spin" />
              正在检查，请稍候…
            </p>
          )}
          {error && (
            <p className="warning" role="alert">
              {error}
            </p>
          )}
          {!working && opened === 'inspect' && archive && <PackageSummary archive={archive} />}
          {!working && (opened === 'check' || opened === 'confirm') && check && (
            <>
              <p role="status" className="task-tone-success">
                {check.alreadyPresent
                  ? '服务器已有相同镜像，导入时只核验。'
                  : '联系到 Docker 引擎，平台匹配，未发现标签冲突。'}
              </p>
              <PackageSummary archive={check.archive} />
              <dl className="image-facts">
                <dt>服务器</dt>
                <dd>{check.server}</dd>
                <dt>{opened === 'confirm' ? '上传路径' : '临时目录'}</dt>
                <dd className="path">
                  {opened === 'confirm' ? check.uploadFile : check.remoteDirectory}
                </dd>
                <dt>可用空间</dt>
                <dd>{imageSize(check.free)}</dd>
              </dl>
              {opened === 'confirm' && (
                <p className="note">
                  上传后的 SHA-256 和加载后的镜像 ID 均通过核验，才会清理远端临时包。
                </p>
              )}
            </>
          )}
          {opened === 'task' && task && (
            <div className="image-import-task">
              <p
                role="status"
                className={
                  task.status === 'success'
                    ? 'task-tone-success'
                    : task.status === 'failed'
                      ? 'task-tone-failed'
                      : undefined
                }
              >
                {task.status === 'success' ? '服务器镜像已核验' : jobStatus[task.status]} ·{' '}
                {task.name} · {task.server}
              </p>
              <ImageStages job={task} />
              {task.remoteFile && <p className="note path">远程临时包 {task.remoteFile}</p>}
              {task.message && (
                <p
                  className={task.status === 'failed' ? 'warning image-failure' : 'warning'}
                  role={task.status === 'failed' ? 'alert' : 'status'}
                >
                  {task.message}
                </p>
              )}
              <ImageTaskLogs key={task.id} api={api} job={task} followLogs={followLogs} />
              {task.status === 'success' && task.remoteImageId && (
                <p className="note path">镜像 ID {task.remoteImageId}</p>
              )}
            </div>
          )}
        </Modal>
      )}
    </section>
  );
}
