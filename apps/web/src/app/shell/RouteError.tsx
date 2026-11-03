import { useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { ErrorState } from '@/design-system';

/** Route error boundary content: human message, retry re-runs loaders and resets the boundary. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <div className="rounded-lg border border-line bg-surface shadow-xs">
      <ErrorState
        title="Unable to load this page"
        description="Something went wrong while loading. Try again, or pick another page from the sidebar."
        error={error}
        onRetry={() => {
          void router.invalidate();
          reset();
        }}
      />
    </div>
  );
}
