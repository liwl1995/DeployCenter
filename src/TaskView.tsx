import { useState } from 'react';
import { ArrowLeft, Check, Circle, CircleAlert, Clock3, Loader2, Minus, X } from 'lucide-react';
import { desktop } from './platform';
import { Badge, Card, Demo } from './ui';
import { MoreMenu, type MenuAction } from './EntityActions';
import { Disclosure } from './WorkspaceLayout';
import { NativeLogPanel } from './NativeLogPanel';
import { VirtualLogs } from './LogViewer';
import { diagnostics } from './validation';
import { remoteJar, seconds, type RunTarget, type Step, type Task } from './model';
import { failureAdvice, operationLabel, shortHash, taskResult } from './presentation';
import type { DiagnosticKind } from './features';

const names: Record<string, string> = {
  local: '检查本机配置',
  environment: '检查本机构建环境',
  build: '构建部署文件',
  artifact: '校验部署文件',
  connect: '连接服务器',
  preflight: '检查服务器环境',
  mount: '检查容器挂载',
  upload: '上传文件',
  verify: '校验文件',
  permissions: '准备文件权限',
  backup: '备份旧版本',
  stop: '停止服务',
  replace: '替换文件',
  chmod: '设置执行权限',
  start: '启动服务',
  containerHash: '核对容器中的文件',
  stability: '检查容器运行状态',
  health: '检查应用是否可用',
  rollback: '恢复并检查旧版本',
};
const targetStatus: Record<RunTarget['status'], string> = {
  pending: '等待',
  running: '进行中',
  success: '成功',
  unverified: '成功，健康未验证',
  failed: '失败',
  rollingback: '回滚中',
  rolledback: '失败，已回滚',
  skipped: '已跳过',
  cancelled: '已取消',
  unknown: '待核实',
};
const stageNames = ['构建', '上传与校验', '备份', '切换', '检查'];
const statusText = {
  pending: '等待',
  running: '进行中',
  success: '已完成',
  failed: '失败',
  skipped: '已跳过',
  warning: '需关注',
};
type Status = keyof typeof statusText;
const icons = {
  pending: Circle,
  running: Loader2,
  success: Check,
  failed: X,
  skipped: Minus,
  warning: CircleAlert,
};

function stageOf(step: Step) {
  if (step.key === 'backup') return 2;
  if (['stop', 'replace', 'chmod', 'start', 'rollback'].includes(step.key)) return 3;
  if (['health', 'containerHash', 'stability'].includes(step.key)) return 4;
  return 1;
}

function resultFor(task: Task, run?: RunTarget): { tone: Status; text: string } {
  if (task.status === 'cancelled')
    return { tone: 'skipped', text: '任务已取消。请查看已完成目标的结果。' };
  if (task.status === 'interrupted')
    return { tone: 'warning', text: '执行结果待核实。请核实原任务，再决定是否重试。' };
  if (task.dryRun)
    return task.status === 'success'
      ? { tone: 'success', text: '试运行通过。可进入正式部署确认。' }
      : { tone: 'failed', text: '试运行未通过。请查看失败位置并重新检查。' };
  if (task.buildSteps.some((step) => step.status === 'failed'))
    return { tone: 'failed', text: '本机构建或产物准备失败。请查看失败位置。' };
  if (run?.status === 'rolledback')
    return { tone: 'warning', text: '新版本部署失败，已自动恢复旧版本。请查看失败位置。' };
  if (
    run?.remote?.finalState === 'ROLLBACK_FAILED' ||
    run?.steps.some((s) => s.key === 'rollback' && s.status === 'failed')
  )
    return { tone: 'failed', text: '自动回滚失败。当前运行版本待核实，请查看失败位置。' };
  if (run?.status === 'unverified')
    return { tone: 'warning', text: '已部署，但无法确认应用可用。此目标未执行健康检查。' };
  if (run?.status === 'success')
    return {
      tone: 'success',
      text: task.operation === 'rollback' ? '已回滚成功。' : '已部署成功。',
    };
  if (run?.status === 'skipped')
    return { tone: 'skipped', text: '此目标已跳过。可切换目标查看执行结果。' };
  if (run?.status === 'cancelled')
    return { tone: 'skipped', text: '此目标已取消。请查看已执行的步骤。' };
  if (run?.status === 'unknown')
    return { tone: 'warning', text: '此目标的结果待核实。请先核实原任务。' };
  if (!run) return { tone: 'failed', text: '未能准备部署文件，尚未执行任何目标。请查看日志。' };
  const failed = run.steps.find((s) => s.status === 'failed');
  const reason = failed
    ? (names[failed.key] || failed.label) + '失败'
    : failureAdvice(run?.error || '').reason;
  return { tone: 'failed', text: reason + '。请查看失败位置。' };
}

