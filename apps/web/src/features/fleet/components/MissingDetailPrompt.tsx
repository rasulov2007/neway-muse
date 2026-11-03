import { Button, StatusSymbol } from '@/design-system';

export interface MissingDetailPromptProps {
  /** One line: what is missing and what it unlocks — "Add the in-service date to start PM scheduling". */
  message: string;
  /** The button's label, normally "Add …". */
  actionLabel: string;
  onAction: () => void;
  className?: string;
}

/**
 * A unit exists before every detail about it does.
 *
 * Where a later feature needs a field the unit was created without — PM scheduling needs the
 * in-service date, registration needs the plate — the unit's page asks for it here instead of the
 * Add form having demanded it. A Porcelain notice: the info symbol, one line, one action. It is a
 * notice, not a status, so it carries the `info` family and no colour of its own.
 */
export function MissingDetailPrompt({
  message,
  actionLabel,
  onAction,
  className,
}: MissingDetailPromptProps) {
  return (
    <div
      role="note"
      className={[
        'flex flex-wrap items-center gap-3 rounded-[10px] border border-line bg-surface px-4 py-3',
        className ?? '',
      ]
        .join(' ')
        .trim()}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink">
        <StatusSymbol family="info" className="text-nw-info-icon" />
        <span>{message}</span>
      </span>
      <Button type="button" variant="secondary" size="sm" onClick={onAction}>
        {actionLabel}
      </Button>
    </div>
  );
}
