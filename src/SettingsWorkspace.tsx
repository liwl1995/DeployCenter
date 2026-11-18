import { Button } from './design/ui/button';
import { useRef, type Dispatch, type SetStateAction } from 'react';
import { BookOpen, ChevronRight, Code2, Download, Info, Upload } from 'lucide-react';
import { AppUpdateSettings } from './AppUpdateSettings';
import { DataSettings } from './DataSettings';
import { DirectorySettings } from './DirectorySettings';
import { SegmentedControl } from './design/ui/segmented-control';
import type { Database } from './model';
import type { DesktopAPI } from './platform';
import { pruneHistory } from './records';
import { Card, Demo, Field, Switch } from './ui';
import { WorkspaceTabs } from './WorkspaceLayout';

type Density = 'compact' | 'comfortable';

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
  showDemo,
  onImport,
  onExport,
}: {
  desktop?: DesktopAPI;
  db: Database;
  setDb: Dispatch<SetStateAction<Database>>;
  section: string;
  onSection: (section: string) => void;
  density: Density;
  onDensity: (density: Density) => void;
  migrationBlock?: string;
  busy: boolean;
  version: string;
  showDemo?: boolean;
  onImport: () => void;
  onExport: () => void;
}) {
  const usageRef = useRef<HTMLDListElement>(null);
  const scrollToUsage = () =>
    usageRef.current?.scrollIntoView({
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
      block: 'center',
    });
  const historyFields = (
    <div className="retention-history">
      <h3>部署历史</h3>
      <div className="settings-fields">
        <Field
          label="历史保留条数"
          hint="按目标记录计数（1–10000），同时清理不再引用的本机任务日志和产物；远程备份不会删除"
        >
          <input
            type="number"
            min="1"
            max="10000"
            value={db.settings.historyLimit}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isInteger(value) && value >= 1 && value <= 10000)
                setDb((old) =>
                  pruneHistory({
                    ...old,
                    settings: { ...old.settings, historyLimit: value },
                  }),
                );
            }}
          />
        </Field>
        <Field label="历史保留天数（0 为不按天清理）">
          <input
            type="number"
            min="0"
            max="3650"
            value={db.settings.historyDays ?? 90}
            onChange={(e) =>
              setDb((old) => ({
                ...old,
                settings: {
                  ...old.settings,
                  historyDays: Math.max(0, Math.min(3650, Number(e.target.value))),
                },
              }))
            }
          />
        </Field>
      </div>
    </div>
  );
  const sections = [
    {
      id: 'general',
      label: '外观与提醒',
      description: '界面偏好和后台任务提醒，修改后自动保存。',
      content: (
        <div className="stack">
          <Card title="界面外观">
            <Field label="界面主题">
              <select
                value={db.settings.theme}
                onChange={(e) =>
                  setDb((old) => ({
                    ...old,
                    settings: {
                      ...old.settings,
                      theme: e.target.value as Database['settings']['theme'],
                    },
                  }))
                }
              >
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </Field>
          </Card>
          <Card title="界面密度">
            <SegmentedControl
              size="sm"
              aria-label="界面密度"
              value={density}
              onValueChange={onDensity}
              items={[
                { value: 'compact', label: '紧凑' },
                { value: 'comfortable', label: '舒适' },
              ]}
            />
          </Card>
          {desktop && (
            <Card title="后台提醒">
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
      label: '部署与构建',
      description: '这里设置全局默认值，部署页仍可单次覆盖。',
      content: (
        <div className="stack">
          <Card title="部署默认行为">
            <div className="settings-fields">
              <Field label="某个目标失败后">
                <select
                  value={db.settings.failurePolicy}
                  onChange={(e) =>
                    setDb((old) => ({
                      ...old,
                      settings: {
                        ...old.settings,
                        failurePolicy: e.target.value as Database['settings']['failurePolicy'],
                      },
                    }))
                  }
                >
                  <option value="stop">停止后续目标</option>
                  <option value="continue">继续其他目标</option>
                </select>
              </Field>
              <Field label="陈旧锁阈值（分钟）">
                <input
                  type="number"
                  min="1"
                  max="10080"
                  value={db.settings.staleLockMinutes ?? 120}
                  onChange={(e) =>
                    setDb((old) => ({
                      ...old,
                      settings: {
                        ...old.settings,
                        staleLockMinutes: Math.max(1, Number(e.target.value)),
                      },
                    }))
                  }
                />
              </Field>
            </div>
          </Card>
          <Card title="构建兼容性">
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
      label: '数据与存储',
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
        </div>
      ) : (
        historyFields
      ),
    },
    {
      id: 'help',
      label: '配置与帮助',
      description: '检查软件更新、备份配置或查看使用说明。',
      content: (
        <div className="help-settings">
          {desktop && <AppUpdateSettings api={desktop} version={version} active={busy} />}
          <Card className="help-settings-section">
            <div className="help-section-row">
              <div>
                <h2>配置备份</h2>
                <p className="muted">
                  导出服务、服务器和目标配置，不包含认证口令；完整日志单独保存。
                </p>
              </div>
              <div className="row wrap">
                <Button variant="neutral" size="compact" onClick={() => onExport()}>
                  <Download size={16} />
                  导出配置
                </Button>
                <Button variant="neutral" size="compact" onClick={onImport} disabled={busy}>
                  <Upload size={16} />
                  导入配置
                </Button>
              </div>
            </div>
          </Card>
          {desktop && (
            <Card className="help-settings-section">
              <h2>帮助与项目</h2>
              <div className="help-resource-list">
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
  ];
  return (
    <WorkspaceTabs
      label="设置分类"
      value={section}
      onChange={onSection}
      navigationTarget="settings-directory"
      sections={sections}
    />
  );
}
