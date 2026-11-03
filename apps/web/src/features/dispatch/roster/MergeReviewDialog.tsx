import { useQuery } from '@tanstack/react-query';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { MergeChoice, MergePreview } from '@neway/shared';
import { Button, Modal, StatusSymbol, cn } from '@/design-system';
import { apiGet } from '@/lib/api-client';

/**
 * What a merge will do, before it does it.
 *
 * Two board rows about one person hold two versions of the day. Anywhere they agree the value
 * simply moves; anywhere they disagree this dialog shows both, says who typed each and when, and
 * asks. Nothing is resolved by which row was written last - a load number taken from the wrong
 * row is a driver sent to the wrong freight, and the clock is not evidence about that.
 */
export function MergeReviewDialog({
  rosterId,
  driverId,
  driverName,
  open,
  onCancel,
  onConfirm,
  saving,
}: {
  rosterId: string;
  driverId: string;
  driverName: string;
  open: boolean;
  onCancel: () => void;
  onConfirm: (resolutions: Record<string, MergeChoice>) => void;
  saving: boolean;
}) {
  const [choices, setChoices] = useState<Record<string, MergeChoice>>({});

  const preview = useQuery({
    queryKey: ['dispatch', 'merge-preview', rosterId, driverId],
    queryFn: () => apiGet<MergePreview>(`/dispatch/roster/${rosterId}/merge-preview`, { driverId }),
    enabled: open,
  });

  useEffect(() => {
    // A fresh dialog starts with nothing chosen: a person answers every disagreement themselves.
    if (open) setChoices({});
  }, [open, rosterId, driverId]);

  const data = preview.data;
  const unanswered = (data?.conflicts ?? []).filter((c) => !choices[c.key]);

  return (
    <Modal open={open} onOpenChange={(next) => !next && onCancel()} title={`Merge with ${driverName}`} size="lg">
      {preview.isPending ? (
        <p className="text-sm text-nw-text-3">Reading both rows…</p>
      ) : preview.isError ? (
        <p className="text-sm text-nw-urgent-text">That preview could not be read. Nothing has been changed.</p>
      ) : !data ? null : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <RowCard title="Keeps its place" subtitle={`${driverName}'s board row`} row={data.into} tone="keep" />
            <RowCard title="Is retired into it" subtitle="the imported sheet row" row={data.from} tone="take" />
          </div>

          <p className="text-[12.5px] text-nw-text-2">
            {data.movingCells} typed cell{data.movingCells === 1 ? '' : 's'} move across.{' '}
            {data.keptCells} stay{data.keptCells === 1 ? 's' : ''} on {driverName}'s row. The imported row is retired with
            the reason, never deleted.
          </p>

          {data.conflicts.length === 0 ? (
            <p className="rounded-md bg-nw-done-bg px-3 py-2 text-[12.5px] font-semibold text-nw-done-text">
              The two rows agree everywhere. Nothing to decide.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <h3 className="flex items-center gap-2 text-sm font-bold text-nw-text">
                <TriangleAlert className="size-4 text-nw-warning-icon" aria-hidden />
                {data.conflicts.length} place{data.conflicts.length === 1 ? '' : 's'} they disagree — choose each
              </h3>
              {data.conflicts.map((c) => (
                <div
                  key={c.key}
                  className={cn(
                    'rounded-md border px-3 py-2',
                    c.operational ? 'border-nw-urgent-text bg-nw-urgent-bg' : 'border-nw-border bg-nw-panel',
                  )}
                >
                  <div className="flex items-center gap-2 text-[12.5px] font-bold">
                    {c.operational ? (
                      <StatusSymbol family="urgent" size={12} className="text-nw-urgent-icon" />
                    ) : null}
                    <span className={c.operational ? 'text-nw-urgent-text' : 'text-nw-text'}>{c.label}</span>
                    {c.operational ? (
                      <span className="text-[11px] font-semibold text-nw-urgent-text">moves freight — read it twice</span>
                    ) : null}
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-2">
                    <Choice
                      selected={choices[c.key] === 'keep'}
                      onSelect={() => setChoices((s) => ({ ...s, [c.key]: 'keep' }))}
                      value={c.keepValue}
                      detail={c.keepDetail}
                      label="Keep"
                    />
                    <Choice
                      selected={choices[c.key] === 'take'}
                      onSelect={() => setChoices((s) => ({ ...s, [c.key]: 'take' }))}
                      value={c.takeValue}
                      detail={c.takeDetail}
                      label="Take the imported one"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-nw-border pt-3">
            <span className="mr-auto text-[11.5px] text-nw-text-3">
              Both values are written to the audit history, whichever you pick.
            </span>
            <Button variant="secondary" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
            <Button
              disabled={unanswered.length > 0 || saving}
              loading={saving}
              onClick={() => onConfirm(choices)}
              title={unanswered.length > 0 ? `Still to decide: ${unanswered.map((c) => c.label).join(', ')}` : undefined}
            >
              {unanswered.length > 0 ? `${unanswered.length} still to decide` : 'Merge the rows'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function RowCard({
  title,
  subtitle,
  row,
  tone,
}: {
  title: string;
  subtitle: string;
  row: MergePreview['into'] | MergePreview['from'];
  tone: 'keep' | 'take';
}) {
  if (!row) return null;
  return (
    <div className={cn('rounded-md border px-3 py-2', tone === 'keep' ? 'border-nw-done-text bg-nw-done-bg' : 'border-nw-border bg-nw-subtle')}>
      <div className="flex items-center gap-1 text-[11px] font-bold tracking-[.04em] uppercase">
        {title}
        {tone === 'take' ? <ArrowRight className="size-3" aria-hidden /> : null}
      </div>
      <div className="text-[13px] font-bold text-nw-text uppercase">{row.name}</div>
      <div className="text-[11.5px] text-nw-text-3">{subtitle}</div>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 text-[11.5px]">
        <dt className="text-nw-text-3">Truck</dt>
        <dd className="text-nw-text">{row.truckUnit || '—'}</dd>
        <dt className="text-nw-text-3">Team</dt>
        <dd className="text-nw-text">{row.dispatcherName || '—'}</dd>
        <dt className="text-nw-text-3">Co-driver</dt>
        <dd className="text-nw-text">{row.coDriver || '—'}</dd>
        <dt className="text-nw-text-3">Phone</dt>
        <dd className="text-nw-text">{row.phone || '—'}</dd>
      </dl>
    </div>
  );
}

function Choice({
  selected,
  onSelect,
  value,
  detail,
  label,
}: {
  selected: boolean;
  onSelect: () => void;
  value: string | null;
  detail: string | null;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'rounded-md border px-2.5 py-1.5 text-left',
        selected ? 'border-nw-accent bg-nw-accent-tint' : 'border-nw-border bg-nw-panel hover:bg-nw-hover',
      )}
    >
      <span className="block text-[10.5px] font-bold tracking-[.04em] text-nw-text-3 uppercase">{label}</span>
      <span className="block truncate text-[13px] font-semibold text-nw-text">{value || '(empty)'}</span>
      {detail ? <span className="block truncate text-[11px] text-nw-text-3">{detail}</span> : null}
    </button>
  );
}
