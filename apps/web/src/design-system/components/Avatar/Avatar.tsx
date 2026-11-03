import { useState, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { getInitials } from './initials';

export type AvatarSize = 'sm' | 'md' | 'lg';

export interface AvatarProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** Full name; used for the initials fallback, the tooltip and the accessible name. */
  name: string;
  src?: string;
  /** sm 24px · md 32px · lg 40px */
  size?: AvatarSize;
}

const sizes: Record<AvatarSize, string> = {
  sm: 'size-6 text-2xs',
  md: 'size-8 text-xs',
  lg: 'size-10 text-sm',
};

/** Round avatar with an initials fallback on the accent tint (SPEC §7: tint and ink). */
export function Avatar({ name, src, size = 'md', className, ...rest }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src) && !failed;
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-nw-accent-tint font-semibold text-nw-accent-ink select-none',
        sizes[size],
        className,
      )}
      {...rest}
    >
      {showImage ? (
        <img src={src} alt="" className="size-full object-cover" onError={() => setFailed(true)} />
      ) : (
        getInitials(name)
      )}
    </span>
  );
}
