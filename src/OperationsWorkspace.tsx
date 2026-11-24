import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Play, RefreshCw, RotateCw, ScrollText, Square } from 'lucide-react';
import { Button } from './design/ui/button';
import { Badge, Field, Modal } from './ui';
import { CredentialPrompt } from './DesktopViews';
import { VirtualLogs } from './LogViewer';
import type { Server, Target } from './model';
import { operationHealthSkipReason, operationLabels, operationResultLabels, operationStateLabels, type OperationPlan, type OperationRecord, type OperationStatus, type ServiceOperation } from './operations';
import type { DesktopAPI } from './platform';

const icons = { start: Play, stop: Square, restart: RotateCw };
const actions = Object.keys(operationLabels) as ServiceOperation[];
const details = {
  start: '启动当前版本，不构建或上传文件。',
  stop: '服务会停止接收请求，直到再次启动。',
  restart: '重启期间，正在处理的请求可能中断。',
};
const statusTone = (state: string) => ['running', 'matched', 'success'].includes(state) ? 'good' :
  ['unknown', 'not-found', 'unverified', 'blocked'].includes(state) ? 'warn' :
    ['failed'].includes(state) ? 'bad' : 'neutral';
const errorText = (error: unknown) =>
  String(error).replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');
const canRun = (target: Target, status: OperationStatus | undefined, action: ServiceOperation) => {
  if (!status || status.locked || status.state === 'unknown') return false;
  if (action === 'start' && !['stopped', 'not-found'].includes(status.state)) return false;
  if (action !== 'start' && !['running', 'matched'].includes(status.state)) return false;
  return target.mode === 'docker' ? !!target.container.trim() :
    action === 'restart' ? !!(target.restart.trim() || (target.stop.trim() && target.start.trim())) : !!target[action].trim();
};

