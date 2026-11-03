import { Plus, Search, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { canSeparateTeams, DISPATCH_CHANGE_REASONS, weekStartMonday, type OffBoardDriver, type RosterImportReport, type RosterRow } from '@neway/shared';
import { Alert, Button, FormField, Input, Modal, Select, Textarea, useToast } from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { dispatcherOptions, useDispatchers } from '@/features/people/useDispatchers';
import { formatIsoDate } from '@/lib/format';
import { useAddRosterRow, useAssignDriverToTeam, useImportRoster, useOffBoardDrivers, useRemoveRosterRowFromBoard, useRestoreRosterRow, useRoster, useUnassignRosterRow, useUpdateRosterRow } from './api';
import { WeekPicker } from './chrome';
import { SeparateTeamDialog } from './SeparateTeamDialogs';
import { useAccount } from '@/features/auth/auth-context';
import { CreateDriverFileDialog, useCanCreateDriverFile, type BoardRowForFile } from './DriverFileForRow';

/**
 * The roster's admin dialogs: Add driver (a board row, linked to a driver file or not), Edit
 * driver (co-driver, pay tag, truck, team, comment, unassign to Unassigned drivers, remove from
 * board / restore) and Import roster (CSV, dry run first, conflicts listed, never resolved by
 * the machine).
 */

/** The Team choice that takes a driver off his dispatcher (Unassign); never a real team id. */
const NO_TEAM ='__no_dispatcher__';

function TeamPicker({ dispatchers, value, onChange, allowNone = false }: { dispatchers: ReturnType<typeof useDispatchers>['data']; value: { id: string; name: string }; onChange: (v: { id: string; name: string }) => void; allowNone?: boolean }) {
  const options = useMemo(() => {
    const opts = dispatcherOptions(dispatchers, value.id === NO_TEAM ? '' : value.id);
    if (value.id && value.id !== NO_TEAM && !opts.some((o) => o.value === value.id)) opts.unshift({ value: value.id, label: value.name || value.id });
    if (allowNone) opts.unshift({ value: NO_TEAM, label: 'No dispatcher (Unassigned drivers)' });
    return opts;
  }, [dispatchers, value, allowNone]);
  return (
    <Select
      aria-label="Team"
      options={options}
      value={value.id || undefined}
      placeholder="Pick a dispatcher team"
      onValueChange={(id) => onChange({ id, name: options.find((o) => o.value === id)?.label ?? id })}
    />
  );
}

/**
 * Why a driver leaves a dispatcher (owner, 2026-10-16): the usual reasons as choices, Other asks
 * for the words. The value is the sentence the rotation report shows; empty until chosen.
 */
export function ReasonPicker({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const known = (DISPATCH_CHANGE_REASONS as readonly string[]).includes(value);
  const [choice, setChoice] = useState(value === '' ? '' : known ? value : 'other');
  return (
    <FormField label={label} required>
      <Select
        aria-label={label}
        placeholder="Pick a reason"
        value={choice || undefined}
        onValueChange={(v) => {
          setChoice(v);
          onChange(v === 'other' ? '' : v);
        }}
        options={[...DISPATCH_CHANGE_REASONS.map((r) => ({ value: r, label: r })), { value: 'other', label: 'Other…' }]}
      />
      {choice === 'other' ? <Input size="sm" className="mt-2" autoFocus placeholder="Write the reason" aria-label="Other reason" value={value} onChange={(e) => onChange(e.target.value)} /> : null}
    </FormField>
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

function CreateDriverDialog({ open, onClose, team }: { open: boolean; onClose: () => void; team?: { id: string; name: string } }) {
  const dispatchers = useDispatchers();
  const add = useAddRosterRow();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [coDriver, setCoDriver] = useState('');
  const [payTag, setPayTag] = useState('');
  const [truck, setTruck] = useState('');
  const [phone, setPhone] = useState('');
  const [pick, setPick] = useState<{ id: string; name: string }>(team ?? { id: '', name: '' });
  const [error, setError] = useState<string | null>(null);
  // The quick add stays (owner relies on it), but the row has no driver file until one is made
  // (owner, 2026-10-26): the dialog says so after the add and offers the file right there.
  const [added, setAdded] = useState<BoardRowForFile | null>(null);
  const [makingFile, setMakingFile] = useState(false);
  const canCreateFile = useCanCreateDriverFile();
  const submit = async () => {
    setError(null);
    if (!name.trim()) return setError('A driver name is needed');
    if (!pick.id) return setError('Pick a team');
    try {
      const row = await add.mutateAsync({
        name: name.trim(),
        coDriver: coDriver.trim() || null,
        payTag: payTag.trim() || null,
        truckUnit: truck.trim() || null,
        phone: phone.trim(),
        dispatcherId: pick.id,
        dispatcherName: pick.name,
      });
      toast({ tone: 'success', title: `${name.trim()} added to the board`, description: 'No driver file yet: loads can be assigned once one is made.' });
      setAdded({ id: row.id, name: row.name || name.trim(), phone: row.phone || phone.trim(), dispatcherId: row.dispatcherId || pick.id });
    } catch (e) {
      setError(describe(e));
    }
  };
  if (added && makingFile) return <CreateDriverFileDialog row={added} onClose={onClose} />;
  if (added)
    return (
      <Modal
        open={open}
        onOpenChange={(o) => !o && onClose()}
        title={`${added.name} is on the board`}
        description="The row is added. It has no driver file yet."
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Done
            </Button>
            {canCreateFile ? (
              <Button variant="primary" onClick={() => setMakingFile(true)}>
                Create driver file
              </Button>
            ) : null}
          </>
        }
      >
        <Alert tone="warning" title="No load can be assigned yet">
          Loads are assigned to driver files. Create the driver file for {added.name} (email, CDL, home, pay) and it is linked to this row.
          {canCreateFile ? null : ' Ask someone who adds drivers to make it.'}
        </Alert>
      </Modal>
    );
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Add driver to the board"
      description="A board row only. Loads can be assigned once the driver has a driver file; you can create it right after adding the row."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={add.isPending} onClick={() => void submit()}>
            Add driver
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Driver name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="JOHN SMITH" />
        </FormField>
        <FormField label="Co-driver" description="Makes the row a team truck">
          <Input value={coDriver} onChange={(e) => setCoDriver(e.target.value)} />
        </FormField>
        <FormField label="Truck #" description="Kept as typed, zeros included">
          <Input value={truck} onChange={(e) => setTruck(e.target.value)} placeholder="0053" />
        </FormField>
        <FormField label="Pay tag">
          <Input value={payTag} onChange={(e) => setPayTag(e.target.value)} placeholder="lLO · CD · C30" />
        </FormField>
        <FormField label="Phone #" description="Two numbers with // between">
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </FormField>
        <FormField label="Team" required>
          <TeamPicker dispatchers={dispatchers.data} value={pick} onChange={setPick} />
        </FormField>
      </div>
      {error ? (
        <Alert tone="danger" className="mt-3">
          {error}
        </Alert>
      ) : null}
    </Modal>
  );
}

/** "Oct 26": a Monday as the dialog names its week. */
function weekLabel(monday: string): string {
  return formatIsoDate(monday);
}

export function EditDriverDialog({ row: shown, week, onClose }: { row: RosterRow | null; week: string; onClose: () => void }) {
  const dispatchers = useDispatchers();
  /*
   * The row as the roster holds it NOW. A row removed from the board still sits on the earlier
   * weeks and days, where the board shows it as it was; opening it there must say it is off the
   * board today and offer Restore.
   */
  const roster = useRoster();
  const live = shown ? (roster.data?.find((r) => r.id === shown.id) as (RosterRow & { unassignedFrom?: string | null }) | undefined) : undefined;
  const row = shown && live ? { ...shown, unassignedAt: live.unassignedAt, unassignedReason: live.unassignedReason, version: live.version } : shown;
  const update = useUpdateRosterRow();
  const unassign = useUnassignRosterRow();
  const removeFromBoard = useRemoveRosterRowFromBoard();
  const restore = useRestoreRosterRow();
  const { toast } = useToast();
  const initial = {
    name: row?.name ?? '',
    coDriver: row?.coDriver ?? '',
    payTag: row?.payTag ?? '',
    truckUnit: row?.truckUnit ?? '',
    phone: row?.phone ?? '',
    comment: row?.comment ?? '',
    team: { id: row?.dispatcherId ?? '', name: row?.dispatcherName ?? '' },
  };
  const [form, setForm] = useState(() => initial);
  // The week a team change counts from: the board's week (a day on the Daily board means its week).
  const [fromWeek, setFromWeek] = useState(() => weekStartMonday(week));
  const [reason, setReason] = useState('');
  const [moveReason, setMoveReason] = useState('');
  const [removing, setRemoving] = useState(false);
  const [separating, setSeparating] = useState(false);
  const [removeReason, setRemoveReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!row) return null;
  const hasTeam = Boolean(row.dispatcherId);
  // Separate team: administrators and dispatch managers only (owner, 2026-10-29).
  const account = useAccount();
  const canSeparate = account !== null && canSeparateTeams(account.roles);
  /*
   * Unassign (owner, 2026-10-26): picking "No dispatcher" as the Team, or a reason in the Unassign
   * box, moves the driver to Unassigned drivers from the chosen week - whether the box's own
   * button or the dialog's Save is pressed. Save never drops it silently.
   */
  const unassigning = hasTeam && (form.team.id === NO_TEAM || reason.trim().length > 0);
  const leaving = hasTeam && !unassigning && Boolean(form.team.id) && form.team.id !== row.dispatcherId;
  const comingBack = !hasTeam && Boolean(form.team.id) && form.team.id !== NO_TEAM;
  const detailsChanged =
    form.name.trim() !== initial.name.trim() ||
    form.coDriver.trim() !== initial.coDriver.trim() ||
    form.payTag.trim() !== initial.payTag.trim() ||
    form.truckUnit.trim() !== initial.truckUnit.trim() ||
    form.phone.trim() !== initial.phone.trim() ||
    form.comment !== initial.comment;
  const save = async () => {
    setError(null);
    if (unassigning && reason.trim().length < 2) return setError(`Say why the driver leaves ${row.dispatcherName}`);
    if (leaving && moveReason.trim().length < 2) return setError(`Say why the driver leaves ${row.dispatcherName}`);
    try {
      let version = row.version;
      if (!unassigning || detailsChanged) {
        const moved = leaving || comingBack;
        const saved = await update.mutateAsync({
          id: row.id,
          name: form.name.trim() || undefined,
          coDriver: form.coDriver.trim() || null,
          payTag: form.payTag.trim() || null,
          truckUnit: form.truckUnit.trim() || null,
          phone: form.phone.trim(),
          comment: form.comment,
          dispatcherId: moved ? form.team.id : undefined,
          dispatcherName: moved ? form.team.name : undefined,
          reason: leaving ? moveReason.trim() : undefined,
          // Back from Unassigned drivers from the chosen week (owner, 2026-10-26).
          fromWeek: comingBack ? fromWeek : undefined,
          expectedVersion: version,
        });
        version = saved.version;
      }
      if (unassigning) {
        await unassign.mutateAsync({ id: row.id, reason: reason.trim(), fromWeek, expectedVersion: version });
        toast({ tone: 'success', title: `${row.name} moved to Unassigned drivers`, description: `From the week of ${weekLabel(fromWeek)}; earlier weeks stay with ${row.dispatcherName}.` });
      } else if (comingBack) {
        toast({ tone: 'success', title: `${row.name} moved to ${form.team.name}`, description: `From the week of ${weekLabel(fromWeek)}.` });
      } else {
        toast({ tone: 'success', title: 'Driver updated' });
      }
      onClose();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? `${e.message}` : describe(e));
    }
  };
  const doRemove = async () => {
    setError(null);
    if (removeReason.trim().length < 2) return setError('Say why the row is removed from the board');
    try {
      await removeFromBoard.mutateAsync({ id: row.id, reason: removeReason.trim(), fromWeek, expectedVersion: row.version });
      toast({ tone: 'success', title: `${row.name} removed from the board`, description: `From the week of ${weekLabel(fromWeek)}.` });
      onClose();
    } catch (e) {
      setError(describe(e));
    }
  };
  const doRestore = async () => {
    setError(null);
    try {
      await restore.mutateAsync({ id: row.id, expectedVersion: row.version });
      toast({ tone: 'success', title: `${row.name} is back on the board` });
      onClose();
    } catch (e) {
      setError(describe(e));
    }
  };
  if (separating) return <SeparateTeamDialog row={row} week={week} onClose={() => { setSeparating(false); onClose(); }} />;
  const busy = update.isPending || unassign.isPending;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={row.name}
      description={row.driverId ? `Driver file ${row.driverId} · a truck change is dated today, so earlier weeks keep their history` : 'Board row without a driver file'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            {unassigning ? 'Save and unassign' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Driver name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </FormField>
        <FormField label="Co-driver">
          <Input value={form.coDriver} onChange={(e) => setForm({ ...form, coDriver: e.target.value })} />
        </FormField>
        <FormField label="Truck #" description={row.truckConflict ? 'Another active row runs this truck number' : undefined}>
          <Input value={form.truckUnit} onChange={(e) => setForm({ ...form, truckUnit: e.target.value })} />
        </FormField>
        <FormField label="Pay tag">
          <Input value={form.payTag} onChange={(e) => setForm({ ...form, payTag: e.target.value })} />
        </FormField>
        <FormField label="Phone #" description="Two numbers with // between">
          <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </FormField>
        <FormField label="Team">
          <TeamPicker dispatchers={dispatchers.data} value={form.team} allowNone={hasTeam} onChange={(team) => setForm({ ...form, team })} />
        </FormField>
        {leaving ? (
          <div className="sm:col-span-2">
            <ReasonPicker label={`Why the driver leaves ${row.dispatcherName}`} value={moveReason} onChange={setMoveReason} />
          </div>
        ) : null}
        {row.coDriver && hasTeam && !row.unassignedAt && canSeparate ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-nw-border p-3 sm:col-span-2" data-testid="separate-team">
            <span className="text-[12.5px] text-nw-text-2">Team truck: {row.name} // {row.coDriver}</span>
            <Button size="sm" variant="secondary" onClick={() => setSeparating(true)}>
              Separate team…
            </Button>
          </div>
        ) : null}
        <FormField label="Manager comment" className="sm:col-span-2">
          <Textarea rows={2} value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} />
        </FormField>
      </div>
      <div className="mt-4 rounded-lg border border-nw-border p-3" data-testid="team-change">
        {row.unassignedAt ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] text-nw-text-2">
              Removed from the board{live?.unassignedFrom ? ` from the week of ${live.unassignedFrom}` : ''}
              {row.unassignedReason ? ` · ${row.unassignedReason}` : ''}
            </span>
            <Button size="sm" variant="secondary" className="ml-auto" loading={restore.isPending} onClick={() => void doRestore()}>
              Restore
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {hasTeam ? (
              <>
                <span className="text-[12px] font-bold text-nw-text-2 uppercase">Unassign from {row.dispatcherName}</span>
                <span className="text-[11.5px] text-nw-text-3">
                  From the chosen week on he has no dispatcher and moves to Unassigned drivers. Earlier weeks keep him under {row.dispatcherName}, with his data and the commission already earned.
                </span>
              </>
            ) : (
              <>
                <span className="text-[12px] font-bold text-nw-text-2 uppercase">In Unassigned drivers</span>
                <span className="text-[11.5px] text-nw-text-3">Pick a team above to move him back; the move counts from the chosen week.</span>
              </>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12.5px] text-nw-text-2">From the week of</span>
              <WeekPicker week={fromWeek} onChange={setFromWeek} label="From the week of" />
            </div>
            {hasTeam ? (
              <>
                <ReasonPicker label={`Why the driver leaves ${row.dispatcherName}`} value={reason} onChange={setReason} />
                <Button size="sm" variant="danger" className="self-end" loading={unassign.isPending} onClick={() => void save()}>
                  Unassign
                </Button>
              </>
            ) : null}
            <div className="mt-1 border-t border-nw-border pt-2">
              {removing ? (
                <div className="flex flex-col gap-2" data-testid="remove-from-board">
                  <span className="text-[11.5px] text-nw-text-3">
                    Takes the row off every board from the week of {weekLabel(fromWeek)} - for a row nobody drives. It is kept, and Restore brings it back.
                  </span>
                  <ReasonPicker label="Why the row is removed from the board" value={removeReason} onChange={setRemoveReason} />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setRemoving(false)}>
                      Keep on the board
                    </Button>
                    <Button size="sm" variant="danger" loading={removeFromBoard.isPending} onClick={() => void doRemove()}>
                      Remove from board
                    </Button>
                  </div>
                </div>
              ) : (
                <button type="button" onClick={() => setRemoving(true)} className="text-[12px] font-semibold text-nw-text-3 hover:underline">
                  Remove from board instead…
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      {error ? (
        <Alert tone="danger" className="mt-3">
          {error}
        </Alert>
      ) : null}
    </Modal>
  );
}

export function ImportRosterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const importRoster = useImportRoster();
  const { toast } = useToast();
  const [csv, setCsv] = useState('');
  const [report, setReport] = useState<RosterImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (dryRun: boolean) => {
    setError(null);
    try {
      const r = await importRoster.mutateAsync({ csv, dryRun });
      setReport(r);
      if (!dryRun) toast({ tone: 'success', title: `Roster imported · ${r.created} created · ${r.updated} updated · ${r.unchanged} unchanged` });
    } catch (e) {
      setError(describe(e));
    }
  };
  const onFile = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((t) => {
      setCsv(t);
      setReport(null);
    });
  };
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title="Import roster from CSV"
      description="Team / Driver / Truck columns, or the sheet's own layout with a team line above its drivers. Preview first; nothing is written until Apply."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button variant="secondary" disabled={!csv.trim()} loading={importRoster.isPending && !report} onClick={() => void run(true)}>
            Preview
          </Button>
          <Button variant="primary" disabled={!report || !report.dryRun} loading={importRoster.isPending && Boolean(report)} onClick={() => void run(false)}>
            Apply
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border border-nw-border px-3 py-1.5 text-[12.5px] font-semibold text-nw-text-2 hover:bg-nw-hover">
          <Upload className="size-4" aria-hidden /> Choose CSV
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
        <Textarea rows={6} value={csv} onChange={(e) => { setCsv(e.target.value); setReport(null); }} placeholder={'Team,Driver,Truck\nARLO / MAXWELL,JOHN SMITH // MARK DOE (lLO),# 0053'} className="font-mono text-[12px]" />
        {report ? (
          <div className="rounded-lg border border-nw-border p-3 text-[12.5px]">
            <div className="font-bold text-nw-text">
              {report.dryRun ? 'Preview' : 'Applied'} · {report.parsed} rows · {report.teams} teams · {report.created} new · {report.updated} changed · {report.unchanged} unchanged
            </div>
            {report.conflicts.length > 0 ? (
              <div className="mt-2">
                <div className="font-semibold text-nw-warning-text">Shared truck numbers (kept as they are, for review):</div>
                <ul className="mt-1 list-disc pl-5 text-nw-text-2">
                  {report.conflicts.map((c) => (
                    <li key={c.truckUnit}>
                      #{c.truckUnit}: {c.rows.map((r) => `${r.name} (${r.team})`).join(' · ')}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {report.skipped.length > 0 ? (
              <div className="mt-2">
                <div className="font-semibold text-nw-text-2">Skipped lines:</div>
                <ul className="mt-1 list-disc pl-5 text-nw-text-3">
                  {report.skipped.map((s) => (
                    <li key={s.line}>
                      line {s.line}: {s.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Modal>
  );
}

/** One line in Add driver: a board row, a driver file with no board row, or a row removed from the board. */
interface Candidate {
  key: string;
  source: 'board' | 'file' | 'removed';
  name: string;
  coDriver: string | null;
  truckUnit: string | null;
  driverNumber: string;
  phone: string;
  dispatcherId: string;
  dispatcherName: string;
  row?: RosterRow;
  off?: OffBoardDriver;
}

/** Search by name, co-driver, driver number (D-2112), truck, phone or team. */
export function candidateMatches(c: Pick<Candidate, 'name' | 'coDriver' | 'truckUnit' | 'driverNumber' | 'phone' | 'dispatcherName'>, needle: string): boolean {
  if (!needle) return true;
  const text = [c.name, c.coDriver ?? '', c.truckUnit ?? '', c.driverNumber, c.dispatcherName].join(' ').toLowerCase();
  if (text.includes(needle)) return true;
  const digits = needle.replace(/\D/g, '');
  return digits.length >= 3 && c.phone.replace(/\D/g, '').includes(digits);
}

/**
 * Add driver to a team (owner, 2026-09-22): pick a driver who already exists on the board -
 * "reassign" when they run under another team today - or, second, create a new driver. A team
 * is always an existing dispatcher; nothing here invents one. Drivers on the Drivers page who are
 * not on the board (no board row, or removed from it) are offered too (owner, 2026-10-26).
 */
export function AddDriverDialog({ open, onClose, team }: { open: boolean; onClose: () => void; team?: { id: string; name: string } }) {
  const roster = useRoster();
  const offBoard = useOffBoardDrivers(open && Boolean(team));
  const update = useUpdateRosterRow();
  const assign = useAssignDriverToTeam();
  const { toast } = useToast();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(!team);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<Candidate | null>(null);
  const [moveReason, setMoveReason] = useState('');
  const needle = q.trim().toLowerCase();
  const candidates = useMemo(() => {
    const out: Candidate[] = (roster.data ?? [])
      .filter((r) => !r.unassignedAt && r.dispatcherId !== team?.id)
      .map((r) => ({
        key: `row:${r.id}`,
        source: 'board' as const,
        name: r.name,
        coDriver: r.coDriver,
        truckUnit: r.truckUnit,
        driverNumber: r.driverNumber ?? '',
        phone: r.phone,
        dispatcherId: r.dispatcherId,
        dispatcherName: r.dispatcherName,
        row: r,
      }));
    for (const o of offBoard.data ?? [])
      out.push({
        key: o.rosterId ? `row:${o.rosterId}` : `file:${o.driverId}`,
        source: o.kind,
        name: o.name,
        coDriver: o.coDriver,
        truckUnit: o.truckUnit,
        driverNumber: o.driverNumber,
        phone: o.phone,
        dispatcherId: o.dispatcherId,
        dispatcherName: o.dispatcherName,
        off: o,
      });
    return out.filter((c) => candidateMatches(c, needle)).sort((a, b) => a.name.localeCompare(b.name));
  }, [roster.data, offBoard.data, needle, team?.id]);
  if (creating || !team) return <CreateDriverDialog open={open} onClose={onClose} team={team} />;
  const pick = async (c: Candidate, why?: string) => {
    setError(null);
    // Taking a driver from another dispatcher says why (owner, 2026-10-16).
    if (c.dispatcherId && c.dispatcherId !== team.id && !why) {
      setMoving(c);
      setMoveReason('');
      return;
    }
    try {
      if (c.row) {
        await update.mutateAsync({ id: c.row.id, dispatcherId: team.id, dispatcherName: team.name, reason: why, expectedVersion: c.row.version });
      } else if (c.off) {
        await assign.mutateAsync({
          driverId: c.off.driverId ?? undefined,
          rosterId: c.off.rosterId ?? undefined,
          dispatcherId: team.id,
          dispatcherName: team.name,
          reason: why,
          expectedVersion: c.off.version ?? undefined,
        });
      }
      toast({
        tone: 'success',
        title: c.source === 'board' ? `${c.name} moved to ${team.name}` : `${c.name} added to ${team.name}`,
        description: c.source === 'board' ? (c.dispatcherName ? `Earlier weeks stay with ${c.dispatcherName}.` : undefined) : 'On the board from this week; earlier weeks are unchanged.',
      });
      onClose();
    } catch (e) {
      setError(describe(e));
    }
  };
  const busy = update.isPending || assign.isPending;
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={`Add Driver — ${team.name}`}
      description="Pick a driver already in the system. One with a team today is reassigned from this week on; past weeks keep their team."
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <Input autoFocus size="sm" type="search" prefix={<Search />} placeholder="Search name, D-number, truck or phone…" aria-label="Search drivers" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="max-h-72 divide-y divide-nw-border overflow-auto rounded-md border border-nw-border" role="list">
          {roster.isPending ? (
            <li className="px-3 py-3 text-[12.5px] text-nw-text-3">Loading…</li>
          ) : candidates.length === 0 ? (
            <li className="px-3 py-3 text-[12.5px] text-nw-text-3">{offBoard.isPending ? 'Loading…' : 'No other drivers match.'}</li>
          ) : (
            candidates.map((c) => (
              <li key={c.key}>
                <button type="button" disabled={busy} onClick={() => void pick(c)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-nw-hover disabled:opacity-60">
                  <span className="text-[13px] font-semibold text-nw-text uppercase">
                    {c.name}
                    {c.coDriver ? ` // ${c.coDriver}` : ''}
                  </span>
                  {c.driverNumber ? <span className="text-[12px] text-nw-text-3">{c.driverNumber}</span> : null}
                  {c.truckUnit ? <span className="text-[12px] text-nw-text-3">#{c.truckUnit}</span> : null}
                  {c.source === 'removed' ? (
                    <span className="ml-auto inline-flex h-5 items-center rounded px-1.5 text-[11px] font-bold bg-nw-neutral-bg text-nw-text-2" title={c.off?.removedReason ?? undefined}>
                      Put back on board
                    </span>
                  ) : c.source === 'file' ? (
                    <span className="ml-auto inline-flex h-5 items-center rounded px-1.5 text-[11px] font-bold bg-nw-neutral-bg text-nw-text-2" title="In the driver files, not on the board yet">
                      not on board
                    </span>
                  ) : c.dispatcherId ? (
                    <span className="ml-auto inline-flex h-5 items-center rounded px-1.5 text-[11px] font-bold bg-(--bd-amber-bg) text-(--bd-amber-text)" title={`Today under ${c.dispatcherName}`}>
                      reassign
                    </span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
        <button type="button" onClick={() => setCreating(true)} className="inline-flex h-9 w-full items-center justify-center gap-1 rounded-md border border-dashed border-(--bd-blue) text-[12.5px] font-semibold text-(--bd-blue) hover:bg-(--bd-blue-bg)">
          <Plus className="size-3.5" aria-hidden /> Create new driver
        </button>
        {moving ? (
          <div className="flex flex-col gap-2 rounded-md border border-nw-border p-3" data-testid="reassign-reason">
            <span className="text-[12.5px] text-nw-text-2">
              Move <b>{moving.name}</b> from {moving.dispatcherName} to {team.name}
            </span>
            <ReasonPicker label={`Why the driver leaves ${moving.dispatcherName}`} value={moveReason} onChange={setMoveReason} />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setMoving(null)}>Cancel</Button>
              <Button size="sm" variant="primary" disabled={moveReason.trim().length < 2} loading={busy} onClick={() => void pick(moving, moveReason.trim())}>
                Move driver
              </Button>
            </div>
          </div>
        ) : null}
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Modal>
  );
}
