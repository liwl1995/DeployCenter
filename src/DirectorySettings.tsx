import { useEffect, useRef, useState } from 'react';
import type { DesktopAPI } from './platform';
import type { DirectoryCheck, DirectoryInfo, MigrationProgress } from './features';
import { Card, Field, Modal } from './ui';
import { storageSize } from './DataSettings';
import { migrationPercent, migrationDestinationPreview, migrationPhase } from './migration-view';

function ParentDirectoryInput({
  id,
  value,
  disabled,
  browseDisabled,
  onChange,
  onBrowse,
}: {
  id?: string;
  value: string;
  disabled: boolean;
  browseDisabled: boolean;
  onChange: (value: string) => void;
  onBrowse: () => void;
}) {
  return (
    <div className="path-input">
      <input
        id={id}
        data-autofocus
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      <button type="button" className="button" disabled={browseDisabled} onClick={onBrowse}>
        浏览目录
      </button>
    </div>
  );
}

export function DirectorySettings({
  api,
  blocked,
  onManage,
  beforeMigrate,
}: {
  api: DesktopAPI;
  blocked?: string;
  onManage: () => void;
  beforeMigrate?: () => Promise<void>;
}) {
  const [info, setInfo] = useState<DirectoryInfo>();
  const [parent, setParent] = useState('');
  const [check, setCheck] = useState<DirectoryCheck>();
  const [progress, setProgress] = useState<MigrationProgress>();
  const [wizard, setWizard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const [suggestion, setSuggestion] = useState<number>();
  const [oldConfirm, setOldConfirm] = useState(false);
  const [typed, setTyped] = useState('');
  const cancelRequested = useRef(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const refresh = async () => {
    const [location, state] = await Promise.all([api.directoryInfo(), api.migrationState()]);
    setInfo(location);
    setProgress(state);
  };
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
    return api.onEvent((event) => {
      if (event.kind === 'migration') setProgress(event.progress);
    });
  }, [api]);
  const active = !!progress && ['preparing', 'copying', 'verifying'].includes(progress.state);
  const pending = progress?.state === 'pending' || !!info?.pending;
  useEffect(() => {
    if (active || pending) setWizard(true);
    if (active) cancelButton.current?.focus();
    if (!active) setCancelling(false);
  }, [active, pending]);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const inspect = () =>
    action(async () => {
      setSuggestion(undefined);
      setCheck(await api.inspectDirectory(parent));
    });
  const propose = () =>
    action(async () => {
      const plans = await Promise.all(
        ['policy', 'temporary', 'legacy-success'].map((kind) =>
          api.previewCleanup(kind as 'policy' | 'temporary' | 'legacy-success'),
        ),
      );
      const bytes = plans.reduce((total, plan) => total + plan.bytes, 0);
      if (bytes > 0) setSuggestion(bytes);
      else setCheck(await api.inspectDirectory(parent));
    });
  const start = () =>
    action(async () => {
      if (!check?.valid || blocked) return;
      cancelRequested.current = false;
      setProgress({
        state: 'preparing',
        copied: 0,
        total: info?.bytes || 0,
        files: 0,
        totalFiles: info?.files || 0,
        message: '正在准备迁移，原目录保留。',
        target: check.path,
      });
      try {
        await beforeMigrate?.();
        if (cancelRequested.current) {
          setProgress({
            state: 'cancelled',
            copied: 0,
            total: 0,
            files: 0,
            totalFiles: 0,
            message: '迁移已取消，继续使用原目录。',
          });
          return;
        }
        setProgress(await api.migrateDirectory(parent));
        await refresh();
      } catch (e) {
        const state = await api.migrationState().catch(() => undefined);
        setProgress({
          ...(state && state.target === check.path
            ? state
            : { copied: 0, total: 0, files: 0, totalFiles: 0 }),
          state: cancelRequested.current ? 'cancelled' : 'failed',
          message: String(e) + '；继续使用原目录。',
        });
        throw e;
      }
    });
  const changeParent = (value: string) => {
    setParent(value);
    setCheck(undefined);
    setError('');
  };
  const finalPath = check?.path || migrationDestinationPreview(parent);
  const finished = progress && ['failed', 'cancelled'].includes(progress.state);
  return (
    <>
      <Card
        title="数据位置"
        action={
          <button
            className="button"
            disabled={!!blocked && !active && !pending}
            onClick={() => {
              setError('');
              setWizard(true);
            }}
          >
            {active || pending ? '查看迁移进度' : '更换数据目录'}
          </button>
        }
      >
        <Field label="当前目录">
          <input readOnly value={info?.path || '读取中…'} />
        </Field>
        <p className="note">
          当前占用 {info ? storageSize(info.bytes) : '读取中…'}
          。配置、历史、完整日志、产物、临时文件和备份全部随目录迁移。
        </p>
        <button className="link" onClick={() => void api.openDataDir()}>
          打开当前目录
        </button>
        {blocked && (
          <p className="warning" role="status">
            {blocked}
          </p>
        )}
        {(active || pending) && (
          <p className="notice mt" role="status">
            {pending
              ? '迁移已完成，重启后使用新目录，旧目录默认保留。'
              : migrationPhase(progress?.state) + ' · ' + migrationPercent(progress) + '%'}
          </p>
        )}
        {info?.previous && !pending && (
          <div className="notice mt">
            <strong>原数据副本仍保留</strong>
            <p className="path">{info.previous}</p>
            <p>
              约 {info.previousBytes === undefined ? '无法读取' : storageSize(info.previousBytes)}
              。旧目录默认保留；核对新目录的配置、历史、日志和凭据后，是否删除旧副本？
            </p>
            <div className="row wrap">
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await api.keepOldData();
                    await refresh();
                  })
                }
              >
                保留旧目录（默认）
              </button>
              <button
                className="link"
                disabled={busy || !!blocked}
                onClick={() => {
                  setTyped('');
                  setOldConfirm(true);
                }}
              >
                查看旧目录清理确认
              </button>
            </div>
          </div>
        )}
        {!wizard && error && (
          <p role="alert" className="warning">
            {error}
          </p>
        )}
      </Card>
      {wizard && (
        <Modal
          title="更换数据目录"
          closeDisabled={active || busy}
          onClose={() => {
            if (!active && !busy) setWizard(false);
          }}
          wide
        >
          <div className="migration-wizard">
            <div className="migration-body">
              <ol className="migration-stages" aria-label="迁移阶段">
                {['准备', '复制', '校验', '完成待重启'].map((text, i) => (
                  <li
                    key={text}
                    aria-current={
                      (progress?.state === 'copying'
                        ? 1
                        : progress?.state === 'verifying'
                          ? 2
                          : pending
                            ? 3
                            : 0) === i
                        ? 'step'
                        : undefined
                    }
                  >
                    {i + 1}. {text}
                  </li>
                ))}
              </ol>
              <p className="note">当前目录：{info?.path}</p>
              {!active && !pending && !finished && (
                <>
                  <Field
                    label="选择上级目录"
                    hint="只选择上级目录。应用会自动创建 DeployCenter 子目录，不会把数据直接放在上级目录中。"
                  >
                    <ParentDirectoryInput
                      value={parent}
                      disabled={busy}
                      browseDisabled={busy || !!blocked}
                      onChange={changeParent}
                      onBrowse={() =>
                        void action(async () => {
                          const selected = await api.choose('directory');
                          if (selected) changeParent(selected);
                        })
                      }
                    />
                  </Field>
                </>
              )}
              <div className="notice migration-destination">
                <strong>最终数据目录</strong>
                <p className="path" data-testid="migration-final-path">
                  {pending
                    ? info?.pending || progress?.target
                    : progress?.target && (active || finished)
                      ? progress.target
                      : finalPath || '选择上级目录后显示'}
                </p>
              </div>
              {!active && !pending && !finished && (
                <p className="note">
                  最终目录须为空或尚不存在；已存在的非空 DeployCenter
                  不会覆盖。现有数据位置不受升级影响。
                </p>
              )}
              {check && !active && !pending && !finished && (
                <div className="notice mt" role="status">
                  <strong>{check.valid ? '目录检查通过' : '目录不可用'}</strong>
                  <p>
                    目录可写：{check.writable ? '是' : '否'} · 空目录：{check.empty ? '是' : '否'}
                  </p>
                  <p>
                    可用空间 {storageSize(check.available)}；需要约 {storageSize(check.required)}
                  </p>
                  {check.errors.map((item) => (
                    <p className="warning" key={item}>
                      {item}
                    </p>
                  ))}
                  {check.valid && (
                    <p>
                      将复制全部内容，核对文件数量、大小、指纹及数据库。完成后需重启生效，原目录默认保留；取消或失败继续使用原目录。
                    </p>
                  )}
                </div>
              )}
              {(active || pending || finished) && progress && (
                <div className="migration-progress mt" role="status">
                  <h3>{migrationPhase(progress.state)}</h3>
                  <p>{progress.message}</p>
                  <progress
                    aria-label="数据迁移总进度"
                    max={100}
                    value={migrationPercent(progress)}
                  />
                  <p>
                    总进度 {migrationPercent(progress)}% · 已复制 {storageSize(progress.copied)} /{' '}
                    {storageSize(progress.total)} · {progress.files} / {progress.totalFiles} 个文件
                  </p>
                  {progress.state === 'verifying' && (
                    <p>
                      已校验 {progress.verifiedFiles || 0} / {progress.totalFiles} 个文件
                    </p>
                  )}
                  <p className="path">
                    当前文件：{progress.currentFile || (pending ? '全部完成' : '准备文件清单…')}
                  </p>
                  <p>
                    速度：
                    {progress.bytesPerSecond
                      ? storageSize(progress.bytesPerSecond) + '/秒'
                      : '估算中'}{' '}
                    · 本阶段预计剩余：
                    {progress.remainingSeconds === undefined
                      ? '估算中'
                      : Math.ceil(progress.remainingSeconds) + ' 秒'}
                  </p>
                </div>
              )}
              {pending && (
                <p className="notice mt">
                  迁移已完成，重启后生效。旧目录默认保留，重启并核对数据后可选择是否删除。
                </p>
              )}
              {finished && (
                <p className="warning">
                  {progress.state === 'cancelled' ? '迁移已取消' : '迁移未完成'}
                  ，继续使用原目录，原始数据保留。
                </p>
              )}
              {blocked && <p className="warning">{blocked}</p>}
              {error && (
                <p className="warning" role="alert">
                  {error}
                </p>
              )}
            </div>
            <footer className="wizard-actions">
              {active ? (
                <button
                  className="button"
                  ref={cancelButton}
                  disabled={cancelling}
                  onClick={() => {
                    cancelRequested.current = true;
                    setCancelling(true);
                    void api.cancelMigration().catch((e) => {
                      setError(String(e));
                      setCancelling(false);
                    });
                  }}
                >
                  {cancelling ? '正在取消，等待安全清理…' : '取消迁移，保留原目录'}
                </button>
              ) : pending ? (
                <>
                  <button className="button" onClick={() => setWizard(false)}>
                    稍后重启
                  </button>
                  <button
                    className="button primary"
                    onClick={() => void action(() => api.restart())}
                  >
                    重启并使用新目录
                  </button>
                </>
              ) : finished ? (
                <>
                  <button className="button" onClick={() => setWizard(false)}>
                    关闭
                  </button>
                  <button
                    className="button primary"
                    onClick={() => {
                      setProgress(undefined);
                      setCheck(undefined);
                      setError('');
                    }}
                  >
                    重新选择目录
                  </button>
                </>
              ) : (
                <>
                  <button className="button" disabled={busy} onClick={() => setWizard(false)}>
                    取消
                  </button>
                  <button
                    className="button primary"
                    disabled={busy || !!blocked || !parent || (!!check && !check.valid)}
                    onClick={() => void (check?.valid ? start() : propose())}
                  >
                    {busy ? '检查中…' : check?.valid ? '开始迁移' : '检查并准备迁移'}
                  </button>
                  {check && (
                    <button className="link" disabled={busy} onClick={() => setCheck(undefined)}>
                      修改目录
                    </button>
                  )}
                </>
              )}
            </footer>
          </div>
        </Modal>
      )}
      {suggestion !== undefined && (
        <Modal title="迁移前可以先减少数据占用" onClose={() => setSuggestion(undefined)}>
          <p>
            按当前保留策略及旧版成功产物，可先清理约 {storageSize(suggestion)}
            。具体范围和重试影响会在清理确认中列出，不强制清理。
          </p>
          <footer className="modal-actions">
            <button className="button" onClick={() => void inspect()}>
              保持现状，继续检查目录
            </button>
            <button
              className="button primary"
              onClick={() => {
                setSuggestion(undefined);
                setWizard(false);
                onManage();
              }}
            >
              先查看占用与清理
            </button>
          </footer>
        </Modal>
      )}
      {/* 旧目录删除继续沿用完整路径确认与现有后端边界。 */}
      {oldConfirm && info?.previous && (
        <Modal
          title="确认删除旧数据副本"
          onClose={() => {
            if (!busy) setOldConfirm(false);
          }}
        >
          <p className="warning">
            将永久删除以下旧副本中的全部文件，约{' '}
            {info.previousBytes === undefined ? '无法读取' : storageSize(info.previousBytes)}
            。只有路径与原副本内容都未改变时才执行；新目录不受影响。
          </p>
          <p className="path">{info.previous}</p>
          <Field label="输入完整旧目录路径确认">
            <input data-autofocus value={typed} onChange={(e) => setTyped(e.target.value)} />
          </Field>
          <footer className="modal-actions">
            <button className="button" disabled={busy} onClick={() => setOldConfirm(false)}>
              保留
            </button>
            <button
              className="button"
              disabled={busy || typed !== info.previous}
              onClick={() =>
                void action(async () => {
                  await api.removeOldData(typed);
                  setOldConfirm(false);
                  await refresh();
                })
              }
            >
              删除已核对的旧副本
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
}
