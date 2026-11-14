import { Moon, Monitor, Settings, Sun } from 'lucide-react';
import type { Database } from './model';
import { MoreMenu } from './EntityActions';

type Theme = Database['settings']['theme'];
const themes: { value: Theme; label: string }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
];
/** 顶栏快捷入口共用已有偏好，切换页面不会创建另一份主题状态。 */
export function HeaderActions({
  theme,
  onTheme,
  settingsActive,
  onSettings,
}: {
  theme: Theme;
  onTheme: (value: Theme) => void;
  settingsActive: boolean;
  onSettings: () => void;
}) {
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  const current = themes.find((item) => item.value === theme)!.label;
  return (
    <div className="header-actions" role="group" aria-label="外观与设置">
      <MoreMenu
        label={'切换外观（当前：' + current + '）'}
        iconOnly
        trigger={<Icon size={18} aria-hidden="true" />}
        actions={themes.map((item) => ({
          label: item.label,
          checked: item.value === theme,
          onClick: () => onTheme(item.value),
        }))}
      />
      <button
        type="button"
        className={'icon-button header-icon-button' + (settingsActive ? ' selected' : '')}
        aria-label="设置"
        title="设置"
        aria-current={settingsActive ? 'page' : undefined}
        onClick={onSettings}
      >
        <Settings size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
