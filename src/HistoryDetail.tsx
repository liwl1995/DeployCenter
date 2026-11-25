import { Download, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from './design/ui/button';
import { HistoryLogViewer } from './HistoryLogViewer';
import { fmtTime, remoteJar, seconds, statusLabel, type History, type TaskRecord } from './model';
import { desktop } from './platform';
import { TimingTable } from './TimingTable';

export function HistoryDetail({
  value: h,
  canRollback,
  taskRecord,
  onRollback,
  onExport,
}: {
  value: History;
  canRollback: boolean;
  taskRecord?: TaskRecord;
  onRollback: () => void;
  onExport: () => void;
}) {
  const [nativeLog, setNativeLog] = useState<{
    build: string[];
    target: string[];
    truncated: boolean;
  }>();
  useEffect(() => {
    if (desktop) void desktop.readLogs(h.taskId, h.target.id).then(setNativeLog);
  }, [h.taskId, h.target.id]);
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
      <h3>构建日志</h3>
      <HistoryLogViewer lines={nativeLog?.build || taskRecord?.buildLogs || []} />
      <h3 className="mt">目标日志</h3>
      <HistoryLogViewer lines={nativeLog?.target || h.logs} />
      {nativeLog?.truncated && <p className="note">仅展示日志尾部，导出可取得完整文件。</p>}
      <h3 className="mt">构建步骤耗时</h3>
      <TimingTable steps={taskRecord?.buildSteps || []} />
      <h3 className="mt">目标步骤耗时</h3>
      <TimingTable steps={h.steps} />
      {!canRollback && h.id !== 'logs' && (
        <p className="note">
          {h.backupPath
            ? '当前目标配置或服务器身份已变化，禁止直接使用旧记录回滚。'
            : '无有效备份，不能发起历史回滚。'}
        </p>
      )}
      <footer className="modal-actions">
        <Button variant="neutral" size="compact" onClick={onExport}>
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
