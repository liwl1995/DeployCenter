import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

const NO_DRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

interface AppPageHeaderProps {
  /** 标题前的可操作元素（二级页的返回按钮）；和 icon 二选一 */
  leading?: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
  /** 应用页的页面名（如「供应商」），灰字跟在应用名后面 */
  subtitle?: ReactNode;
  /** 标题后面的「?」、Beta 徽标、计数等 */
  titleExtra?: ReactNode;
  /** 右侧操作区：主按钮放最后一个、⋯ 放它后面 */
  actions?: ReactNode;
  /** 标题可能很长（如会话阅读页的会话名）：标题占满剩余宽度，放不下就截断 */
  truncateTitle?: boolean;
  className?: string;
}

/**
 * 内容区页头：高 52，整条可拖动窗口，左边是图标 + 标题，右边是操作。
 */
export function AppPageHeader({
  leading,
  icon,
  title,
  subtitle,
  titleExtra,
  actions,
  truncateTitle = false,
  className,
}: AppPageHeaderProps) {
  return (
    <header
      className={cn(
        'flex h-[52px] shrink-0 items-center gap-5 border-b border-border pe-4 ps-6',
        className,
      )}
    >
      <div className={cn('flex min-w-0 items-center gap-2', truncateTitle ? 'flex-1' : 'shrink-0')}>
        {leading && (
          <span className="-ms-2 flex shrink-0 items-center" style={NO_DRAG}>
            {leading}
          </span>
        )}
        {icon && (
          <span
            aria-hidden="true"
            className="pointer-events-none flex h-[22px] w-[22px] shrink-0 items-center justify-center text-fg-1"
          >
            {icon}
          </span>
        )}
        <h1
          className={cn('m-0 whitespace-nowrap', 'text-page', truncateTitle && 'min-w-0 truncate')}
        >
          {title}
        </h1>
        {(subtitle || titleExtra) && (
          <div className="flex min-w-0 items-center gap-1" style={NO_DRAG}>
            {subtitle && <span className="whitespace-nowrap text-body text-fg-3">{subtitle}</span>}
            {titleExtra}
          </div>
        )}
      </div>
      {!truncateTitle && <div className="flex-1" />}
      {actions && (
        <div className="flex min-w-0 shrink items-center justify-end gap-2" style={NO_DRAG}>
          {actions}
        </div>
      )}
    </header>
  );
}