export function OperationsWorkspace({ api, targets, servers, target, saved, onTarget, onLogs, onEdit, onStatus, blocked, followLogs, visible }: {
  api: DesktopAPI;
  targets: Target[];
  servers: Server[];
  target?: Target;
  saved: string[];
  onTarget: (id: string) => void;
  onLogs: () => void;
  onEdit: () => void;
  onStatus: (id: string, status: OperationStatus) => void;
  blocked?: string;
  followLogs: boolean;
  visible: boolean;
}) {
  const [status, setStatus] = useState<OperationStatus>();
  const [records, setRecords] = useState<OperationRecord[]>([]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [checkingCredential, setCheckingCredential] = useState(false);
  const [dialog, setDialog] = useState<{ plan?: OperationPlan; record?: OperationRecord }>();
  const [detail, setDetail] = useState<string>();
  const [word, setWord] = useState('');
  const [confirmedStopped, setConfirmedStopped] = useState(false);
  const [credential, setCredential] = useState('');
  const [now, setNow] = useState(Date.now);
  const localRun = useRef<string>(undefined);
  const readVersion = useRef(0);
  const checkedTarget = useRef<string>(undefined);
  const historyVersion = useRef(0);
  const selected = target?.id;
  const server = servers.find((entry) => entry.id === target?.serverId);
  const hasSaved = !!server && server.credentialMode === 'windows' && saved.includes(server.id);
  const field = server?.auth !== 'alias' && !!server;
  const refresh = useCallback(async (id: string, supplied = '', report = true) => {
    const version = ++readVersion.current;
    setReading(true);
    if (report) setError('');
    try {
      const value = await api.operationsStatus(id, supplied);
      onStatus(id, value);
      if (readVersion.current === version) setStatus(value);
    } catch (error) {
      if (readVersion.current === version) {
        setStatus(undefined);
        setError(errorText(error));
      }
      if (!report) throw error;
    } finally {
      if (readVersion.current === version) setReading(false);
    }
  }, [api, onStatus]);

  useEffect(() => {
    setStatus(undefined); setRecords([]); setError(''); setDetail(undefined); setReading(false);
    if (!selected || !server) return;
    const version = ++historyVersion.current;
    void api.operationsList(selected).then((items) => {
      if (version === historyVersion.current) setRecords(items);
    }).catch((error) => { if (version === historyVersion.current) setError(errorText(error)); });
    return () => { readVersion.current++; historyVersion.current++; };
  }, [api, selected, server?.id, server?.auth, hasSaved, refresh]);
  useEffect(() => {
    if (!visible || !selected || !server || checkedTarget.current === selected) return;
    checkedTarget.current = selected;
    if (server.auth !== 'password' || hasSaved) void refresh(selected);
  }, [selected, server?.id, server?.auth, hasSaved, refresh, visible]);
  useEffect(() => api.onEvent((event) => {
    if (event.kind !== 'operation' || event.record.targetId !== selected) return;
    const record = event.record;
    historyVersion.current++;
    setRecords((items) => [record, ...items.filter((item) => item.id !== record.id)].slice(0, 30));
    if (record.result === 'running' && localRun.current === selected) {
      setDetail(record.id);
      localRun.current = undefined;
    }
  }), [api, selected]);

  const entry = records.find((item) => item.id === detail);
  const running = records.some((item) => item.result === 'running');
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const elapsed = (item: OperationRecord) =>
    ((item.elapsed ?? Math.max(now - item.started, 0)) / 1000).toFixed(1) + ' 秒';
  const showDialog = (value: NonNullable<typeof dialog>) => {
    setWord(''); setConfirmedStopped(false); setCredential(''); setError(''); setDialog(value);
  };
  const useCredential = () => {
    if (!selected) return;
    if (field && !hasSaved) setCheckingCredential(true);
    else void refresh(selected);
  };
  if (!target || !server) return <div className="empty"><p>添加部署目标后即可查看运行状态和日志。</p></div>;
  const healthSkip = operationHealthSkipReason(target.health);
  const health = status?.health;
  const healthText = healthSkip || (reading ? '检查中…' : !health ? '未检查' :
    health.state === 'passed' ? '通过 · ' + health.message :
      health.state === 'failed' ? '未通过 · ' + health.message : health.message);
  const needsWord = !!dialog && (!!dialog.record || !!dialog.plan?.production);
  const needsStopped = dialog?.plan?.action === 'start' && status?.state === 'not-found';
  const credentialRequired = server.auth === 'password' && !hasSaved;
  const unresolved = records.some((item) => item.result === 'unknown' && !item.settled);
  const actionBlock = blocked || (running ? '已有运维操作正在执行' : '') ||
    (unresolved ? '上次操作结果待核实，请先处理下方记录。' : '') ||
    (status?.locked ? '目标有远程任务锁，请到部署目标的「更多」中检查或接管任务锁。' : '');
  return (
    <section className="operations-workspace" aria-label="目标运维">
      {entry ? <section className="operation-output" aria-label="运维执行日志">
        <div className="row operation-heading">
          <h2>{entry.target} · {operationLabels[entry.action]}日志</h2>
          <Badge kind={statusTone(entry.result)}>{operationResultLabels[entry.result]}</Badge>
          <span className="note">{elapsed(entry)}</span>
          <Button variant="neutral" size="compact" className="operation-push" onClick={() => setDetail(undefined)}><ArrowLeft size={15} />返回运维</Button>
        </div>
        <div className="operation-result row" role="status">
          <span>{entry.message}</span>
          {['failed', 'unknown', 'unverified'].includes(entry.result) && <Button variant="neutral" size="compact" onClick={() => { setDetail(undefined); onLogs(); }}>查看线上日志</Button>}
        </div>
        <VirtualLogs active={entry.result === 'running'} label="运维执行日志" initialFollow={followLogs}
          entries={entry.logs.trimEnd().split('\n').filter(Boolean).map((text, index) => ({ id: entry.id + ':' + index, text }))}
          grouped={false} />
      </section> : <>
        <div className="row operation-heading">
          <label className="row">目标<select aria-label="运维目标" value={target.id} disabled={reading || pending} onChange={(event) => onTarget(event.target.value)}>
            {targets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <Badge kind={target.production ? 'prod' : ''}>{target.production ? '正式环境' : '非正式'}</Badge>
          <span className="note operation-push">{server.name} · {server.auth === 'alias' ? server.alias : server.host} · {target.mode === 'docker' ? 'Docker JAR' : '普通 JAR'}</span>
        </div>
        <div className="operation-state" aria-live="polite">
          <div className="row operation-heading"><div><h2>运行状态</h2><strong data-tone={statusTone(status?.state || '')}>{reading ? '正在检查…' : status ? operationStateLabels[status.state] : '未检查'}</strong></div>
            <Button variant="neutral" size="compact" className="operation-push" disabled={reading || running || pending} onClick={useCredential}><RefreshCw size={15} />刷新状态</Button>
          </div>
          <dl className="operation-facts">
            <div><dt>连续运行</dt><dd>{status?.uptime || '—'}</dd></div>
            <div><dt>{target.mode === 'docker' ? '容器重启次数' : '匹配进程 PID'}</dt><dd>{target.mode === 'docker' ? status?.restarts ?? '—' : status?.pid || '—'}</dd></div>
            <div><dt>健康状态</dt><dd>{healthText}</dd></div>
          </dl>
          <p className="note">{status ? '最近检查 ' + new Date(status.checkedAt).toLocaleTimeString('zh-CN') + ' · ' : ''}
            {target.mode === 'docker' ? 'Docker 容器状态' : '按 JAR 文件名匹配，不代表应用可用'}</p>
          {status?.message && <p className="note">{status.message}</p>}
          {!status && credentialRequired && !reading && !error && <p className="note">点击「刷新状态」输入连接密码。</p>}
        </div>
        <section>
          <div className="row operation-heading"><h2>服务操作</h2>
            {target.production && <span className="note operation-push">正式环境操作需要输入目标名称</span>}
          </div>
          <div className="row operation-actions">
            {actions.map((action) => {
              const Icon = icons[action];
              return <Button key={action} size="compact" variant={action === 'stop' ? 'danger' : 'neutral'}
                disabled={!!actionBlock || pending || reading || !canRun(target, status, action)}
                onClick={() => {
                  setPending(true);
                  void api.operationsPrepare(target.id, action).then((plan) => showDialog({ plan }))
                    .catch((error) => setError(errorText(error))).finally(() => setPending(false));
                }}><Icon size={15} />{operationLabels[action]}</Button>;
            })}
            <Button className="operation-push" size="compact" onClick={onLogs}><ScrollText size={15} />查看日志</Button>
          </div>
          {actionBlock && <p className="warning" role="status">{actionBlock}</p>}
          {target.mode === 'jar' && (!target.start.trim() || !target.stop.trim()) && <div className="row">
            <span className="note">未配置的命令无法执行。</span><Button variant="quiet" size="compact" onClick={onEdit}>编辑目标</Button>
          </div>}
        </section>
        <section>
          <h2>最近运维操作</h2>
          {!records.length ? <p className="note">这个目标暂时没有运维记录。</p> : <table className="operation-history">
            <thead><tr><th>时间</th><th>操作</th><th>结果</th><th>耗时</th><th>详情</th></tr></thead>
            <tbody>{records.map((item) => <tr key={item.id}>
              <td><time>{new Date(item.started).toLocaleString('zh-CN')}</time><small>{item.actor}</small></td>
              <td>{operationLabels[item.action]}</td>
              <td><Badge kind={statusTone(item.result)}>{operationResultLabels[item.result]}</Badge>{item.settled && <small>已人工核实</small>}</td>
              <td>{elapsed(item)}</td>
              <td><Button variant="quiet" size="compact" onClick={() => setDetail(item.id)}>日志</Button>
                {item.result === 'unknown' && !item.settled && <Button variant="neutral" size="compact" onClick={() => showDialog({ record: item })}>核实结果</Button>}</td>
            </tr>)}</tbody>
          </table>}
        </section>
      </>}
      {error && !dialog && <p role="alert" className="warning">{error}</p>}
      {checkingCredential && <Modal title="连接服务器检查运行状态" onClose={() => setCheckingCredential(false)}>
        <CredentialPrompt servers={[server]} saved={saved} onSubmit={async (values) => {
          await refresh(target.id, values[server.id], false);
          setCheckingCredential(false);
        }} />
      </Modal>}
      {dialog && <Modal title={dialog.plan ? '确认' + operationLabels[dialog.plan.action] + '服务' : '核实运维结果'} onClose={() => setDialog(undefined)}
        footer={<><Button variant="neutral" onClick={() => setDialog(undefined)}>取消</Button><Button
          variant={dialog.plan && dialog.plan.action !== 'start' ? 'danger' : 'default'}
          disabled={pending || (needsWord && word.trim() !== target.name) || (needsStopped && !confirmedStopped) || (credentialRequired && !credential)}
          onClick={() => {
            const supplied = credential;
            const request = dialog.plan ? () => api.operationsRun(dialog.plan!.token, word.trim(), confirmedStopped, supplied)
              : () => api.operationsSettle(target.id, dialog.record!.id, word.trim(), supplied);
            if (dialog.plan) localRun.current = target.id;
            setDialog(undefined); setCredential(''); setPending(true);
            void request().then(() => refresh(target.id, supplied)).catch((error) => setError(errorText(error)))
              .finally(() => { setPending(false); localRun.current = undefined; });
          }}>{dialog.plan ? '确认' + operationLabels[dialog.plan.action] : '确认已核实'}</Button></>}>
        <div className="stack">
          <p>{dialog.plan?.service ? dialog.plan.service + ' · ' : ''}{target.name} · {server.name}{dialog.plan && ' · ' + dialog.plan.address}</p>
          {dialog.plan ? <><p>{details[dialog.plan.action]}</p><pre className="terminal operation-command">{dialog.plan.commands.join('\n')}</pre>
            {dialog.plan.nextRelease && <p className="warning">该目标有待发布计划，时间为 {new Date(dialog.plan.nextRelease).toLocaleString('zh-CN')}。</p>}</> :
            <p>请先查看线上状态和任务锁。确认会解除本地阻止，原操作仍标为待核实。</p>}
          {needsWord && <Field label={'输入目标名称确认 · ' + target.name}><input value={word} onChange={(event) => setWord(event.target.value)} /></Field>}
          {needsStopped && <label className="check-row"><input type="checkbox" checked={confirmedStopped} onChange={(event) => setConfirmedStopped(event.target.checked)} />我已确认目标服务未运行</label>}
          {field && <Field label={server.auth === 'password' ? '登录密码' : '私钥口令'} hint={hasSaved ? '留空复用已保存凭据' : server.auth === 'key' ? '未加密的私钥可留空' : undefined}>
            <input type="password" autoComplete="off" value={credential} onChange={(event) => setCredential(event.target.value)} />
          </Field>}
        </div>
      </Modal>}
    </section>
  );
}
