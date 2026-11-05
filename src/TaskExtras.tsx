import { useState } from 'react';
import type { DesktopAPI } from './platform';
import type { Server, Target, Task } from './model';
import { fmtTime, seconds, serverAddress } from './model';
import type { DiagnosticKind, DiagnosticResult } from './features';
import { Card, Field, Steps, download } from './ui';
import { NativeLogs } from './DesktopViews';
import { failureAdvice } from './presentation';
const labels: Record<DiagnosticKind, string> = {
  directory: '目标目录文件',
  disk: '磁盘剩余',
  container: '容器状态',
  logs: '最近应用日志',
  process: '服务进程',
  lock: '目标任务锁',
  server: '服务器体检',
};
export function DiagnosticPanel({
  api,
  target,
  server,
  saved,
  initial = 'directory',
}: {
  api: DesktopAPI;
  target?: Target;
  server: Server;
  saved: string[];
  initial?: DiagnosticKind;
}) {
  const [kind, setKind] = useState<DiagnosticKind>(target ? initial : 'server'),
    [credential, setCredential] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<DiagnosticResult>(),
    [error, setError] = useState('');
  const execute = async () => {
    setBusy(true);
    setError('');
    try {
      setResult(
        target
          ? await api.diagnose(target.id, kind as Exclude<DiagnosticKind, 'server'>, credential)
          : await api.serverHealth(server.id, credential),
      );
      setCredential('');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p>
        {server.name} · {serverAddress(server)}
      </p>
      {target && <p className="path">当前目标目录：{target.directory}</p>}
      <p className="note">
        仅执行列出的固定只读命令；不会执行启停、健康检查脚本或修改远程内容。诊断使用当前保存的目标和服务器配置。
      </p>
      {target && (
        <Field label="诊断项目">
          <select value={kind} onChange={(e) => setKind(e.target.value as DiagnosticKind)}>
            {(
              [
                'directory',
                'disk',
                'process',
                'lock',
                ...(target.mode === 'docker'
                  ? ['container', 'logs']
                  : target.appLogPath
                    ? ['logs']
                    : []),
              ] as DiagnosticKind[]
            ).map((k) => (
              <option key={k} value={k}>
                {labels[k]}
              </option>
            ))}
          </select>
        </Field>
      )}
      {server.auth !== 'alias' && (
        <Field
          label={server.auth === 'password' ? '本次登录密码' : '本次私钥口令'}
          hint={
            saved.includes(server.id) && server.credentialMode === 'windows'
              ? '可留空复用已保存凭据，本次输入不会另行保存。'
              : '只用于本次诊断内存，不进入配置和导出。'
          }
        >
          <input
            type="password"
            autoComplete="off"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
          />
        </Field>
      )}
      <button className="button primary" disabled={busy} onClick={() => void execute()}>
        {busy ? '读取中…' : '执行只读诊断'}
      </button>
      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <p className="note">
            {result.ok ? '检查完成' : '检查未通过'} · {fmtTime(result.time)}
          </p>
          <p className="path">执行命令：{result.command}</p>
          <pre className="terminal">{result.output || '没有输出'}</pre>
          <button
            className="button mt"
            onClick={() => {
              const text = result.command + '\n' + result.output;
              void (async () => {
                try {
                  await navigator.clipboard.writeText(text);
                } catch {
                  download('只读诊断.txt', text);
                }
              })();
            }}
          >
            复制命令和结果
          </button>
        </>
      )}
    </>
  );
}
export function FailureActions({
  error,
  directory,
  onDiagnose,
  onLogs,
  onIdentity,
  onBuild,
}: {
  error: string;
  directory: string;
  onDiagnose: (kind: DiagnosticKind) => void;
  onLogs: () => void;
  onIdentity: () => void;
  onBuild: () => void;
}) {
  const advice = failureAdvice(error);
  return (
    <div className="notice mt">
      <strong>{advice.reason}</strong>
      <p>{advice.text}</p>
      {advice.action === 'diagnose' && (
        <>
          <p className="path">目标目录：{directory}</p>
          <button
            className="button"
            onClick={() => onDiagnose(/空间/.test(advice.reason) ? 'disk' : 'directory')}
          >
            查看{/空间/.test(advice.reason) ? '磁盘剩余' : '目录权限'}
          </button>
        </>
      )}
      {advice.action === 'logs' && (
        <button className="button" onClick={onLogs}>
          查看应用日志
        </button>
      )}
      {advice.action === 'identity' && (
        <button className="button" onClick={onIdentity}>
          查看服务器配置
        </button>
      )}
      {advice.action === 'build' && (
        <button className="button" onClick={onBuild}>
          定位第一处错误
        </button>
      )}
    </div>
  );
}
export function BuildOnlyTask({
  task,
  onPrepare,
  onReport,
}: {
  task: Task;
  onPrepare: () => void;
  onReport: () => void;
}) {
  return (
    <>
      <Card title="构建与产物准备">
        <p>构建阶段未通过，尚未执行任何目标。耗时 {seconds(task.elapsed)}。</p>
        <Steps
          labels={task.buildSteps.map((s) => s.label)}
          details={task.buildSteps}
          current={task.buildPhase}
          failed={true}
        />
        <div className="row wrap mt">
          <button className="button" onClick={onPrepare}>
            重新准备部署
          </button>
          <button className="button" onClick={onReport}>
            导出部署报告
          </button>
        </div>
      </Card>
      <Card className="mt" title="构建日志">
        <NativeLogs taskId={task.id} targetId="none" initial={task.buildLogs} />
      </Card>
    </>
  );
}
