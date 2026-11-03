import { ArrowLeft } from 'lucide-react';
import { useCanGoBack, useRouter } from '@tanstack/react-router';
import { cn } from '../../lib/cn';

/**
 * Back.
 *
 * The product used to have no back control at all: the first breadcrumb doubled as one, which is
 * why it read as the name of the destination ("< Loads") instead of an action, and why it was
 * slow. A crumb is a `<Link to>`, so pressing it was a *forward* navigation to the list route —
 * remounting that page and re-running its whole data bundle before anything appeared. Popping
 * history instead reuses the page and the cache that is already there.
 *
 * `fallback` is where to go when there is no history to pop: opening a detail page from a pasted
 * URL or a notification leaves nothing behind it, and a browser back would then leave the
 * application entirely.
 */
export function BackButton({
  fallback,
  label = 'Back',
  className,
}: {
  /** Parent route to use when this page was opened directly. */
  fallback: string;
  /** Visible text. Keep it "Back" unless there is a strong reason not to. */
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const canGoBack = useCanGoBack();

  return (
    <button
      type="button"
      title="Back"
      aria-label="Back"
      onClick={() => {
        // Navigate first and let data catch up: waiting on a query before moving is what made
        // this feel like it had hung.
        if (canGoBack) router.history.back();
        else void router.navigate({ href: fallback, replace: true });
      }}
      className={cn(
        'inline-flex h-7 w-fit cursor-pointer items-center gap-1.5 rounded-md px-2 -ml-2 text-sm font-semibold text-nw-text-2',
        'transition-colors duration-(--duration-fast) hover:bg-nw-hover hover:text-nw-text',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        '[&_svg]:size-4 [&_svg]:text-nw-text-3',
        className,
      )}
    >
      <ArrowLeft aria-hidden />
      {label}
    </button>
  );
}
