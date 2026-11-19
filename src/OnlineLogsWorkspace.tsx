import { useEffect, useMemo, useRef, useState } from 'react';
import { Ellipsis, Pause, Play, Search } from 'lucide-react';
import { Button } from './design/ui/button';
import { SegmentedControl } from './design/ui/segmented-control';
import { VirtualLogs } from './LogViewer';
import { LogAccumulator, logLevel, type LogLine } from './log-model';
import { imageSize } from './images';
import type { DesktopAPI, DesktopEvent } from './platform';
import {
  onlineLargeLog,
  onlineLogLimit,
  onlineLogSessionLimit,
  onlineSearchLimit,
  type OnlineDownload,
  type OnlineLogSource,
  type OnlineSearch,
  type OnlineSearchResult,
  type OnlineSession,
} from './online-logs';
import { Badge, Field, Modal } from './ui';
import { MoreMenu } from './EntityActions';

type LogEvent = Extract<DesktopEvent, { kind: 'container-log' }>;
const encoder = new TextEncoder();
const downloadNote = '日志按服务器原文保存。';
const message = (error: unknown) => {
  const detail = String(error)
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '');
  if (
    /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|Timed out while waiting for handshake/i.test(
      detail,
    )
  )
    return '无法连接服务器，请检查地址、SSH 端口和网络后重试。';
  if (/configured authentication methods failed/i.test(detail))
    return 'SSH 认证未通过，请核对用户名、登录密码或私钥口令。';
  return detail;
};

