import { useMemo, useState } from 'react';
import { weekStartMonday, type OffBoardDriver, type RosterRow, type TeamOrderView, type Dispatcher } from '@neway/shared';
import { Alert, Button, FormField, Modal, Select, useToast } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { useAssignDriverToTeam, useOffBoardDrivers, useRoster, useTeamOrder } from '@/features/dispatch/board/api';
import { WeekPicker } from '@/features/dispatch/board/chrome';
import { ReasonPicker } from '@/features/dispatch/board/RosterDialogs';
import { useDispatchers } from '@/features/people/useDispatchers';
import { today } from '@/lib/clock';
import { formatIsoDate } from '@/lib/format';

/**
 * The dispatcher picker's choices (owner, 2026-10-26): the teams in board order (TEAM 1 first),
 * then the solo dispatchers, then any other active dispatcher. Nicknames ride in the label.
 */
export function teamChoices(order: TeamOrderView | undefined, dispatchers: readonly Dispatcher[] | undefined): { value: string; label: string; name: string }[] {
  const out: { value: string; label: string; name: string }[] = [];
  const seen = new Set<string>();
  const add = (id: string, name: string, nickname: string | null | undefined, prefix?: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const shown = nickname && nickname !== name ? `${name} (${nickname})` : name;
    out.push({ value: id, label: prefix ? `${prefix} · ${shown}` : shown, name });
  };
  for (const t of order?.teams ?? []) add(t.dispatcherId, t.dispatcherName, t.dispatcherNickname, t.teamNumber ? `TEAM ${t.teamNumber}` : undefined);
  for (const s of order?.solos ?? []) add(s.dispatcherId, s.dispatcherName, s.dispatcherNickname);
  for (const d of dispatchers ?? []) if (d.active) add(d.id, d.name, d.nickname);
  return out;
}

/**
 * The driver's dispatcher on the board, on his profile's Assignment and equipment card (owner,
 * 2026-10-26): the team he sits under on the Daily board, or "No dispatcher", and Assign / Change
 * dispatcher for whoever manages the board. Saving goes through the board's own assign path, so
 * he shows on the board under that team from the chosen week.
 */
/** Whether the profile shows the board dispatcher at all: reading the roster takes dispatch.view. */
export function canSeeBoardDispatcher(permissions: readonly string[]): boolean {
  return permissions.includes('dispatch.view') || permissions.includes('dispatch.manage');
}

export function BoardDispatcherFact({ driverId, driverName }: { driverId: string; driverName: string }) {
  const account = useAccount();
  const permissions = account?.permissions ?? [];
  const canManage = permissions.includes('dispatch.manage');
  const canView = canManage || permissions.includes('dispatch.view');
  const roster = useRoster(canView);
  const offBoard = useOffBoardDrivers(canManage);
  const order = useTeamOrder(canView);
  const [open, setOpen] = useState(false);
  const row = roster.data?.find((r) => r.driverId === driverId && !r.unassignedAt) ?? roster.data?.find((r) => r.driverId === driverId);
  const off = offBoard.data?.find((o) => o.driverId === driverId);
  if (!canView) return null;
  if (roster.isPending) return <span className="text-muted">Loading…</span>;
  const onBoard = row && !row.unassignedAt;
  const nickname = row ? [...(order.data?.teams ?? []), ...(order.data?.solos ?? [])].find((t) => t.dispatcherId === row.dispatcherId)?.dispatcherNickname : null;
  const current = onBoard && row.dispatcherId ? { id: row.dispatcherId, name: row.dispatcherName, nickname: nickname ?? row.dispatcherNickname ?? null } : null;
  return (
    <>
      <span className="flex flex-wrap items-center gap-2" data-testid="board-dispatcher">
        {current ? (
          <span>
            {current.name}
            {current.nickname && current.nickname !== current.name ? <span className="text-muted"> ({current.nickname})</span> : null}
          </span>
        ) : (
          <span className="text-muted">{onBoard || !row ? 'No dispatcher' : 'Not on the board'}</span>
        )}
        {canManage ? (
          <Button size="sm" variant="link" onClick={() => setOpen(true)}>
            {current ? 'Change dispatcher' : 'Assign dispatcher'}
          </Button>
        ) : null}
      </span>
      {open ? <AssignDispatcherDialog driverId={driverId} driverName={driverName} row={row ?? null} off={off ?? null} current={current} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AssignDispatcherDialog({
  driverId,
  driverName,
  row,
  off,
  current,
  onClose,
}: {
  driverId: string;
  driverName: string;
  row: RosterRow | null;
  off: OffBoardDriver | null;
  current: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const order = useTeamOrder();
  const dispatchers = useDispatchers();
  const assign = useAssignDriverToTeam();
  const { toast } = useToast();
  const options = useMemo(() => teamChoices(order.data, dispatchers.data), [order.data, dispatchers.data]);
  const [pick, setPick] = useState<string>('');
  const [fromWeek, setFromWeek] = useState(() => weekStartMonday(today()));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const chosen = options.find((o) => o.value === pick) ?? null;
  // Moving from another dispatcher says why (owner, 2026-10-16) - the same rule as the board.
  const previous = current ?? (row?.dispatcherId ? { id: row.dispatcherId, name: row.dispatcherName } : null);
  const leaving = Boolean(previous && chosen && chosen.value !== previous.id);
  const save = async () => {
    setError(null);
    if (!chosen) return setError('Pick a dispatcher');
    if (leaving && reason.trim().length < 2) return setError(`Say why the driver leaves ${previous!.name}`);
    try {
      await assign.mutateAsync({
        driverId,
        rosterId: row?.id ?? off?.rosterId ?? undefined,
        dispatcherId: chosen.value,
        dispatcherName: chosen.name,
        fromWeek,
        reason: leaving ? reason.trim() : undefined,
        expectedVersion: row?.version ?? off?.version ?? undefined,
      });
      toast({ tone: 'success', title: `${driverName} assigned to ${chosen.name}`, description: `On the board under ${chosen.name} from the week of ${formatIsoDate(fromWeek)}.` });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={current ? 'Change dispatcher' : 'Assign dispatcher'}
      description={current ? `${driverName} is under ${current.name} on the board today.` : `${driverName} has no dispatcher on the board.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={assign.isPending} disabled={!chosen || chosen.value === current?.id} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Dispatcher" required>
          <Select
            aria-label="Dispatcher"
            placeholder={order.isPending || dispatchers.isPending ? 'Loading…' : 'Pick a dispatcher'}
            options={options.map((o) => ({ value: o.value, label: o.label }))}
            value={pick || undefined}
            onValueChange={setPick}
          />
        </FormField>
        <FormField label="From the week of" description="Earlier weeks keep the team they had.">
          <WeekPicker week={fromWeek} onChange={setFromWeek} label="From the week of" />
        </FormField>
        {leaving && previous ? <ReasonPicker label={`Why the driver leaves ${previous.name}`} value={reason} onChange={setReason} /> : null}
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Modal>
  );
}
