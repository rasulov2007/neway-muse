import { Copy, Plus } from 'lucide-react';
import { Button } from '@/design-system';
import { longDateTime } from '../recruit-format';
import { Pill } from './JourneyKit';

/**
 * A private link in three moves (owner, 2026-10-12): Create link, Copy it to the driver, Mark as
 * sent. The address is shown only to the person who made it, so after a reload a live link asks
 * for a new one to be copied again (the old one stops working).
 */
export function SimpleLinkCard({
  title,
  url,
  live,
  sentAt,
  canManage,
  blockedReason,
  creating,
  marking,
  onCreate,
  onCopy,
  onMarkSent,
  testId,
}: {
  title: string;
  url: string | null;
  live: boolean;
  sentAt: string | null;
  canManage: boolean;
  /** Why no link can be made yet (for example, Safety has not approved). */
  blockedReason?: string | null;
  creating: boolean;
  marking: boolean;
  onCreate: () => void;
  onCopy: (url: string) => void;
  onMarkSent: () => void;
  testId: string;
}) {
  const placeholder = blockedReason ? blockedReason : live ? 'A link is out. Create a new link to copy it again.' : 'No link yet. Create one to send it.';
  return (
    <div className="flex flex-col gap-5 rounded-xl border border-nw-border p-6" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-base font-semibold text-nw-text">{title}</p>
        {canManage ? (
          <Button
            variant="outline"
            icon={<Plus />}
            loading={creating}
            disabled={Boolean(blockedReason)}
            title={live ? 'A new link stops the earlier one' : undefined}
            onClick={onCreate}
            data-testid={`${testId}-create`}
          >
            {live || url ? 'Create new link' : 'Create link'}
          </Button>
        ) : null}
      </div>
      <div className="flex min-h-12 items-center rounded-lg border border-nw-border bg-nw-subtle">
        <span className={url ? 'min-w-0 flex-1 truncate px-4 text-sm text-nw-text-2' : 'min-w-0 flex-1 px-4 py-2 text-sm text-nw-text-3'} data-testid={`${testId}-url`}>
          {url ?? placeholder}
        </span>
        <span className="h-7 w-px bg-nw-border" aria-hidden />
        <Button variant="ghost" icon={<Copy />} disabled={!url} onClick={() => url && onCopy(url)} className="mx-1 text-nw-accent-ink" data-testid={`${testId}-copy`}>
          Copy
        </Button>
      </div>
      <p className="-mt-2 text-sm text-nw-text-3">Copy the link and send it to the driver.</p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {sentAt ? (
          <Pill family="done" testId={`${testId}-status`}>
            Sent · {longDateTime(sentAt)}
          </Pill>
        ) : (
          <Pill family="neutral" testId={`${testId}-status`}>
            Not sent
          </Pill>
        )}
        {canManage ? (
          <Button variant="primary" loading={marking} disabled={!live || Boolean(sentAt)} title={!live ? 'Create a link first' : undefined} onClick={onMarkSent} data-testid={`${testId}-mark-sent`}>
            Mark as sent
          </Button>
        ) : null}
      </div>
    </div>
  );
}
