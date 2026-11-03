import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { StatusSymbol, cn } from '@/design-system';

/** A labelled field as the sheets draw it: bold label, red star, small grey hint on the right. */
export function Field({
  label,
  required,
  optional,
  small,
  children,
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  small?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs font-bold text-nw-text-2">
        <span>
          {label} {required ? <em className="text-nw-urgent-text not-italic">*</em> : null}
          {optional ? <span className="font-semibold text-nw-text-3">· optional</span> : null}
        </span>
        {small ? <small className="font-semibold text-nw-text-3">{small}</small> : null}
      </div>
      {children}
    </div>
  );
}

/** A checklist row: box, bold label, small note. `locked` rows are always on. */
export function CheckRow({
  on,
  locked,
  label,
  sub,
  onToggle,
}: {
  on: boolean;
  locked?: boolean;
  label: string;
  sub?: string;
  onToggle?: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-disabled={locked}
      onClick={locked ? undefined : onToggle}
      className={cn(
        'grid grid-cols-[16px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-0.5 rounded-[9px] bg-nw-field px-[11px] py-2 text-left ring-1 ring-nw-border-strong ring-inset',
        locked && 'cursor-default',
      )}
    >
      <span
        className={cn(
          'row-span-2 mt-px grid size-4 place-items-center self-start rounded-xs bg-nw-field ring-[1.5px] ring-nw-border-strong ring-inset',
          on && 'bg-nw-accent text-nw-on-accent ring-nw-accent',
        )}
      >
        {on ? <Check className="size-3" aria-hidden /> : null}
      </span>
      <b className="text-[13px] text-nw-text">{label}</b>
      {sub ? <span className="text-[11.5px] text-nw-text-3">{sub}</span> : null}
    </button>
  );
}

/** One line of the "When you save" box: a status symbol, the sentence, a small explanation. */
export function AutoLine({
  family,
  children,
}: {
  family: 'moving' | 'urgent' | 'info' | 'done' | 'warning';
  children: ReactNode;
}) {
  const colour = {
    moving: 'text-nw-moving-icon',
    urgent: 'text-nw-urgent-icon',
    info: 'text-nw-neutral-icon',
    done: 'text-nw-done-icon',
    warning: 'text-nw-warning-icon',
  }[family];
  return (
    <div className="grid grid-cols-[16px_1fr] gap-2.5 border-t border-nw-border px-3 py-2 text-[12.5px] leading-[1.4] text-nw-text [&_small]:block [&_small]:text-[11.5px] [&_small]:text-nw-text-3">
      <StatusSymbol family={family} size={14} className={cn('mt-0.5', colour)} />
      <span>{children}</span>
    </div>
  );
}

/** The header of the "When you save" box. */
export function AutoBox({ children }: { children: ReactNode }) {
  return (
    <div className="grid overflow-hidden rounded-[10px] bg-nw-subtle ring-1 ring-nw-border ring-inset">
      <div className="flex justify-between border-b border-nw-border px-3 py-2 text-[11px] font-bold tracking-[.06em] text-nw-text-3 uppercase">
        <span>When you save</span>
        <span>Automatic</span>
      </div>
      {children}
    </div>
  );
}
