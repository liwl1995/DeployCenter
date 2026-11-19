import { Button } from './design/ui/button';
import { fmtTime } from './model';
import { useRef, useState } from 'react';
import type { Server } from './model';
import { desktop, type TrustRequest } from './platform';
import { Field, Modal } from './ui';

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
        <Button
          variant="neutral" size="compact"
          disabled={busy}
          data-autofocus={!request.changed || undefined}
          onClick={() => void decide(false)}
        >
          拒绝连接
        </Button>
        <Button
          variant="default" size="compact"
          disabled={busy || (request.changed && word !== 'TRUST')}
          onClick={() => void decide(true)}
        >
          {busy ? '正在处理…' : request.changed ? '确认更新信任并继续' : '信任并继续'}
        </Button>
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
        <Button variant="default" size="compact" disabled={busy}>
          {busy ? '处理中…' : label}
        </Button>
      </footer>
    </form>
  );
}
export { NativeLogPanel as NativeLogs } from './NativeLogPanel';
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
          <Button
            variant="danger" size="compact"
            disabled={word !== 'TAKEOVER'}
            onClick={() =>
              void desktop!
                .takeoverLock(token, word)
                .then(onDone)
                .catch((e) => setError(String(e)))
            }
          >
            归档旧锁并允许重新部署
          </Button>
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
