import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/utils';

type Variant = 'default' | 'neutral' | 'quiet' | 'ghost' | 'link' | 'danger';
type Size = 'compact' | 'regular' | 'icon-compact';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variants: Record<Variant, string> = {
  default: 'button primary',
  neutral: 'button',
  quiet: 'button button-quiet',
  ghost: 'button button-quiet',
  link: 'link',
  danger: 'button danger',
};

/** 普通操作共享主次样式，复合控件可保留专用布局和键盘语义。 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'regular', ...props }, ref) => (
    <button
      className={cn(
        size === 'icon-compact' ? 'icon-button' : variants[variant],
        size === 'regular' && 'button-regular',
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
