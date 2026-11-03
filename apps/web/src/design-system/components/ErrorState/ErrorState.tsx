import { RefreshCw } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { StatusSymbol } from '../Badge/StatusSymbol';
import { Button } from '../Button';
import { cn } from '../../lib/cn';

export interface ErrorStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  /** Technical detail; shown in a collapsible block in development builds only. */
  error?: unknown;
  size?: 'sm' | 'md';
}

/** Human-readable failure with a retry. Technical detail only in development. */
export function ErrorState({
  title = 'Something went wrong',
  description = 'We could not load this data. Try again in a moment.',
  onRetry,
  retrying = false,
  error,
  size = 'md',
  className,
  ...rest
}: ErrorStateProps) {
  const detail = import.meta.env.DEV ? describeError(error) : null;
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'md' ? 'px-6 py-12' : 'px-4 py-8',
        className,
      )}
      {...rest}
    >
      <div
        aria-hidden
        className={cn(
          'flex items-center justify-center rounded-lg border border-nw-urgent-border bg-nw-urgent-bg text-nw-urgent-icon',
          size === 'md' ? 'size-10' : 'size-8',
        )}
      >
        <StatusSymbol family="urgent" size={size === 'md' ? 20 : 16} />
      </div>
      <h3 className={cn('mt-3 font-bold text-nw-text', size === 'md' ? 'text-md' : 'text-sm')}>
        {title}
      </h3>
      <p className="mt-1 max-w-sm text-sm text-nw-text-2">{description}</p>
      {onRetry ? (
        <Button
          className="mt-4"
          variant="secondary"
          icon={<RefreshCw />}
          onClick={onRetry}
          loading={retrying}
        >
          Try again
        </Button>
      ) : null}
      {detail ? (
        <details className="mt-4 w-full max-w-lg text-left">
          <summary className="cursor-pointer text-xs text-nw-text-3">
            Technical details (development)
          </summary>
          <pre className="scroll-quiet mt-2 max-h-48 overflow-auto rounded-md border border-nw-border bg-nw-subtle p-3 text-2xs text-nw-text-2">
            {detail}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function describeError(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ''}`.trim();
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}
