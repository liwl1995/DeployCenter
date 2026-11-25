import { Download, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from './design/ui/button';
import { HistoryLogViewer } from './HistoryLogViewer';
import { VirtualLogs } from './LogViewer';
import { fmtTime, remoteJar, seconds, statusLabel, type History, type TaskRecord } from './model';
import { desktop } from './platform';
import { TimingTable } from './TimingTable';

export function HistoryDetail({
  value: h,
  canRollback,
  taskRecord,
  onRollback,
  onExport,
  fullPage = false,
}: {
  value: History;
  canRollback: boolean;
  taskRecord?: TaskRecord;
  onRollback: () => void;
  onExport: () => void;
  fullPage?: boolean;
}) {
  const [nativeLog, setNativeLog] = useState<{
    build: string[];
    target: string[];
    truncated: boolean;
  }>();
  const [logError, setLogError] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    let current = true;
    void desktop.readLogs(h.taskId, h.target.id)
      .then((logs) => { if (current) setNativeLog(logs); })
      .catch(() => { if (current) setLogError(true); });
    return () => { current = false; };
  }, [h.taskId, h.target.id]);
  const hasBuildFile = !!nativeLog?.build.some(Boolean);
  const hasTargetFile = !!nativeLog?.target.some(Boolean);
  const savedBuild = taskRecord?.buildLogs;
  const savedTarget = h.logs;
  const entries = useMemo(() => {
    if (!fullPage) return [];
    const build = hasBuildFile ? nativeLog!.build : savedBuild || [];
    const target = hasTargetFile ? nativeLog!.target : savedTarget;
    return [build, target].flatMap((lines, section) => lines.some(Boolean) ? lines.map((text, i) => ({
      id: section + ':' + i, text, step: section === 0 ? '构建日志' : '目标日志',
    })) : []);
  }, [fullPage, hasBuildFile, hasTargetFile, nativeLog, savedBuild, savedTarget]);
  return (
    <>
      <dl className="detail-list">
        <dt>服务 / 环境</dt>
        <dd>
          {h.service.name} / {h.target.name}
        </dd>
        <dt>结果</dt>
        <dd>{statusLabel[h.status]}</dd>
        <dt>目标文件</dt>
        <dd className="path">{remoteJar(h.target)}</dd>
        <dt>Git</dt>
        <dd>
          {h.service.git.branch} · {h.service.git.commit}
        </dd>
        <dt>整体任务</dt>
        <dd>{seconds(taskRecord?.elapsed ?? h.elapsed)}</dd>
        <dt>时间 / 目标耗时</dt>
        <dd>
          {fmtTime(h.time)} / {seconds(h.elapsed)}
        </dd>
        <dt>备份</dt>
        <dd className="path">{h.backupPath || '本记录没有可恢复的备份'}</dd>
      </dl>
      {h.error && (
        <p className="warning">
          {h.error}
          <br />
          {h.recovery}
        </p>
      )}
      {h.cleanupWarning && <p className="warning">{h.cleanupWarning}</p>}
      {fullPage ? <>
        <section className="history-snapshot-logs" aria-label="执行日志">
          <h2>执行日志</h2>
          {!!entries.length && <VirtualLogs entries={entries} compact initialFollow={false} />}
          {logError ? <p role="status" className="note">无法读取完整日志文件{entries.length ? '，已显示历史记录保存的日志。' : '。'}</p> :
            !nativeLog ? <p role="status" className="note">正在读取日志…</p> :
              (!hasTargetFile || (!hasBuildFile && savedBuild?.some(Boolean))) ?
                <p className="note">完整日志未保存{entries.length ? '，已显示现有日志。' : '。'}</p> : null}
        </section>
        <details className="workspace-disclosure">
          <summary>步骤耗时</summary>
          {!!taskRecord?.buildSteps.length && <><h3>构建步骤</h3><TimingTable steps={taskRecord.buildSteps} /></>}
          <h3>目标步骤</h3>
          <TimingTable steps={h.steps} />
        </details>
      </> : <>
        <h3>构建日志</h3>
        <HistoryLogViewer lines={hasBuildFile ? nativeLog!.build : savedBuild || []} />
        <h3 className="mt">目标日志</h3>
        <HistoryLogViewer lines={hasTargetFile ? nativeLog!.target : savedTarget} />
        <h3 className="mt">构建步骤耗时</h3>
        <TimingTable steps={taskRecord?.buildSteps || []} />
        <h3 className="mt">目标步骤耗时</h3>
        <TimingTable steps={h.steps} />
      </>}
      {nativeLog?.truncated && <p className="note">仅展示日志尾部，导出可取得完整文件。</p>}
      {!canRollback && h.id !== 'logs' && (
        <p className="note">
          {h.backupPath
            ? '当前目标配置或服务器身份已变化，禁止直接使用旧记录回滚。'
            : '无有效备份，不能发起历史回滚。'}
        </p>
      )}
      <footer className="modal-actions">
        <Button variant="neutral" size="compact" disabled={fullPage && !entries.length} onClick={onExport}>
          <Download size={15} />
          导出日志
        </Button>
        {h.id !== 'logs' && (
          <Button variant="default" size="compact" disabled={!canRollback} onClick={onRollback}>
            <RotateCcw size={15} />
            回滚到此备份
          </Button>
        )}
      </footer>
    </>
  );
}
