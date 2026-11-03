import { useEffect, useRef, useState } from 'react';
import type { Server } from './model';
import { desktop, type TrustRequest } from './platform';
import { Badge, Field, Modal } from './ui';

export function TrustDialog({ request, onClose }: { request: TrustRequest; onClose: () => void }) {
  const [word, setWord] = useState('');
  const [error, setError] = useState('');
  const decide = async (yes: boolean) => {
    try {
      await desktop!.trust(request.id, yes, word);
      onClose();
    } catch (e) {
      setError(String(e));
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
      <p className="code">{request.fingerprint}</p>
      <p className={request.changed ? 'warning' : 'note'}>
        {request.changed
          ? '已保存的主机密钥与本次连接不同。请先从独立渠道核实指纹；只有明确更新信任后才会发送认证信息。'
          : '请核对服务器指纹。拒绝后不会继续认证、上传或修改服务。'}
      </p>
      {false && (
        <Field label="输入 TRUST 更新信任">
          <input data-autofocus value={word} onChange={(e) => setWord(e.target.value)} />
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
          data-autofocus={!request.changed || undefined}
          onClick={() => void decide(false)}
        >
          拒绝连接
        </button>
        <button
          className="button primary"
          disabled={request.changed}
          onClick={() => void decide(true)}
        >
          信任并继续
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
export function NativeLogs({
  taskId,
  targetId,
  initial,
}: {
  taskId: string;
  targetId: string;
  initial: string[];
}) {
  const sequence = useRef(initial.length);
  const [lines, setLines] = useState(() => initial.map((text, id) => ({ text, id })));
  const ref = useRef<HTMLPreElement>(null),
    follow = useRef(true);
  useEffect(() => {
    let loaded = false,
      alive = true;
    const pending: { text: string; targetId?: string; offset?: number }[] = [];
    const append = (text: string) => {
      const added = text
        .replace(/\r/g, '')
        .split('\n')
        .filter(Boolean)
        .map((text) => ({ text, id: sequence.current++ }));
      setLines((old) => {
        const next = [...old, ...added];
        return next.length > 20000 && follow.current && !window.getSelection()?.toString()
          ? next.slice(-20000)
          : next;
      });
    };
    const off = desktop!.onEvent((event) => {
      if (
        event.kind !== 'log' ||
        event.taskId !== taskId ||
        (event.targetId && event.targetId !== targetId)
      )
        return;
      if (loaded) append(event.text);
      else pending.push(event);
    });
    void desktop!
      .readLogs(taskId, targetId)
      .then((value) => {
        if (!alive) return;
        setLines(
          [...value.build, ...value.target].map((text) => ({ text, id: sequence.current++ })),
        );
        loaded = true;
        for (const event of pending)
          if (
            (event.offset || Infinity) >
            (event.targetId ? value.targetOffset || 0 : value.buildOffset || 0)
          )
            append(event.text);
      })
      .catch(() => {
        loaded = true;
        for (const event of pending) append(event.text);
      });
    return () => {
      alive = false;
      off();
    };
  }, [taskId, targetId]);
  useEffect(() => {
    if (ref.current && follow.current && !window.getSelection()?.toString())
      ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  return (
    <pre
      className="terminal"
      ref={ref}
      aria-label="任务日志"
      onScroll={(e) => {
        const el = e.currentTarget;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      <span className="terminal-caption">真实执行日志 · 完整记录可导出</span>
      {lines.map((line) => (
        <span key={line.id}>{line.text}</span>
      ))}
    </pre>
  );
}
export function ContainerLogs({ targetId }: { targetId: string }) {
  const [credential, setCredential] = useState(''),
    [lines, setLines] = useState<string[]>([]),
    [active, setActive] = useState(false),
    [error, setError] = useState('');
  const session = useRef(''),
    pending = useRef(new Map<string, string[]>()),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const off = desktop!.onEvent((event) => {
      if (event.kind !== 'container-log') return;
      if (event.id === session.current)
        setLines((old) =>
          window.getSelection()?.toString()
            ? [...old, event.text]
            : [...old, event.text].slice(-5000),
        );
      else if (!session.current)
        pending.current.set(event.id, [...(pending.current.get(event.id) || []), event.text]);
    });
    return () => {
      mounted.current = false;
      off();
      if (session.current) void desktop!.stopLogs(session.current);
    };
  }, []);
  async function begin() {
    setError('');
    try {
      const id = await desktop!.followLogs(targetId, credential);
      if (!mounted.current) {
        await desktop!.stopLogs(id);
        return;
      }
      session.current = id;
      setLines(pending.current.get(id) || []);
      pending.current.clear();
      setActive(true);
      setCredential('');
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <>
      <Field label="连接口令（已有保存凭据或 SSH 别名可留空）">
        <input
          type="password"
          value={credential}
          autoComplete="off"
          onChange={(e) => setCredential(e.target.value)}
        />
      </Field>
      <div className="row wrap">
        <button className="button primary" disabled={active} onClick={() => void begin()}>
          跟随容器日志
        </button>
        <button
          className="button"
          disabled={!active}
          onClick={() => {
            void desktop!.stopLogs(session.current);
            session.current = '';
            setActive(false);
          }}
        >
          停止跟随
        </button>
        <Badge>{active ? '正在跟随' : '未连接'}</Badge>
      </div>
      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      <pre className="terminal mt">
        {lines.length
          ? lines.map((line, index) => <span key={index}>{line}</span>)
          : '点击跟随后读取最近 200 行并持续显示新增日志。'}
      </pre>
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
      <p>创建时间：{new Date(created * 1000).toLocaleString()}</p>
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
