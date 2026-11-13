import { useEffect, useState } from 'react';
import { Download, RefreshCw, Loader2, CheckCircle2 } from 'lucide-react';
import { Card, Modal } from './ui';
import type { DesktopAPI } from './platform';
import type { AppUpdate } from './app-update';

const size = (bytes: number) => (bytes / 1024 ** 2).toFixed(1) + ' MB';
export function AppUpdateSettings({
  api,
  version,
  active,
}: {
  api?: DesktopAPI;
  version: string;
  active: boolean;
}) {
  const [state, setState] = useState<AppUpdate>({
    currentVersion: version,
    stage: 'idle',
    received: 0,
    speed: 0,
  });
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!api) return;
    let disposed = false,
      revision = 0;
    const off = api.onEvent((event) => {
      if (event.kind === 'update') {
        revision++;
        setState(event.update);
      }
    });
    void api
      .updateState()
      .then((value) => {
        if (!disposed && revision === 0) setState(value);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      off();
    };
  }, [api]);
  const action = async (run: () => Promise<AppUpdate | void>) => {
    setError('');
    try {
      const result = await run();
      if (result) setState(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const working = ['checking', 'downloading', 'verifying', 'installing'].includes(state.stage);
  const downloading = state.stage === 'downloading';
  const hasUpdate = state.release && !['current', 'idle', 'checking'].includes(state.stage);
  const label = {
    idle: '手动检查正式版本，不会自动安装。',
    checking: '正在检查新版本…',
    current: '当前已是最新版本。',
    available: '发现新版本，可以下载安装包。',
    downloading: '正在下载安装包…',
    verifying: '正在校验安装包…',
    ready: '安装包已通过 SHA-256 校验，可以安装。',
    installing: '正在准备退出并启动安装向导…',
    error: '检查或下载未完成，可以重试。',
  }[state.stage];
  return (
    <>
      <Card className="app-update-settings">
        <div className="update-heading">
          <div>
            <h2>软件更新</h2>
            <p>
              YOTOO 部署中心 <strong>v{state.currentVersion}</strong>
            </p>
          </div>
          <div className="row wrap">
            {state.stage === 'ready' ? (
              <button
                className="button primary"
                disabled={!api || active}
                onClick={() => setConfirm(true)}
              >
                退出并安装
              </button>
            ) : hasUpdate && state.stage !== 'installing' ? (
              <button
                className="button primary"
                disabled={working || !api}
                onClick={() => void action(() => api!.downloadUpdate())}
              >
                <Download size={16} />
                {state.stage === 'error' ? '重新下载' : '下载更新'}
              </button>
            ) : (
              <button
                className="button primary"
                disabled={working || !api}
                onClick={() => void action(() => api!.checkUpdate())}
              >
                {working ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}检查更新
              </button>
            )}
            {downloading && (
              <button className="button" onClick={() => void action(() => api!.cancelUpdate())}>
                取消下载
              </button>
            )}
            {!working && hasUpdate && (
              <button className="button" onClick={() => void action(() => api!.checkUpdate())}>
                重新检查
              </button>
            )}
          </div>
        </div>
        <p className="update-status" role="status">
          {state.stage === 'ready' || state.stage === 'current' ? (
            <CheckCircle2 size={16} />
          ) : working ? (
            <Loader2 className="spin" size={16} />
          ) : null}
          {label}
        </p>
        {state.checkedAt && (
          <p className="note">
            最近检查：{new Date(state.checkedAt).toLocaleString('zh-CN', { hour12: false })}
          </p>
        )}
        {state.release && hasUpdate && (
          <div className="update-release">
            <div className="row wrap">
              <strong>新版本 v{state.release.version}</strong>
              <span className="muted">
                {state.release.publishedAt
                  ? new Date(state.release.publishedAt).toLocaleDateString('zh-CN')
                  : ''}{' '}
                · {size(state.release.size)}
              </span>
            </div>
            <details>
              <summary>查看更新说明</summary>
              <pre className="update-notes">{state.release.notes || '该版本未提供更新说明。'}</pre>
            </details>
          </div>
        )}
        {(downloading || state.stage === 'verifying') && (
          <div className="update-download">
            <progress
              aria-label="安装包下载进度"
              max={state.release?.size || 1}
              value={state.received}
            />
            <span>
              {size(state.received)} / {size(state.release?.size || 0)} ·{' '}
              {state.release
                ? Math.min(100, (state.received / state.release.size) * 100).toFixed(0)
                : 0}
              %{downloading ? ' · ' + size(state.speed) + '/秒' : ' · 校验中'}
            </span>
          </div>
        )}
        {(error || state.message) && (
          <p className="notice warning" role="alert">
            {error || state.message}
          </p>
        )}
        {active && (
          <p className="note">当前任务尚未结束，可以检查和下载更新；任务结束后才能安装。</p>
        )}
        {!api && <p className="note">请在 Windows 安装版中检查和安装更新。</p>}
      </Card>
      {confirm && (
        <Modal
          title="确认安装更新"
          onClose={() => setConfirm(false)}
          closeDisabled={state.stage === 'installing'}
          footer={
            <>
              <button
                className="button"
                disabled={state.stage === 'installing'}
                onClick={() => setConfirm(false)}
              >
                暂不安装
              </button>
              <button
                className="button primary"
                data-autofocus
                disabled={active || state.stage === 'installing'}
                onClick={() => void action(() => api!.installUpdate())}
              >
                确认退出并安装
              </button>
            </>
          }
        >
          <p>将退出 YOTOO 部署中心，并启动 v{state.release?.version} 的安装向导。</p>
          <p>沿用当前安装目录，保留服务、服务器、部署历史和用户数据。</p>
          <p className="note">安装向导中仍可取消；不会强制停止部署或远程维护操作。</p>
          {(error || state.message) && (
            <p className="notice warning" role="alert">
              {error || state.message}
            </p>
          )}
          {active && <p className="notice warning">请先等待当前任务结束。</p>}
        </Modal>
      )}
    </>
  );
}
