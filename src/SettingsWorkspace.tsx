import { Button } from './design/ui/button';
import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { BookOpen, ChevronRight, Code2, Download, GraduationCap, Info, Upload } from 'lucide-react';
import { AppUpdateSettings } from './AppUpdateSettings';
import { DataSettings } from './DataSettings';
import { DirectorySettings } from './DirectorySettings';
import { PreferenceChoice } from './PreferenceChoice';
import { HistoryRetention } from './HistoryRetention';
import { staleLockMinutesRange } from './defaults';
import type { Database } from './model';
import type { DesktopAPI } from './platform';
import { pruneHistory } from './records';
import { Card, Demo, Field, Switch } from './ui';
import { WorkspaceTabs } from './WorkspaceLayout';
import { zoomOptions, type DesktopPreferences } from './desktop-preferences';

type Density = 'compact' | 'comfortable';
export const settingsLabels = {
  general: '通用',
  deploy: '部署与构建',
  data: '数据与备份',
  update: '软件更新',
  help: '关于与帮助',
} as const;
export type SettingsSection = keyof typeof settingsLabels;

export function SettingsWorkspace({
  desktop,
  db,
  setDb,
  section,
  onSection,
  density,
  onDensity,
  migrationBlock,
  busy,
  version,
  updateAvailable,
  preferences,
  onPreferences,
  showDemo,
  onImport,
  onExport,
  onTutorial,
}: {
  desktop?: DesktopAPI;
  db: Database;
  setDb: Dispatch<SetStateAction<Database>>;
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  density: Density;
  onDensity: (density: Density) => void;
  migrationBlock?: string;
  busy: boolean;
  version: string;
  updateAvailable?: boolean;
  preferences: DesktopPreferences;
  onPreferences: (preferences: DesktopPreferences) => void;
  showDemo?: boolean;
  onImport: () => void;
  onExport: () => void;
  onTutorial: () => void;
}) {
  const usageRef = useRef<HTMLDListElement>(null);
  const [saving, setSaving] = useState(false);
  const [preferenceError, setPreferenceError] = useState('');
  const [lockMinutesDraft, setLockMinutesDraft] = useState<string>();
  const lockMinutesValue = lockMinutesDraft ?? String(db.settings.staleLockMinutes ?? 120);
  const lockMinutes = Number(lockMinutesValue);
  const { min, max } = staleLockMinutesRange;
  const validLockMinutes = /^[0-9]+$/.test(lockMinutesValue) && lockMinutes >= min && lockMinutes <= max;
  const lockMinutesHint = validLockMinutes
    ? '范围 ' + min + '–' + max + ' 分钟。按回车或离开输入框保存。'
    : '请输入 ' + min + '–' + max + ' 之间的整数。按 Esc 恢复原值。';
  const commitLockMinutes = () => {
    // 清空或继续输入时的中间值不能进入自动保存的配置。
    if (lockMinutesDraft === undefined || !validLockMinutes) return;
    setLockMinutesDraft(undefined);
    setDb((old) =>
      lockMinutes === (old.settings.staleLockMinutes ?? 120)
        ? old
        : { ...old, settings: { ...old.settings, staleLockMinutes: lockMinutes } },
    );
  };
  async function changePreferences(changes: Partial<DesktopPreferences>) {
    if (!desktop || saving) return;
    setSaving(true);
    setPreferenceError('');
    try {
      onPreferences(await desktop.saveDesktopPreferences(changes));
    } catch (error) {
      setPreferenceError(String(error instanceof Error ? error.message : error)
        .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
    } finally {
      setSaving(false);
    }
  }
  const scrollToUsage = () =>
    usageRef.current?.scrollIntoView({
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
      block: 'center',
    });
  const historyFields = (
    <HistoryRetention api={desktop} db={db} disabled={busy} onApplyLocal={(policy) => {
      const cutoff = policy.historyDays ? Date.now() - policy.historyDays * 86400000 : -Infinity;
      setDb((old) => pruneHistory({
        ...old,
        settings: { ...old.settings, ...policy },
        history: old.history.filter((item) => Date.parse(item.time) >= cutoff),
      }));
    }} />
  );
  const configurationBackup = (
    <Card className="help-settings-section">
      <div className="help-section-row">
        <div>
          <h2>配置备份</h2>
          <p className="muted">导出服务、服务器和目标配置，认证口令和本机偏好单独保存。</p>
        </div>
        <div className="row wrap">
          <Button variant="neutral" size="compact" onClick={onExport}><Download size={16} />导出配置</Button>
          <Button variant="neutral" size="compact" onClick={onImport} disabled={busy}><Upload size={16} />导入配置</Button>
        </div>
      </div>
    </Card>
  );
  const sections = [
    {
      id: 'general',
      label: settingsLabels.general,
      content: (
        <div className="stack">
          <Card title="外观" className="preference-list">
            <PreferenceChoice
              label="界面主题"
              value={db.settings.theme}
              onValueChange={(theme) => setDb((old) => ({ ...old, settings: { ...old.settings, theme } }))}
              items={[
                { value: 'system', label: '跟随系统' },
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
              ]}
            />
            <PreferenceChoice
              label="界面密度"
              value={density}
              onValueChange={onDensity}
              items={[
                { value: 'compact', label: '紧凑' },
                { value: 'comfortable', label: '舒适' },
              ]}
            />
            {desktop && (
              <PreferenceChoice
                label="界面缩放"
                value={preferences.zoom}
                disabled={saving}
                onValueChange={(zoom) => void changePreferences({ zoom })}
                items={zoomOptions.map((zoom) => ({ value: zoom, label: zoom + '%' }))}
              />
            )}
          </Card>
          {desktop && (
            <Card title="侧栏" className="preference-list">
              <Switch label="按最近部署时间排序"
                description="最近部署的服务排在左侧列表最上方。手动调整顺序后自动关闭。"
                checked={preferences.sortSidebarByDeployment} disabled={saving}
                onChange={(sortSidebarByDeployment) => void changePreferences({ sortSidebarByDeployment })} />
            </Card>
          )}
          {desktop && (
            <Card title="窗口与启动" className="preference-list">
              <Switch label="记住窗口大小和位置" checked={preferences.rememberWindow} disabled={saving}
                onChange={(rememberWindow) => void changePreferences({ rememberWindow })} />
              <Switch label="开机启动" checked={preferences.launchAtLogin} disabled={saving}
                onChange={(launchAtLogin) => void changePreferences({ launchAtLogin })} />
              <Switch label="关闭时最小化到托盘" description="点击窗口关闭按钮后隐藏到系统托盘，部署和发布计划继续运行。"
                checked={preferences.closeToTray} disabled={saving}
                onChange={(closeToTray) => void changePreferences({ closeToTray })} />
            </Card>
          )}
          {desktop && (
            <Card title="任务与提醒" className="preference-list">
              <Switch label="任务日志默认跟随最新" checked={preferences.followLogs} disabled={saving}
                onChange={(followLogs) => void changePreferences({ followLogs })} />
              <Switch label="日志自动折行" description="随窗口宽度折行，部署、镜像和线上日志共用此设置。"
                checked={preferences.wrapLogs} disabled={saving}
                onChange={(wrapLogs) => void changePreferences({ wrapLogs })} />
              <Switch
                label="Windows 系统通知"
                checked={db.settings.notifications !== false}
                onChange={(notifications) =>
                  setDb((old) => ({
                    ...old,
                    settings: { ...old.settings, notifications },
                  }))
                }
                description="窗口在后台时，任务完成或失败会提醒，点击通知回到任务。"
              />
              <Switch
                label="通知提示音"
                checked={db.settings.notificationSound !== false}
                onChange={(notificationSound) =>
                  setDb((old) => ({
                    ...old,
                    settings: { ...old.settings, notificationSound },
                  }))
                }
              />
            </Card>
          )}
          {preferenceError && <p className="notice warning" role="alert">{preferenceError}</p>}
          {showDemo && (
            <Demo>
              <Switch
                label="演示模式"
                description="显示虚线边框中的演示产物和故障注入控件"
                checked={db.settings.demoMode}
                onChange={(demoMode) =>
                  setDb((old) => ({ ...old, settings: { ...old.settings, demoMode } }))
                }
              />
            </Demo>
          )}
        </div>
      ),
    },
    {
      id: 'deploy',
      label: settingsLabels.deploy,
      description: '这里设置全局默认值，部署页仍可单次覆盖。',
      content: (
        <div className="stack">
          <Card title="部署默认行为" className="preference-list">
              <PreferenceChoice
                label="某个目标失败后"
                value={db.settings.failurePolicy}
                onValueChange={(failurePolicy) =>
                  setDb((old) => ({ ...old, settings: { ...old.settings, failurePolicy } }))
                }
                items={[
                  { value: 'stop', label: '停止后续目标' },
                  { value: 'continue', label: '继续其他目标' },
                ]}
              />
              <Field label="陈旧锁阈值（分钟）" hint={lockMinutesHint}>
                <input
                  type="number"
                  min={min}
                  max={max}
                  step={1}
                  value={lockMinutesValue}
                  aria-invalid={!validLockMinutes || undefined}
                  aria-description={lockMinutesHint}
                  onChange={(event) => setLockMinutesDraft(event.target.value)}
                  onBlur={commitLockMinutes}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitLockMinutes();
                    } else if (event.key === 'Escape' && lockMinutesDraft !== undefined) {
                      event.preventDefault();
                      setLockMinutesDraft(undefined);
                    }
                  }}
                />
              </Field>
          </Card>
          <Card title="构建兼容性" className="preference-list">
            <Switch
              label="兼容 Maven 异常非零退出码"
              description="仅当日志包含 BUILD SUCCESS、产物有效且修改时间晚于本次构建开始时间时允许；默认开启，可关闭"
              checked={db.settings.allowMavenNonzero}
              onChange={(v) =>
                setDb((old) => ({
                  ...old,
                  settings: { ...old.settings, allowMavenNonzero: v },
                }))
              }
            />
          </Card>
        </div>
      ),
    },
    {
      id: 'data',
      label: settingsLabels.data,
      description: '查看占用、管理数据位置及保留规则。清理与迁移均需明确确认。',
      content: desktop ? (
        <div className="stack data-storage-sections">
          <DataSettings
            section="usage"
            usageRef={usageRef}
            api={desktop}
            policy={db.settings.artifactPolicy}
            onPolicy={(policy) =>
              setDb((old) => ({
                ...old,
                settings: { ...old.settings, artifactPolicy: policy },
              }))
            }
          />
          <DirectorySettings
            api={desktop}
            beforeMigrate={() => desktop.save(db)}
            blocked={migrationBlock}
            onManage={scrollToUsage}
          />
          <DataSettings
            section="retention"
            historyFields={historyFields}
            api={desktop}
            policy={db.settings.artifactPolicy}
            onPolicy={(policy) =>
              setDb((old) => ({
                ...old,
                settings: { ...old.settings, artifactPolicy: policy },
              }))
            }
          />
          {configurationBackup}
        </div>
      ) : (
        <div className="stack">{historyFields}{configurationBackup}</div>
      ),
    },
    {
      id: 'update',
      label: settingsLabels.update,
      notification: updateAvailable ? '有可用的软件更新' : undefined,
      content: (
        <div className="stack">
          <AppUpdateSettings api={desktop} version={version} active={busy} />
          {desktop && <Card title="检查方式" className="preference-list">
            <Switch label="启动时检查更新" description="每次打开应用时检查新版本，并在设置入口显示提醒。"
              checked={preferences.checkUpdatesOnStartup} disabled={saving}
              onChange={(checkUpdatesOnStartup) => void changePreferences({ checkUpdatesOnStartup })} />
            <PreferenceChoice
              label="更新检查方式"
              hint="自动模式每 6 小时检查一次。启动检查关闭时，自动模式首次检查在启动 1 分钟后。"
              value={preferences.updatePolicy}
              disabled={saving}
              onValueChange={(updatePolicy) => void changePreferences({ updatePolicy })}
              items={[
                { value: 'manual', label: '手动检查' },
                { value: 'check', label: '自动检查' },
                { value: 'download', label: '自动检查并下载' },
              ]}
            />
            {preferenceError && <p className="notice warning" role="alert">{preferenceError}</p>}
          </Card>}
        </div>
      ),
    },
    {
      id: 'help',
      label: settingsLabels.help,
      content: (
        <div className="help-settings">
          {desktop && (
            <Card className="help-settings-section">
              <h2>帮助与项目</h2>
              <div className="help-resource-list">
                <button className="help-resource-row" onClick={onTutorial}>
                  <span className="help-resource-icon"><GraduationCap size={18} /></span>
                  <span className="help-resource-copy">
                    <strong>教学向导</strong>
                    <span>用五步完成配置和第一次部署</span>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
                <button
                  className="help-resource-row"
                  aria-label="使用说明"
                  onClick={() => void desktop.help()}
                >
                  <span className="help-resource-icon">
                    <BookOpen size={18} />
                  </span>
                  <span className="help-resource-copy">
                    <strong>使用说明</strong>
                    <span>配置、部署、回滚与常见问题</span>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
                <a
                  className="help-resource-row"
                  aria-label="查看版本与源码"
                  href="https://github.com/liwl1995/DeployCenter/releases"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span className="help-resource-icon">
                    <Code2 size={18} />
                  </span>
                  <span className="help-resource-copy">
                    <strong>版本与源码</strong>
                    <span>发布记录、安装包与项目源码</span>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </a>
                <button
                  className="help-resource-row"
                  aria-label="关于 YOTOO 部署中心"
                  onClick={() => void desktop.about()}
                >
                  <span className="help-resource-icon">
                    <Info size={18} />
                  </span>
                  <span className="help-resource-copy">
                    <strong>关于应用</strong>
                    <span>YOTOO 部署中心 · 本地部署工作台</span>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </div>
            </Card>
          )}
        </div>
      ),
    },
  ] satisfies { id: SettingsSection; label: string; description?: string; notification?: string; content: React.ReactNode }[];
  return (
    <WorkspaceTabs
      label="设置分类"
      value={section}
      onChange={(id) => {
        const next = sections.find((entry) => entry.id === id);
        if (next) onSection(next.id);
      }}
      navigationTarget="settings-directory"
      sections={sections}
    />
  );
}
