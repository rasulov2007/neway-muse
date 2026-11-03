import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, Link2, RefreshCw, TriangleAlert, UserPlus } from 'lucide-react';
import { useState } from 'react';
import type { MatchCandidate, MergeChoice, RosterMatchReport, RowMatchView } from '@neway/shared';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  StatusSymbol,
  cn,
  useToast,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet, apiPost } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { BoardNav } from '../board/chrome';
import { MergeReviewDialog } from './MergeReviewDialog';

/**
 * Matching board rows to driver files.
 *
 * The board came from the company's sheet, so a row is a name and a truck number; a row only
 * sees loads once it carries a driver file. This screen suggests which file a row is about and
 * applies exactly one match at a time, when a person says so. Nothing on it is automatic, and a
 * row with two plausible candidates offers neither.
 */
export function RosterMatchPage() {
  const account = useAccount();
  const canManage = account?.permissions.includes('dispatch.manage') ?? false;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState<Record<string, string>>({});
  /** The merge a person is reviewing: the dialog reads both rows and asks about every difference. */
  const [reviewing, setReviewing] = useState<{ rowId: string; driverId: string; driverName: string; version: number } | null>(null);

  const report = useQuery({
    queryKey: ['dispatch', 'roster-match'],
    queryFn: () => apiGet<RosterMatchReport>('/dispatch/roster/match'),
    enabled: canManage,
  });

  const link = useMutation({
    mutationFn: (input: { rowId: string; driverId: string; merge: boolean; version: number; resolutions?: Record<string, MergeChoice> }) =>
      apiPost<{ movedCells: number; retiredRowId: string | null }>(`/dispatch/roster/${input.rowId}/link`, {
        driverId: input.driverId,
        expectedVersion: input.version,
        mergeAcknowledged: input.merge,
        resolutions: input.resolutions ?? {},
      }),
    onSuccess: async (result) => {
      toast({
        tone: 'success',
        title: 'Matched',
        description: result.retiredRowId
          ? `Two board rows merged${result.movedCells > 0 ? `, ${result.movedCells} typed cell${result.movedCells === 1 ? '' : 's'} moved` : ''}.`
          : 'The row now carries the driver file and will show their loads.',
      });
      setReviewing(null);
      await queryClient.invalidateQueries({ queryKey: ['dispatch'] });
    },
    onError: (e: unknown) => {
      toast({
        tone: 'danger',
        title: 'Not matched',
        description: e instanceof Error ? e.message : 'Nothing was changed. Try again.',
      });
    },
  });

  if (!canManage) {
    return (
      <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
        <BoardNav current="/dispatch/roster-match" />
        <PageHeader title="Match board rows to drivers" />
        <EmptyState title="You cannot change the roster" description="Matching a board row to a driver file takes the dispatch.manage permission." />
      </div>
    );
  }

  const data = report.data;

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <BoardNav current="/dispatch/roster-match" />
      <PageHeader
        title="Match board rows to drivers"
        description="A board row sees loads only when it carries a driver file. Confirm one row at a time; nothing is matched automatically."
        actions={
          <Button variant="secondary" size="sm" icon={<RefreshCw />} loading={report.isFetching} onClick={() => void report.refetch()}>
            Refresh
          </Button>
        }
      />

      {report.isError ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : report.isPending ? (
        <Card className="p-6 text-sm text-nw-text-3">Loading…</Card>
      ) : !data ? null : (
        <>
          <div className="flex flex-wrap gap-3">
            <Tile label="Rows with no driver file" value={data.unlinkedCount} tone={data.unlinkedCount > 0 ? 'warning' : 'done'} />
            <Tile label="Rows already linked" value={data.linkedCount} tone="done" />
            <Tile label="Driver files on the company" value={data.driverFileCount} tone="info" />
          </div>

          {data.driverFileCount <= data.linkedCount && data.unlinkedCount > 0 ? (
            <Card className="border-nw-warning-text bg-nw-warning-bg p-4">
              <h2 className="flex items-center gap-2 text-sm font-bold text-nw-warning-text">
                <StatusSymbol family="warning" size={14} className="text-nw-warning-icon" />
                Every driver file already has a board row
              </h2>
              <p className="mt-1 text-xs font-semibold text-nw-warning-text">
                The {data.unlinkedCount} rows below are people the sheet ran who have no driver file at all, so there is
                nothing to match them to. They keep working as board-only rows. To put them on loads, create their driver
                file in <Link to="/drivers" className="underline">Drivers</Link> — the real form, with CDL and medical
                dates — and this screen will then offer the match.
              </p>
            </Card>
          ) : null}

          {data.rows.length === 0 ? (
            <EmptyState title="Every row carries a driver file" description="Nothing to match. Loads will show on every board row." />
          ) : (
            <div className="flex flex-col gap-3">
              {data.rows.map((row) => (
                <RowCard
                  key={row.row.id}
                  row={row}
                  chosen={chosen[row.row.id] ?? null}
                  onChoose={(driverId) => setChosen((s) => ({ ...s, [row.row.id]: driverId }))}
                  onConfirm={(candidate) =>
                    candidate.hasRosterRow
                      ? setReviewing({
                          rowId: row.row.id,
                          driverId: candidate.driverId,
                          driverName: candidate.driverName,
                          version: row.row.version,
                        })
                      : link.mutate({ rowId: row.row.id, driverId: candidate.driverId, merge: false, version: row.row.version })
                  }
                  saving={link.isPending}
                />
              ))}
            </div>
          )}
        </>
      )}

      {reviewing ? (
        <MergeReviewDialog
          open
          rosterId={reviewing.rowId}
          driverId={reviewing.driverId}
          driverName={reviewing.driverName}
          saving={link.isPending}
          onCancel={() => setReviewing(null)}
          onConfirm={(resolutions) =>
            link.mutate({
              rowId: reviewing.rowId,
              driverId: reviewing.driverId,
              merge: true,
              version: reviewing.version,
              resolutions,
            })
          }
        />
      ) : null}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone: 'warning' | 'done' | 'info' }) {
  const ring = {
    warning: 'border-nw-warning-text bg-nw-warning-bg text-nw-warning-text',
    done: 'border-nw-done-text bg-nw-done-bg text-nw-done-text',
    info: 'border-nw-info-text bg-nw-info-bg text-nw-info-text',
  }[tone];
  return (
    <div className={cn('min-w-[180px] flex-1 rounded-[10px] border px-4 py-3', ring)}>
      <div className="text-[11.5px] font-bold">{label}</div>
      <div className="tabular text-2xl font-extrabold">{value}</div>
    </div>
  );
}

