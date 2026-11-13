import type { RunTarget } from './model';
/** 上传状态原位更新，不作为新日志行落盘，避免进度刷屏或掩盖关键事件。 */
export function UploadProgress({ upload }: { upload: NonNullable<RunTarget['upload']> }) {
  const percent = Math.min(100, Math.max(0, upload.percent));
  const done = Math.round(percent / 5);
  return (
    <div
      className="terminal-upload"
      role="progressbar"
      aria-label="文件上传进度"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span>
        上传 [{'='.repeat(done)}
        {'-'.repeat(20 - done)}]
      </span>{' '}
      <b>{percent}%</b>
      <span>
        {(upload.bytes / 1048576).toFixed(1)} / {(upload.total / 1048576).toFixed(1)} MB
      </span>
      <span>{upload.speed > 0 ? (upload.speed / 1048576).toFixed(1) + ' MB/s' : '等待传输'}</span>
      {upload.speed > 0 && (
        <span>剩余 {Math.ceil(Math.max(0, upload.total - upload.bytes) / upload.speed)} 秒</span>
      )}
    </div>
  );
}
