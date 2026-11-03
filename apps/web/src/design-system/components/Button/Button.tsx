import { Slot } from 'radix-ui';
import { LoaderCircle } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon rendered before the label (16px Lucide icon). */
  icon?: ReactNode;
  /** Icon rendered after the label. */
  iconRight?: ReactNode;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  /** Render the child element instead of a <button>, passing styles down (for links). */
  asChild?: boolean;
  fullWidth?: boolean;
}

/* Porcelain buttons: 32px, radius 8, 13/600. Focus is the global 2px accent outline (tokens.css). */
const base =
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-semibold leading-none ' +
  'transition-colors duration-(--duration-base) ease-(--ease-standard) select-none ' +
  'disabled:pointer-events-none disabled:opacity-45';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-nw-accent text-nw-on-accent hover:bg-nw-accent-hover active:bg-nw-accent-hover',
  secondary:
    'bg-nw-panel text-nw-text ring-1 ring-inset ring-nw-border-strong hover:bg-nw-hover active:bg-nw-selected',
  outline:
    'bg-nw-panel text-nw-accent-ink ring-1 ring-inset ring-nw-accent hover:bg-nw-accent-tint active:bg-nw-accent-tint',
  ghost: 'bg-transparent text-nw-text-2 hover:bg-nw-hover hover:text-nw-text active:bg-nw-selected',
  danger: 'bg-nw-danger text-nw-on-danger hover:bg-nw-danger-hover',
  link: 'bg-transparent text-nw-accent-ink hover:underline underline-offset-4 px-0 h-auto',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-(--control-height-sm) rounded-[7px] px-2.5 text-xs [&_svg]:size-3.5',
  md: 'h-(--control-height-md) px-3 text-sm [&_svg]:size-4',
  lg: 'h-(--control-height-lg) px-4 text-sm [&_svg]:size-4',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon,
    iconRight,
    loading = false,
    asChild = false,
    fullWidth = false,
    className,
    children,
    disabled,
    type,
    ...rest
  },
  ref,
) {
  const Comp = asChild ? Slot.Root : 'button';
  const classes = cn(
    base,
    variants[variant],
    variant !== 'link' && sizes[size],
    fullWidth && 'w-full',
    className,
  );

  if (asChild) {
    return (
      <Comp ref={ref} className={classes} {...rest}>
        {children}
      </Comp>
    );
  }

  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <LoaderCircle className="animate-spin" aria-hidden /> : icon}
      {children}
      {!loading && iconRight}
    </button>
  );
});