function RowCard({
  row,
  chosen,
  onChoose,
  onConfirm,
  saving,
}: {
  row: RowMatchView;
  chosen: string | null;
  onChoose: (driverId: string) => void;
  onConfirm: (candidate: MatchCandidate) => void;
  saving: boolean;
}) {
  const r = row.row;
  const picked = row.candidates.find((c) => c.driverId === chosen) ?? null;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-[220px]">
          <div className="text-sm font-bold text-nw-text uppercase">
            {r.name}
            {r.coDriver ? <span className="text-nw-text-3"> // {r.coDriver}</span> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-nw-text-3">
            {r.truckUnit ? <span className="rounded bg-nw-subtle px-1.5 py-0.5 font-semibold">Truck {r.truckUnit}</span> : null}
            {r.phone ? <span>{r.phone}</span> : null}
            {r.dispatcherName ? <span>· {r.dispatcherName}</span> : null}
          </div>
          <div className="mt-1 text-[11.5px] text-nw-text-3">
            {r.typedCells === 0
              ? 'Nothing typed on this row yet'
              : `${r.typedCells} typed cell${r.typedCells === 1 ? '' : 's'}${r.lastTypedAt ? ` · last ${formatDateTime(r.lastTypedAt)}` : ''}`}
          </div>
        </div>

        <div className="min-w-[min(320px,100%)] flex-1">
          {row.none ? (
            <div className="rounded-md border border-nw-border bg-nw-subtle px-3 py-2">
              <div className="flex items-center gap-2 text-[12.5px] font-semibold text-nw-text-2">
                <UserPlus className="size-3.5" aria-hidden /> No driver file matches this name
              </div>
              <p className="mt-1 text-[11.5px] text-nw-text-3">
                The row keeps working on the board. Create the driver in Drivers to put them on loads — this screen will
                suggest the match once the file exists.
              </p>
            </div>
          ) : (
            <>
              {row.ambiguous ? (
                <div className="mb-2 flex items-center gap-2 rounded-md bg-nw-urgent-bg px-2.5 py-1.5 text-[11.5px] font-bold text-nw-urgent-text">
                  <TriangleAlert className="size-3.5" aria-hidden />
                  Two files could be this person. Pick one deliberately — nothing is preselected.
                </div>
              ) : null}
              <div className="flex flex-col gap-1.5">
                {row.candidates.map((c) => (
                  <label
                    key={c.driverId}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2',
                      chosen === c.driverId ? 'border-nw-accent bg-nw-accent-tint' : 'border-nw-border hover:bg-nw-hover',
                    )}
                  >
                    <input
                      type="radio"
                      name={`match-${r.id}`}
                      className="size-3.5"
                      checked={chosen === c.driverId}
                      onChange={() => onChoose(c.driverId)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold text-nw-text">{c.driverName}</span>
                      <span className="block text-[11.5px] text-nw-text-3">
                        {c.reasons.join(' · ')}
                        {c.driverStatus !== 'active' ? ` · driver file is ${c.driverStatus}` : ''}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10.5px] font-bold uppercase',
                        c.confidence === 'exact'
                          ? 'bg-nw-done-bg text-nw-done-text'
                          : c.confidence === 'strong'
                            ? 'bg-nw-info-bg text-nw-info-text'
                            : 'bg-nw-subtle text-nw-text-3',
                      )}
                    >
                      {c.confidence}
                    </span>
                  </label>
                ))}
              </div>

              {picked?.hasRosterRow ? (
                <p className="mt-2 rounded-md bg-nw-warning-bg px-2.5 py-1.5 text-[11.5px] font-semibold text-nw-warning-text">
                  {picked.driverName} already has a board row. The next screen shows both rows side by side and asks
                  about anything they disagree on before a thing is written.
                </p>
              ) : null}

              <div className="mt-2 flex items-center gap-2">
                <Button
                  size="sm"
                  icon={<Check />}
                  disabled={!picked || saving}
                  loading={saving}
                  onClick={() => picked && onConfirm(picked)}
                >
                  {picked?.hasRosterRow ? 'Review the merge' : 'Confirm match'}
                </Button>
                <span className="inline-flex items-center gap-1 text-[11.5px] text-nw-text-3">
                  <Link2 className="size-3.5" aria-hidden /> Nothing is saved until you confirm
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