export function TaskView({
  task,
  inspected,
  setInspected,
  backLabel,
  onBack,
  onCancel,
  onFailure,
  demoMode,
  onRetry,
  onPrepareAgain,
  onPromote,
  onRecheck,
  onDiagnose,
  onIdentity,
  onReport,
  onRollback,
  onCopy,
  onLog,
  onHealth,
  onRecover,
  onObserve,
  onBackups,
}: {
  task: Task;
  inspected: number;
  setInspected: (index: number) => void;
  backLabel: string;
  onBack: () => void;
  onCancel: () => void;
  onFailure: (kind?: 'application' | 'containerHash') => void;
  demoMode: boolean;
  onRetry: (failed: boolean) => Promise<import('./features').SnapshotAvailability | undefined>;
  onPrepareAgain: (failed?: boolean) => void;
  onPromote?: () => void;
  onRecheck?: () => void;
  onDiagnose?: (kind: DiagnosticKind) => void;
  onIdentity: () => void;
  onReport?: () => void;
  onRollback?: () => void;
  onCopy: (text: string) => void;
  onLog: (text: string) => void;
  onHealth?: () => void;
  onRecover?: () => void;
  onObserve?: () => void;
  onBackups?: () => void;
}) {
  const run = task.targets[inspected];
  const active = task.status === 'running' || task.status === 'cancelling';
  const result = resultFor(task, run);
  const groups = stageNames.map((name, index) => ({
    name,
    steps: index === 0 ? task.buildSteps : (run?.steps || []).filter((s) => stageOf(s) === index),
  }));
  const stages = groups.map(({ name, steps }, index) => {
    const skippedBuild = index === 0 && task.build === 'existing' && !task.dryRun;
    const elapsed = steps.reduce((total, step) => total + (step.elapsed || 0), 0);
    let status: Status = 'pending';
    if (steps.some((s) => s.status === 'running')) status = 'running';
    else if (steps.some((s) => s.status === 'failed')) status = 'failed';
    else if (index === 4 && run?.status === 'unverified') status = 'warning';
    else if (skippedBuild || steps.every((s) => s.status === 'skipped')) status = 'skipped';
    else if (steps.some((s) => s.status === 'success')) status = 'success';
    const summary =
      index === 2 &&
      status === 'skipped' &&
      run?.backup.enabled &&
      !run.target.hasOldJar &&
      steps.length > 0
        ? '首次部署，无旧版本'
        : status === 'warning'
          ? '未验证'
          : status === 'success' || status === 'running'
            ? statusText[status] + ' · ' + seconds(elapsed)
            : statusText[status];
    return {
      name,
      steps: skippedBuild ? steps.filter((s) => s.key !== 'build') : steps,
      status,
      summary,
    };
  });
  const failedStage = stages.findIndex((s) => s.status === 'failed');
  const runningStage = stages.findIndex((s) => s.status === 'running');
  const warnedStage = stages.findIndex((s) => s.status === 'warning');
  const defaultStage = active
    ? runningStage >= 0
      ? runningStage
      : task.buildPhase < 3
        ? 0
        : stages.findIndex((s) => s.status === 'pending')
    : failedStage >= 0
      ? failedStage
      : warnedStage >= 0
        ? warnedStage
        : run
          ? 4
          : 0;
  const [selection, setSelection] = useState<{ target: number; stage: number; active: boolean }>();
  const [logFocus, setLogFocus] = useState<{ names: string[]; nonce: number }>();
  const [logError, setLogError] = useState<number>();
  const [retryIssue, setRetryIssue] = useState<{ reason: string; failed: boolean }>();
  const [retrying, setRetrying] = useState(false);
  const stage =
    selection?.target === inspected && selection.active === active
      ? selection.stage
      : Math.max(0, defaultStage);
  const logs = [...task.buildLogs, ...(run?.logs || [])];
  const targetId = run?.target.id || 'none';
  const choose = (index: number) => {
    setSelection({ target: inspected, stage: index, active });
    setLogFocus({ names: stages[index].steps.map((step) => step.label), nonce: Date.now() });
  };
  const locateFailure = () => {
    if (failedStage >= 0) setSelection({ target: inspected, stage: failedStage, active });
    if (failedStage >= 0 && stages[failedStage].steps.some((step) => step.status === 'failed')) {
      setLogFocus({
        names: stages[failedStage].steps
          .filter((step) => step.status === 'failed')
          .map((step) => step.label),
        nonce: Date.now(),
      });
    } else setLogError(Date.now());
    document.getElementById('task-stage-detail')?.scrollIntoView({ block: 'nearest' });
  };
  const retry = async (failed: boolean) => {
    if (retrying) return;
    setRetryIssue(undefined);
    setRetrying(true);
    try {
      const issue = await onRetry(failed);
      if (issue && !issue.available) setRetryIssue({ reason: issue.reason, failed });
    } finally {
      setRetrying(false);
    }
  };
  const failedTargets = task.targets.some((entry) =>
    ['failed', 'rolledback'].includes(entry.status),
  );
  const canRetry =
    !active && !task.dryRun && task.status !== 'interrupted' && task.operation === 'deploy';
  const openLogs = () => onLog('模拟容器日志 · 服务初始化中…');
  const more: MenuAction[] = [];
  if (run?.target.mode === 'docker') more.push({ label: '查看容器日志', onClick: openLogs });
  if (run)
    more.push({
      label: '复制排查命令',
      onClick: () => onCopy(diagnostics(run.server, run.target)),
    });
  if (!active) {
    if (onRollback && !task.dryRun) more.push({ label: '回滚到本次部署之前', onClick: onRollback });
    if (onReport) more.push({ label: '导出部署报告', onClick: onReport });
    if (canRetry && task.targets.length)
      more.push({ label: '重新部署本次目标', onClick: () => void retry(false) });
    if (task.dryRun && onRecheck && task.status === 'success')
      more.push({ label: '重新检查', onClick: onRecheck });
    if (onObserve) more.push({ label: '查看或停止日志观察', onClick: onObserve });
    if (onBackups) more.push({ label: '查看远程备份保留建议', onClick: onBackups });
    if (run?.error && onDiagnose) {
      const advice = failureAdvice(run.error);
      if (advice.action === 'identity') more.push({ label: '查看服务器配置', onClick: onIdentity });
      if (advice.action === 'logs' && run.target.mode !== 'docker')
        more.push({ label: '查看应用日志', onClick: openLogs });
      if (advice.action === 'diagnose')
        more.push({
          label: '只读检查目录或空间',
          onClick: () => onDiagnose(/空间/.test(advice.reason) ? 'disk' : 'directory'),
        });
    }
  }
  const primary =
    task.status === 'running'
      ? {
          label: task.dryRun ? '取消检查' : task.operation === 'rollback' ? '取消回滚' : '取消部署',
          action: onCancel,
        }
      : onRecover && task.status === 'interrupted'
        ? { label: '核实原任务', action: onRecover }
        : task.dryRun && task.status === 'success' && onPromote
          ? { label: '正式部署', action: onPromote }
          : task.dryRun && !active && task.status !== 'interrupted' && onRecheck
            ? { label: '重新检查', action: onRecheck }
            : canRetry && failedTargets
              ? {
                  label: retrying ? '检查重试条件…' : '重试失败目标',
                  action: () => void retry(true),
                }
              : canRetry && task.status === 'failed'
                ? { label: '重新准备部署', action: () => onPrepareAgain(false) }
                : undefined;
  const copyLogs = () =>
    desktop
      ? void desktop
          .readLogs(task.id, targetId)
          .then((value) =>
            value.truncated
              ? void desktop!.exportLogs(task.id, targetId)
              : onCopy([...value.build, ...value.target].join('\n')),
          )
      : onCopy(logs.join('\n'));
  const bannerAction =
    result.tone === 'failed' || run?.status === 'rolledback'
      ? { label: '查看失败位置', action: locateFailure }
      : run?.status === 'unverified' && task.status !== 'interrupted' && !active && onHealth
        ? { label: '去配置健康检查', action: onHealth }
        : undefined;

  return (
    <section className="task-page">
      <header className="task-page-header">
        <div className="task-title-row">
          <div className="task-title">
            <p className="muted">{active ? '当前任务' : '任务详情'}</p>
            <h1>
              {task.service.name} ·{' '}
              {task.targets.length > 1
                ? task.targets.length + ' 个环境'
                : run?.target.name || '本机构建'}{' '}
              · {operationLabel(task)}
            </h1>
          </div>
          <Badge
            kind={
              active
                ? ''
                : result.tone === 'success'
                  ? 'good'
                  : ['failed', 'warning'].includes(result.tone)
                    ? 'warn'
                    : ''
            }
          >
            {task.status === 'cancelling' ? '安全取消中' : taskResult(task)}
          </Badge>
        </div>
        <div className="task-title-row task-header-bottom">
          <p className="muted task-summary">
            <Clock3 size={14} />
            {seconds(task.elapsed)}{' '}
            <span>
              Git <code>{shortHash(task.deployedCommit || task.service.git.commit)}</code>
            </span>{' '}
            <span>
              JAR <code>{shortHash(task.artifact.sha256)}</code>
            </span>
          </p>
          <div className="row wrap">
            <button className="button" onClick={onBack}>
              <ArrowLeft size={15} />
              {backLabel}
            </button>
            {primary && (
              <button className="button primary" disabled={retrying} onClick={primary.action}>
                {primary.label}
              </button>
            )}
            {!!more.length && <MoreMenu label="更多任务操作" actions={more} />}
          </div>
        </div>
      </header>
      {!active && (
        <div className={'task-result-banner task-tone-' + result.tone} role="status">
          <strong>{result.text}</strong>
          {bannerAction && (
            <button className="link" onClick={bannerAction.action}>
              {bannerAction.label}
            </button>
          )}
        </div>
      )}
      {run?.cleanupWarning && (
        <p className="warning" role="status">
          {run.cleanupWarning}
        </p>
      )}
      {retryIssue && (
        <div className="notice" role="status">
          <p>{retryIssue.reason}</p>
          <button className="link" onClick={() => onPrepareAgain(retryIssue.failed)}>
            重新构建或选择现有 JAR
          </button>
        </div>
      )}
      {demoMode && task.status === 'running' && (
        <Demo>
          <button className="link" onClick={() => onFailure()}>
            模拟当前目标启动 / 健康检查失败
          </button>
          {task.targets[task.active]?.target.mode === 'docker' && (
            <button className="link" onClick={() => onFailure('containerHash')}>
              模拟容器内哈希不一致
            </button>
          )}
        </Demo>
      )}
      {task.targets.length > 1 && (
        <div className="task-target-tabs" role="group" aria-label="选择任务目标">
          {task.targets.map((entry, index) => (
            <button
              className="button"
              aria-pressed={inspected === index}
              key={entry.target.id}
              onClick={() => {
                setSelection(undefined);
                setLogFocus(undefined);
                setLogError(undefined);
                setInspected(index);
              }}
            >
              <span className={'task-status-dot task-target-' + entry.status} aria-hidden="true" />
              {entry.target.name} ·{' '}
              {task.dryRun && entry.status === 'success' ? '检查通过' : targetStatus[entry.status]}
            </button>
          ))}
        </div>
      )}
      <div className="task-stages" role="group" aria-label="部署阶段">
        {stages.map((entry, index) => {
          const Icon = icons[entry.status];
          return (
            <button
              className={'task-stage task-tone-' + entry.status}
              key={entry.name}
              aria-pressed={stage === index}
              onClick={() => choose(index)}
            >
              <Icon size={16} aria-hidden="true" />
              <span>
                <strong>{entry.name}</strong>
                <small>{entry.summary}</small>
              </span>
            </button>
          );
        })}
      </div>
      <div className="task-process">
        <Card title={stages[stage].name + '详情'}>
          <div id="task-stage-detail">
            {stages[stage].steps.length ? (
              <ul className="task-step-list">
                {stages[stage].steps.map((step, index) => {
                  const status = step.status || 'pending',
                    Icon = icons[status];
                  const label =
                    step.key === 'upload' && task.operation === 'rollback'
                      ? '准备历史备份'
                      : names[step.key] || step.label;
                  const upload =
                    step.key === 'upload' && run?.upload && run.upload.total > 0
                      ? run.upload
                      : undefined;
                  return (
                    <li key={step.key + index} className={'task-tone-' + status}>
                      <div className="task-step-row">
                        <Icon size={15} aria-label={statusText[status]} />
                        <button
                          className="link"
                          title={step.label}
                          onClick={() => setLogFocus({ names: [step.label], nonce: Date.now() })}
                        >
                          {label}
                        </button>
                        {(status === 'running' || status === 'success') && (
                          <small>{seconds(step.elapsed || 0)}</small>
                        )}
                      </div>
                      {upload && (
                        <div className="task-upload">
                          <progress max={100} value={upload.percent} aria-label="文件上传进度" />
                          <p>
                            {Math.round(upload.percent)}% · {(upload.bytes / 1048576).toFixed(1)} /{' '}
                            {(upload.total / 1048576).toFixed(1)} MB
                            {status === 'running' && upload.speed > 0 && (
                              <>
                                {' '}
                                · {(upload.speed / 1048576).toFixed(1)} MB/s · 约剩{' '}
                                {seconds(Math.max(0, upload.total - upload.bytes) / upload.speed)}
                              </>
                            )}
                          </p>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted">此阶段没有步骤记录。</p>
            )}
            {stage === failedStage && run?.error && (
              <p className="warning">
                {run.error}
                {run.recovery && (
                  <>
                    <br />
                    {run.recovery}
                  </>
                )}
              </p>
            )}
          </div>
        </Card>
        <Card
          title="执行日志"
          action={
            <div className="row wrap">
              <button className="link" onClick={copyLogs}>
                {desktop ? '复制完整日志' : '复制日志'}
              </button>
            </div>
          }
        >
          {desktop ? (
            <NativeLogPanel
              key={targetId}
              taskId={task.id}
              targetId={targetId}
              initial={logs}
              focusStep={logFocus}
              focusError={logError}
            />
          ) : (
            <VirtualLogs entries={logs.map((text, index) => ({ id: String(index), text }))} />
          )}
        </Card>
      </div>
      <Disclosure title="任务详情">
        <dl className="detail-list">
          <dt>任务编号</dt>
          <dd className="path">
            {task.id}{' '}
            <button className="link" onClick={() => onCopy(task.id)}>
              复制编号
            </button>
          </dd>
          {run && (
            <>
              <dt>服务器</dt>
              <dd>{run.server.name}</dd>
              <dt>远程路径</dt>
              <dd className="path">{remoteJar(run.target)}</dd>
              <dt>备份位置</dt>
              <dd className="path">{run.backupPath || '没有已记录的备份'}</dd>
            </>
          )}
          <dt>Git 提交</dt>
          <dd className="path">{task.deployedCommit || task.service.git.commit || '未记录'}</dd>
          <dt>JAR 指纹</dt>
          <dd className="path">{task.artifact.sha256 || '未记录'}</dd>
        </dl>
      </Disclosure>
    </section>
  );
}
