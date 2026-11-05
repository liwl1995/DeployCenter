import { fmtTime } from './model';
import { useEffect, useRef, useState } from 'react';
import type { Server } from './model';
import { desktop, type TrustRequest } from './platform';
import { Badge, Field, Modal } from './ui';
import { LogAccumulator, type LogLine } from './log-model';
import { VirtualLogs } from './LogViewer';

export function TrustDialog({ request, onClose }: { request: TrustRequest; onClose: () => void }) {
  const [word, setWord] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const decide = async (yes: boolean) => {
    if (submitting.current || (yes && request.changed && word !== 'TRUST')) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await desktop!.trust(request.id, yes, word);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal
      title={request.changed ? '主机指纹已变化' : '确认服务器主机指纹'}
      onClose={() => void decide(false)}
    >
      <p>
        {request.server} · {request.endpoint}
      </p>
      {request.changed && request.previousFingerprint && (
        <div className="notice">
          <strong>原信任指纹</strong>
          <p className="code">{request.previousFingerprint}</p>
        </div>
      )}
      <p className="note">本次服务器指纹</p>
      <p className="code">{request.fingerprint}</p>
      <p className={request.changed ? 'warning' : 'note'}>
        {request.changed
          ? '已保存的主机密钥与本次连接不同。请先从独立渠道核实指纹；只有明确更新信任后才会发送认证信息。'
          : '请核对服务器指纹。拒绝后不会继续认证、上传或修改服务。'}
      </p>
      {request.changed && (
        <Field label="输入 TRUST 更新信任">
          <input
            data-autofocus
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            value={word}
            onChange={(e) => setWord(e.target.value)}
          />
        </Field>
      )}
      {error && (
        <p role="alert" className="warning">
          {error}
        </p>
      )}
      <footer className="modal-actions">
        <button
          className="button"
          disabled={busy}
          data-autofocus={!request.changed || undefined}
          onClick={() => void decide(false)}
        >
          拒绝连接
        </button>
        <button
          className="button primary"
          disabled={busy || (request.changed && word !== 'TRUST')}
          onClick={() => void decide(true)}
        >
          {busy ? '正在处理…' : request.changed ? '确认更新信任并继续' : '信任并继续'}
        </button>
      </footer>
    </Modal>
  );
}
export function CredentialPrompt({
  servers,
  saved,
  onSubmit,
  label = '连接',
}: {
  servers: Server[];
  saved: string[];
  onSubmit: (values: Record<string, string>) => Promise<void>;
  label?: string;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSubmit(values);
        } catch (error) {
          setError(String(error));
        } finally {
          setBusy(false);
        }
      }}
    >
      {servers
        .filter((s, i, all) => s.auth !== 'alias' && all.findIndex((x) => x.id === s.id) === i)
        .map((s) => (
          <Field
            key={s.id}
            label={s.name + ' · ' + (s.auth === 'password' ? '密码' : '私钥口令')}
            hint={
              saved.includes(s.id) && s.credentialMode === 'windows'
                ? '已保存本机加密凭据，留空复用'
                : s.auth === 'key'
                  ? '未加密的私钥可留空'
                  : '只在当前操作内存使用；选择本机保存时会使用 DPAPI 加密'
            }
          >
            <input
              type="password"
              autoComplete="off"
              required={
                s.auth === 'password' && !(saved.includes(s.id) && s.credentialMode === 'windows')
              }
              value={values[s.id] || ''}
              onChange={(e) => setValues((old) => ({ ...old, [s.id]: e.target.value }))}
            />
          </Field>
        ))}
      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      <footer className="modal-actions">
        <button className="button primary" disabled={busy}>
          {busy ? '处理中…' : label}
        </button>
      </footer>
    </form>
  );
}
export { NativeLogPanel as NativeLogs } from './NativeLogPanel';
export function ContainerLogs({
  targetId,
  initialSession,
}: {
  targetId: string;
  initialSession?: string;
}) {
  const [credential, setCredential] = useState(''),
    [active, setActive] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [lines, setLines] = useState<LogLine[]>([]),
    [endsAt, setEndsAt] = useState<number>();
  const session = useRef(initialSession || ''),
    collector = useRef(new LogAccumulator()),
    mounted = useRef(true),
    loaded = useRef(false),
    pending = useRef<Extract<import('./platform').DesktopEvent, { kind: 'container-log' }>[]>([]);
  const append = (event: (typeof pending.current)[number]) => {
    const bytes = new TextEncoder().encode(event.text).length;
    collector.current.append(
      event.id,
      event.text,
      event.offset === undefined ? undefined : event.offset - bytes,
      event.context,
    );
    setLines([...collector.current.entries]);
    if (event.active !== undefined) setActive(event.active);
  };
  const hydrate = async (id: string) => {
    const snapshot = await desktop!.readLogSession(id);
    if (!mounted.current || session.current !== id) return;
    collector.current = new LogAccumulator();
    for (const chunk of snapshot.chunks)
      collector.current.append(
        id,
        chunk.text,
        chunk.offset - new TextEncoder().encode(chunk.text).length,
        chunk.context,
      );
    setActive(snapshot.active);
    setEndsAt(snapshot.endsAt);
    loaded.current = true;
    for (const event of pending.current) if (event.id === id) append(event);
    pending.current = [];
    setLines([...collector.current.entries]);
  };
  useEffect(() => {
    mounted.current = true;
    const off = desktop!.onEvent((event) => {
      if (event.kind !== 'container-log' || event.id !== session.current) return;
      if (!loaded.current) pending.current.push(event);
      else append(event);
    });
    if (initialSession)
      void hydrate(initialSession).catch((e) => {
        if (mounted.current) setError(String(e));
      });
    return () => {
      mounted.current = false;
      off();
      if (session.current) void desktop!.stopLogs(session.current);
    };
  }, []);
  const begin = async () => {
    setBusy(true);
    setError('');
    loaded.current = false;
    try {
      const id = await desktop!.followLogs(targetId, credential);
      if (!mounted.current) {
        await desktop!.stopLogs(id);
        return;
      }
      session.current = id;
      setCredential('');
      await hydrate(id);
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <>
      {!initialSession && (
        <Field label="连接口令（已有保存凭据或 SSH 别名可留空）">
          <input
            type="password"
            value={credential}
            autoComplete="off"
            onChange={(e) => setCredential(e.target.value)}
          />
        </Field>
      )}
      <div className="row wrap">
        <button className="button primary" disabled={active || busy} onClick={() => void begin()}>
          {busy ? '连接中…' : '跟随应用日志'}
        </button>
        <button
          className="button"
          disabled={!active}
          onClick={() => {
            void desktop!.stopLogs(session.current);
            setActive(false);
          }}
        >
          停止跟随
        </button>
        <Badge>{active ? '正在跟随' : '已停止'}</Badge>
      </div>
      {endsAt && (
        <p className="note">
          将在 {new Date(endsAt).toLocaleTimeString('zh-CN', { hour12: false })}{' '}
          自动停止；关闭窗口也会停止当前会话。
        </p>
      )}
      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      <VirtualLogs entries={lines} />
    </>
  );
}

export function LockTakeover({
  token,
  owner,
  created,
  stale,
  message,
  onDone,
}: {
  token: string;
  owner: string;
  created: number;
  stale: boolean;
  message: string;
  onDone: () => void;
}) {
  const [word, setWord] = useState(''),
    [error, setError] = useState('');
  return (
    <>
      <p>持有者：{owner}</p>
      <p>创建时间：{fmtTime(new Date(created * 1000).toISOString())}</p>
      <p className="warning">{message}</p>
      {stale && (
        <>
          <Field label="确认原任务已停止，输入 TAKEOVER">
            <input value={word} onChange={(e) => setWord(e.target.value)} />
          </Field>
          <button
            className="button danger"
            disabled={word !== 'TAKEOVER'}
            onClick={() =>
              void desktop!
                .takeoverLock(token, word)
                .then(onDone)
                .catch((e) => setError(String(e)))
            }
          >
            归档旧锁并允许重新部署
          </button>
        </>
      )}
      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
