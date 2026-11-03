import { forwardRef, type ReactNode } from 'react';
import { Button, type ButtonProps, type ButtonSize } from '../Button';
import { cn } from '../../lib/cn';

export interface IconButtonProps extends Omit<
  ButtonProps,
  'icon' | 'iconRight' | 'children' | 'fullWidth'
> {
  /** Accessible name; also shown as a native tooltip. */
  label: string;
  /** The 16px Lucide icon. */
  children: ReactNode;
}

const square: Record<ButtonSize, string> = {
  sm: 'w-(--control-height-sm) px-0',
  md: 'w-(--control-height-md) px-0',
  lg: 'w-(--control-height-lg) px-0',
};

/** Square icon-only button. `label` is required so the control always has a name. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', variant = 'ghost', className, children, ...rest },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      aria-label={label}
      title={label}
      className={cn(square[size], className)}
      icon={children}
      {...rest}
    />
  );
});
