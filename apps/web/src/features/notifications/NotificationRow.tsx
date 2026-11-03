import { Check, CircleArrowRight, Ellipsis, EyeOff, Trash2, Undo2 } from 'lucide-react';
import type { Notification } from '@/demo';
import {
  Badge,
  Button,
  DropdownMenu,
  IconButton,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  cn,
} from '@/design-system';
import { useGo } from '@/features/dashboard/links';
import { KINDS, SEVERITIES, entityTarget, fallbackTarget } from './event-kind';
import { eventTime } from './time';

export interface NotificationRowProps {
  notification: Notification;
  onMarkRead: (id: string) => void;
  onMarkUnread: (id: string) => void;
  onDelete: (id: string) => void;
  onMute: (notification: Notification) => void;
}

/**
 * One event: what happened, how important, which object it affects, when, and what to do next.
 *
 * Opening the related object marks the event read in the same gesture, because having looked at
 * the thing is what "read" means here. Columns collapse from the right as the viewport narrows;
 * the related object reappears inline under the description so it is never lost.
 */
export function NotificationRow({
  notification,
  onMarkRead,
  onMarkUnread,
  onDelete,
  onMute,
}: NotificationRowProps) {
  const go = useGo();
  const kind = KINDS[notification.kind];
  const severity = SEVERITIES[notification.severity];
  const KindIcon = kind.icon;
  const unread = notification.readAt === null;

  const target = entityTarget(notification.entity, notification.kind);
  const fallback = target ? null : fallbackTarget(notification.kind);
  const href = target?.href ?? fallback?.href ?? null;
  const actionLabel = target?.href ? target.action : (fallback?.action ?? '');

  const open = () => {
    if (!href) return;
    if (unread) onMarkRead(notification.id);
    go(href);
  };

  const relatedObject = target ? (
    <span className="flex flex-col gap-0.5">
      <span className="eyebrow">{target.typeLabel}</span>
      {target.href ? (
        <button
          type="button"
          onClick={open}
          className="rounded-xs text-left text-sm font-medium text-primary-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {target.label}
        </button>
      ) : (
        <span className="text-sm font-medium text-secondary">{target.label}</span>
      )}
    </span>
  ) : null;

  return (
    <tr
      data-testid="notification-row"
      data-unread={unread || undefined}
      className={cn(
        'align-top transition-colors duration-(--duration-base)',
        // Below md the table layout squeezes Details to nothing, so the row becomes a stacked
        // card: type and time on one line, the event beneath, priority and action last.
        'max-md:flex max-md:flex-wrap max-md:items-start max-md:gap-x-3 max-md:border-b max-md:border-line-soft',
        unread ? 'bg-primary-soft/25' : 'bg-surface',
        'hover:bg-surface-hover',
      )}
    >
      {/* TYPE */}
      <th scope="row" className="px-4 py-3 text-left font-normal max-md:order-1 max-md:pb-1">
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-md [&_svg]:size-4',
              kind.tile,
            )}
          >
            <KindIcon />
          </span>
          <span className="hidden eyebrow lg:inline">
            {kind.label}
          </span>
        </span>
      </th>

      {/* DETAILS */}
      <td className="px-4 py-3 max-md:order-3 max-md:w-full max-md:pt-0">
        <span className="flex items-start gap-2">
          {unread ? (
            <span
              aria-hidden
              className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
              data-testid="unread-dot"
            />
          ) : null}
          <span className="min-w-0">
            <span
              className={cn(
                'block text-sm',
                unread ? 'font-semibold text-ink' : 'font-medium text-secondary',
              )}
            >
              {unread ? <span className="sr-only">Unread. </span> : null}
              {notification.title}
            </span>
            <span className="mt-0.5 block text-xs text-muted">{notification.body}</span>
            {/* Below xl the Related-to column is gone, so the object rides along here. */}
            {relatedObject ? <span className="mt-1.5 flex xl:hidden">{relatedObject}</span> : null}
          </span>
        </span>
      </td>

      {/* RELATED TO */}
      <td className="hidden px-4 py-3 xl:table-cell">
        {relatedObject ?? (
          <span className="text-sm text-faint">
            <span aria-hidden>—</span>
            <span className="sr-only">No related record</span>
          </span>
        )}
      </td>

      {/* TIME */}
      <td className="px-4 py-3 text-xs whitespace-nowrap text-muted max-md:order-2 max-md:ml-auto max-md:pb-1">
        <time dateTime={notification.at}>{eventTime(notification.at)}</time>
      </td>

      {/* PRIORITY */}
      <td className="px-4 py-3 max-md:order-4 max-md:pt-0">
        <span className="flex flex-col items-start gap-1">
          <Badge tone={severity.tone} size="sm">
            {severity.label}
          </Badge>
          {notification.actionRequired ? (
            <span className="text-2xs font-medium whitespace-nowrap text-warning-text">
              Action required
            </span>
          ) : null}
        </span>
      </td>

      {/* ACTION */}
      <td className="px-4 py-3 max-md:order-5 max-md:ml-auto max-md:pt-0">
        <span className="flex items-center justify-end gap-1">
          {href ? (
            <Button
              variant="ghost"
              size="sm"
              iconRight={<CircleArrowRight />}
              onClick={open}
              className="whitespace-nowrap text-primary-text"
            >
              {actionLabel}
            </Button>
          ) : null}
          <DropdownMenu
            align="end"
            trigger={
              <IconButton label={`Actions for ${notification.title}`} variant="ghost" size="sm">
                <Ellipsis />
              </IconButton>
            }
          >
            <MenuLabel>{kind.label} event</MenuLabel>
            {href ? (
              <MenuItem icon={<CircleArrowRight />} onSelect={open}>
                {actionLabel}
              </MenuItem>
            ) : null}
            {unread ? (
              <MenuItem icon={<Check />} onSelect={() => onMarkRead(notification.id)}>
                Mark as read
              </MenuItem>
            ) : (
              <MenuItem icon={<Undo2 />} onSelect={() => onMarkUnread(notification.id)}>
                Mark as unread
              </MenuItem>
            )}
            <MenuItem icon={<EyeOff />} onSelect={() => onMute(notification)}>
              Mute {kind.label.toLowerCase()} notifications
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 />} destructive onSelect={() => onDelete(notification.id)}>
              Delete notification
            </MenuItem>
          </DropdownMenu>
        </span>
      </td>
    </tr>
  );
}