function useOnlineConnection(api: DesktopAPI, targetId: string, initialSession?: string) {
  const [source, setSource] = useState<OnlineLogSource>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [endsAt, setEndsAt] = useState<number>();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [session, setSession] = useState('');
  const current = useRef('');
  const mounted = useRef(false);
  const hydrating = useRef(false);
  const pending = useRef<LogEvent[]>([]);
  const collector = useRef(new LogAccumulator());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const append = (event: LogEvent) => {
    const bytes = encoder.encode(event.text).length;
    const through = event.offset ?? bytes;
    const log = collector.current;
    log.append(event.id, event.text, through - bytes, {
      time: event.context?.time,
    });
    let first = 0;
    const minimum = through - onlineLogLimit;
    // 同时限制字节和行数，避免大量极短行占用过多渲染器内存。
    while (first < log.entries.length && Number(log.entries[first].id.split(':').at(-1)) < minimum)
      first++;
    log.trimFirst(Math.max(first, log.entries.length - 20_000));
    if (event.active !== undefined) setActive(event.active);
    if (event.notice) setNotice(event.notice);
    timer.current ??= setTimeout(() => {
      timer.current = undefined;
      if (mounted.current) setLines([...log.entries]);
    }, 80);
  };
  const attach = async (id: string) => {
    current.current = id;
    hydrating.current = true;
    pending.current = [];
    try {
      const snapshot = await api.readLogSession(id);
      if (!mounted.current || current.current !== id) return;
      clearTimeout(timer.current);
      timer.current = undefined;
      collector.current = new LogAccumulator();
      for (const chunk of snapshot.chunks) {
        collector.current.append(id, chunk.text, chunk.offset - encoder.encode(chunk.text).length, {
          time: chunk.context?.time,
        });
      }
      collector.current.trimFirst(collector.current.entries.length - 20_000);
      setActive(snapshot.active);
      setNotice(snapshot.notice);
      setEndsAt(snapshot.endsAt);
      setSession(id);
      for (const event of pending.current) append(event);
      setLines([...collector.current.entries]);
    } finally {
      pending.current = [];
      hydrating.current = false;
    }
  };
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    const off = api.onEvent((event) => {
      if (event.kind !== 'container-log' || event.id !== current.current) return;
      if (hydrating.current) pending.current.push(event);
      else append(event);
    });
    setBusy(true);
    void api
      .onlineLogSource(targetId)
      .then(async (value) => {
        if (!alive) return;
        setSource(value);
        const id = initialSession || value.session;
        if (id) await attach(id);
      })
      .catch((error) => {
        if (alive) setError(message(error));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      mounted.current = false;
      alive = false;
      off();
      clearTimeout(timer.current);
    };
  }, [api, targetId, initialSession]);

  const connect = async (credential?: string) => {
    setBusy(true);
    setError('');
    try {
      const existing = (await api.onlineLogSource(targetId)).session;
      const id = existing || (await api.followLogs(targetId, credential));
      if (mounted.current) await attach(id);
      return true;
    } catch (error) {
      if (mounted.current) setError(message(error));
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const latestLines = () => [...collector.current.entries];
  return { source, error, busy, active, notice, endsAt, lines, session, connect, latestLines };
}

export function OnlineLogsWorkspace({
  api,
  targets,
  targetId,
  onTarget,
  onConfigure,
  initialSession,
  initialFollow = true,
}: {
  api: DesktopAPI;
  targets: { id: string; name: string }[];
  targetId?: string;
  onTarget?: (id: string) => void;
  onConfigure?: () => void;
  initialSession?: string;
  initialFollow?: boolean;
}) {
  if (!targetId)
    return (
      <div className="empty service-empty">
        <strong>暂无部署目标</strong>
        <p>添加部署目标后即可查看线上日志。</p>
      </div>
    );
  return (
    <OnlineLogPanel
      key={targetId + (initialSession ?? '')}
      {...{
        api,
        targets,
        targetId,
        onTarget,
        onConfigure,
        initialSession,
        initialFollow,
      }}
    />
  );
}

function OnlineLogPanel({
  api,
  targets,
  targetId,
  onTarget,
  onConfigure,
  initialSession,
  initialFollow,
}: {
  api: DesktopAPI;
  targets: { id: string; name: string }[];
  targetId: string;
  onTarget?: (id: string) => void;
  onConfigure?: () => void;
  initialSession?: string;
  initialFollow: boolean;
}) {
  const log = useOnlineConnection(api, targetId, initialSession);
  const [view, setView] = useState<'loaded' | 'server'>('loaded');
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState('all');
  const [following, setFollowing] = useState(initialFollow);
  const [latest, setLatest] = useState(0);
  const [paused, setPaused] = useState<LogLine[]>();
  const [query, setQuery] = useState('');
  const [regex, setRegex] = useState(false);
  const [range, setRange] = useState<OnlineSearch['range']>();
  const [result, setResult] = useState<OnlineSearchResult>();
  const [working, setWorking] = useState('');
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [credentials, setCredentials] = useState(false);
  const [secret, setSecret] = useState('');
  const [sessions, setSessions] = useState<OnlineSession[]>();
  const [loadedConfirm, setLoadedConfirm] = useState(false);
  const [download, setDownload] = useState<OnlineDownload>();
  const [received, setReceived] = useState(0);
  const downloadRef = useRef<string | undefined>(undefined);
  const docker = log.source?.kind === 'docker';
  const configured = !!log.source?.location;
  const selectedRange = range ?? (docker ? '24' : '4');
  const visibleLines = following ? log.lines : (paused ?? log.lines);
  const shown = useMemo(() => {
    const literal = filter.toLocaleLowerCase();
    return visibleLines.filter(
      (line) =>
        (!literal || line.text.toLocaleLowerCase().includes(literal)) &&
        (level === 'all' ||
          (level === 'error' ? logLevel(line.text) === 'error' : logLevel(line.text) !== 'info')),
    );
  }, [visibleLines, filter, level]);
  useEffect(() => {
    const off = api.onEvent((event) => {
      if (event.kind === 'online-log-download' && event.token === downloadRef.current)
        setReceived(event.bytes);
    });
    return () => {
      off();
      if (downloadRef.current)
        void api.cancelOnlineLogDownload(downloadRef.current).catch(() => {});
    };
  }, [api]);
  useEffect(() => {
    if (!following && !paused && log.lines.length) setPaused(log.lines);
  }, [following, paused, log.lines]);

  const run = async (operation: string, fn: () => Promise<void>) => {
    setWorking(operation);
    setError('');
    setFeedback('');
    try {
      await fn();
    } catch (error) {
      setError(message(error));
    } finally {
      setWorking('');
    }
  };
  const changeFollow = (value: boolean) => {
    setFollowing(value);
    setPaused(value ? undefined : log.lines);
  };
  const connect = async (value?: string) => {
    setError('');
    setFeedback('');
    if (await log.connect(value)) {
      setFollowing(initialFollow);
      setPaused(undefined);
      setCredentials(false);
    }
    setSecret('');
  };
  const chooseConnection = () => {
    if ((log.source?.password || log.source?.key) && (!log.source.credentialAvailable || log.error))
      setCredentials(true);
    else void connect();
  };
  const stop = async (id: string) => {
    await api.stopLogs(id);
  };
  const clearDownload = () => {
    if (downloadRef.current) void api.cancelOnlineLogDownload(downloadRef.current).catch(() => {});
    downloadRef.current = undefined;
    setDownload(undefined);
  };
  const describeSessions = () =>
    run('sessions', async () => setSessions(await api.listOnlineLogSessions()));
  const prepareDownload = () =>
    run('size', async () => {
      const plan = await api.prepareOnlineLogDownload(log.session);
      downloadRef.current = plan.token;
      setReceived(0);
      setDownload(plan);
    });
  const canChangeTarget = !working && !log.busy;
  const sourceDescription = log.source
    ? [
        log.source.server,
        log.source.address,
        docker ? 'Docker 容器' : '日志文件',
        log.source.location,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <section className="online-logs" aria-label="线上应用日志">
      <header className="online-log-header">
        <div className="online-log-target">
          {onTarget ? (
            <select
              value={targetId}
              aria-label="日志目标"
              disabled={!canChangeTarget}
              onChange={(event) => onTarget(event.target.value)}
            >
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name}
                </option>
              ))}
            </select>
          ) : (
            <strong className="online-log-target-name">
              {log.source?.target ||
                targets.find((target) => target.id === targetId)?.name ||
                '应用日志'}
            </strong>
          )}
          <Badge kind={log.source?.production ? 'warn' : undefined}>
            {log.source?.production ? '正式环境 · 只读' : '只读'}
          </Badge>
          {sourceDescription && (
            <span className="online-log-source" title={sourceDescription}>
              {sourceDescription}
            </span>
          )}
        </div>
        <div className="online-log-actions">
          <Badge kind={log.active ? 'good' : undefined}>
            {log.busy
              ? '连接中'
              : log.active
                ? following
                  ? '正在跟随'
                  : '已暂停'
                : log.session
                  ? '已断开'
                  : '未连接'}
          </Badge>
          {!log.active ? (
            <Button size="compact" disabled={log.busy || !configured} onClick={chooseConnection}>
              <Play size={14} />
              {log.session ? '重新连接' : '连接日志'}
            </Button>
          ) : (
            <Button variant="neutral" size="compact" onClick={() => changeFollow(!following)}>
              {following ? <Pause size={14} /> : <Play size={14} />}
              {following ? '暂停跟随' : '继续跟随'}
            </Button>
          )}
          {view === 'loaded' && !following && log.lines.length > 0 && (
            <Button
              variant="neutral"
              size="compact"
              onClick={() => {
                setPaused(log.latestLines());
                setLatest((value) => value + 1);
              }}
            >
              跳到最新
            </Button>
          )}
          <MoreMenu
            label="更多日志操作"
            iconOnly
            trigger={<Ellipsis size={16} aria-hidden />}
            actions={[
              {
                label: '下载已加载日志',
                disabled: !log.lines.length || !!working,
                onClick: () => setLoadedConfirm(true),
              },
              {
                label: '下载完整日志',
                disabled: !log.active || !!working,
                onClick: () => void prepareDownload(),
              },
              { label: '连接管理', disabled: !!working, onClick: () => void describeSessions() },
              ...(log.active
                ? [
                    {
                      label: '断开',
                      disabled: !!working,
                      onClick: () => void run('stop', () => stop(log.session)),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </header>
      {log.source && !configured && (
        <div className="notice online-log-notice" role="status">
          <span>未配置日志路径。请在部署目标配置中填写应用日志的绝对路径。</span>
          {onConfigure && (
            <Button variant="link" size="compact" onClick={onConfigure}>
              配置日志路径
            </Button>
          )}
        </div>
      )}
      {(log.notice || error || (log.error && !credentials) || feedback) && (
        <div
          className={
            'notice online-log-notice' + (error || (log.error && !credentials) ? ' warning' : '')
          }
          role={error || (log.error && !credentials) ? 'alert' : 'status'}
        >
          {error || (credentials ? '' : log.error) || feedback || log.notice}
        </div>
      )}
      {working === 'size' && (
        <p className="online-log-notice note" role="status">
          正在获取服务器日志大小…
        </p>
      )}
      <div className="online-log-console">
        <div className="online-log-toolbar">
          <SegmentedControl<'loaded' | 'server'>
            aria-label="日志范围"
            size="sm"
            value={view}
            onValueChange={setView}
            items={[
              { value: 'loaded', label: '已加载内容' },
              { value: 'server', label: '服务器历史' },
            ]}
          />
          {view === 'loaded' ? (
            <div className="online-log-filter">
              <label className="online-log-search">
                <Search size={14} aria-hidden />
                <input
                  aria-label="过滤已加载日志"
                  placeholder="只过滤已加载内容"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </label>
              <select
                aria-label="应用日志级别"
                value={level}
                onChange={(event) => setLevel(event.target.value)}
              >
                <option value="all">全部级别</option>
                <option value="warning">警告及错误</option>
                <option value="error">只看错误</option>
              </select>
            </div>
          ) : (
            <form
              className="online-log-filter"
              onSubmit={(event) => {
                event.preventDefault();
                if (!log.active || working || !query.trim()) return;
                setResult(undefined);
                void run('search', async () =>
                  setResult(
                    await api.searchOnlineLogs(log.session, { query, regex, range: selectedRange }),
                  ),
                );
              }}
            >
              <label className="online-log-search">
                <Search size={14} aria-hidden />
                <input
                  aria-label="服务器历史搜索"
                  placeholder={regex ? '输入 POSIX 扩展正则表达式' : '搜索服务器上的日志'}
                  maxLength={256}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <select
                aria-label="服务器日志搜索范围"
                value={selectedRange}
                onChange={(event) => setRange(event.target.value as OnlineSearch['range'])}
              >
                {docker ? (
                  <>
                    <option value="1">近 1 小时</option>
                    <option value="24">近 24 小时</option>
                    <option value="168">近 7 天</option>
                  </>
                ) : (
                  <>
                    <option value="1">末尾 1 MB</option>
                    <option value="4">末尾 4 MB</option>
                    <option value="8">末尾 8 MB</option>
                  </>
                )}
              </select>
              <label className="check-row online-log-regex" title="使用 POSIX 扩展正则表达式">
                <input
                  type="checkbox"
                  className="ui-checkbox"
                  checked={regex}
                  onChange={(event) => setRegex(event.target.checked)}
                />
                正则
              </label>
              <Button size="compact" disabled={!log.active || !!working || !query.trim()}>
                {working === 'search' ? '搜索中…' : '搜索'}
              </Button>
            </form>
          )}
        </div>
        {view === 'loaded' ? (
          shown.length ? (
            <VirtualLogs
              entries={shown}
              grouped={false}
              showToolbar={false}
              following={following}
              onFollowingChange={changeFollow}
              latest={latest}
              label="应用日志内容"
            />
          ) : (
            <div className="online-log-empty">
              {log.lines.length
                ? '没有符合筛选条件的日志。'
                : log.active
                  ? '连接已建立，等待日志输出…'
                  : '连接后在此查看最近日志。'}
            </div>
          )
        ) : (
          <>
            <div className="online-log-search-scope note">
              <span>
                {result?.scope || (docker ? '当前容器 · 最多最近 20,000 行' : '当前日志文件')} ·
                最多 {onlineSearchLimit} 条命中，前后各 2 行
              </span>
            </div>
            <div className="online-log-results" aria-label="服务器搜索结果">
              {result ? (
                <>
                  <p className="note" role="status">
                    {result.matches.length} 条命中
                    {result.truncated
                      ? ' · 已截断，部分日志超出搜索范围或结果上限'
                      : ' · 范围内未截断'}
                  </p>
                  {result.matches.map((match) => (
                    <details key={match.line}>
                      <summary>
                        <span>范围内第 {match.line} 行</span>
                        <code>{match.text}</code>
                      </summary>
                      <pre>{[...match.before, match.text, ...match.after].join('\n')}</pre>
                    </details>
                  ))}
                </>
              ) : (
                <div className="online-log-empty">
                  {!log.active
                    ? '先连接日志，再搜索服务器历史。'
                    : working === 'search'
                      ? '正在服务器上搜索…'
                      : '输入关键词搜索服务器历史。'}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {credentials && (
        <Modal
          title="连接日志"
          onClose={() => {
            setSecret('');
            setCredentials(false);
          }}
          closeDisabled={log.busy}
          footer={
            <Button disabled={log.busy} onClick={() => void connect(secret)}>
              {log.busy ? '连接中…' : '连接'}
            </Button>
          }
        >
          <Field label={log.source?.password ? '登录密码' : '私钥口令'}>
            <input
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              autoComplete="off"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !log.busy) void connect(secret);
              }}
            />
          </Field>
          <p className="note">已保存凭据或私钥无需口令时可留空。</p>
          {log.error && (
            <p className="warning" role="alert">
              {log.error}
            </p>
          )}
        </Modal>
      )}
      {sessions && (
        <Modal title="日志连接管理" onClose={() => setSessions(undefined)}>
          <p className="note">
            当前 {sessions.length} / {onlineLogSessionLimit}{' '}
            个会话。切换页面时连接会保留，超时后自动断开。
          </p>
          {log.active && log.endsAt && (
            <p className="note">
              当前连接将于 {new Date(log.endsAt).toLocaleTimeString('zh-CN', { hour12: false })}{' '}
              自动断开。
            </p>
          )}
          {sessions.map((item) => (
            <div className="row spread" key={item.id}>
              <span>
                {item.target} · {item.server}
              </span>
              <Button
                variant="neutral"
                size="compact"
                disabled={!!working}
                onClick={() =>
                  void run('stop-session', async () => {
                    await stop(item.id);
                    setSessions((previous) => previous?.filter((entry) => entry.id !== item.id));
                  })
                }
              >
                断开
              </Button>
            </div>
          ))}
          {error && (
            <p role="alert" className="warning">
              {error}
            </p>
          )}
        </Modal>
      )}
      {loadedConfirm && (
        <Modal
          title="下载已加载日志"
          onClose={() => setLoadedConfirm(false)}
          footer={
            <Button
              size="compact"
              onClick={() => {
                setLoadedConfirm(false);
                void run('loaded', async () => {
                  if (await api.saveLoadedLogs(log.session)) setFeedback('已保存已加载日志。');
                });
              }}
            >
              选择保存位置
            </Button>
          }
        >
          <p>保存当前会话已加载的日志，最多 2 MB，包含被筛选隐藏的行。</p>
          <p className="note">{downloadNote}</p>
        </Modal>
      )}
      {download && (
        <Modal
          title="下载完整日志"
          closeDisabled={working === 'download'}
          onClose={clearDownload}
          footer={
            working === 'download' ? (
              <Button
                variant="neutral"
                size="compact"
                onClick={() => void api.cancelOnlineLogDownload(download.token)}
              >
                取消下载
              </Button>
            ) : (
              <>
                <Button variant="neutral" size="compact" onClick={clearDownload}>
                  取消
                </Button>
                <Button
                  size="compact"
                  onClick={() =>
                    void run('download', async () => {
                      try {
                        const saved = await api.saveOnlineLogs(download.token);
                        setFeedback(
                          saved ? '完整日志已保存。' : '下载未完成，可重新获取大小后下载。',
                        );
                      } finally {
                        clearDownload();
                      }
                    })
                  }
                >
                  选择保存位置
                </Button>
              </>
            )
          }
        >
          <p className="path">{download.source}</p>
          <p>
            服务器日志大小 <strong>{imageSize(download.bytes)}</strong>
          </p>
          {download.bytes >= onlineLargeLog && (
            <p className="warning">日志较大，下载可能耗时较长，请确认本机剩余空间。</p>
          )}
          <p className="note">{downloadNote}</p>
          {working === 'download' && (
            <div className="online-log-progress">
              <progress
                aria-label="完整日志下载进度"
                value={received}
                max={Math.max(download.bytes, 1)}
              />
              <span>
                {imageSize(received)} / {imageSize(download.bytes)}
              </span>
            </div>
          )}
        </Modal>
      )}
    </section>
  );
}
