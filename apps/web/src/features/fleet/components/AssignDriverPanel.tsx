import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Package,
  Ban,
  Pencil,
  Repeat,
  User,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  AssignDriverRequest,
  AssignmentEquipment,
  AssignmentPhotoUpload,
  DriverRecord,
  TruckAssignmentView,
  TruckDriverAssignment,
} from '@neway/shared';
import {
  Avatar,
  Button,
  Combobox,
  DatePicker,
  EmptyState,
  FormField,
  Modal,
  SectionCard,
  Textarea,
  useToast,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet, apiPost } from '@/lib/api-client';
import { today as companyToday } from '@/lib/clock';
import { formatDateTime, formatIsoDate } from '@/lib/format';
import { useAfterAssignmentChange, useTruckAssignment } from '../use-truck-assignment';
import { PhotoPicker, PhotoStrip } from './assignment/AssignmentPhotos';
import { assignedDateProblem, dropDateProblem } from './assignment/assignment-rules';
import { EditAssignmentDialog } from './assignment/EditAssignmentDialog';
import { VoidAssignmentDialog } from './assignment/VoidAssignmentDialog';
import {
  DEFAULT_ITEMS,
  EquipmentChecklist,
  draftsToEquipment,
  type ItemDraft,
} from './assignment/EquipmentChecklist';
import { DropFields, UnassignDialog, newDropDraft, type DropDraft } from './assignment/UnassignDialog';

/**
 * The Assigned driver card on the truck page (owner's ask, 2026-09-21; reworked 2026-10-08).
 *
 * Who is in the unit, since when, and what went with it. The open assignment is the single source
 * of truth for who drives the unit: Assign driver, Change (another driver takes the unit — the
 * previous driver's drop is recorded in the same dialog), Unassign (a modal with the drop date,
 * what came back and photos) and Edit (any field of any assignment, version-checked) all write it
 * through the server, and every page that shows the driver is refreshed afterwards.
 */
export function AssignDriverPanel({
  truckId,
  unitNumber,
}: {
  truckId: string;
  unitNumber: string;
}) {
  const account = useAccount();
  // Fleet staff and dispatch leads hand units over without editing the truck (owner, 2026-10-17).
  const canEdit =
    account !== null &&
    (account.isOwner || account.permissions.includes('trucks.edit') || account.permissions.includes('truck_assignment.edit'));
  const view = useTruckAssignment(truckId);
  const [mode, setMode] = useState<'assign' | 'change' | null>(null);
  const [ending, setEnding] = useState(false);
  const [editing, setEditing] = useState<TruckDriverAssignment | null>(null);
  const [voiding, setVoiding] = useState<TruckDriverAssignment | null>(null);
  const current = view.data?.current ?? null;

  return (
    <SectionCard
      icon={<User />}
      title="Assigned driver"
      padding="sm"
      actions={
        canEdit && current ? (
          <>
            <Button size="sm" variant="secondary" icon={<Pencil />} onClick={() => setEditing(current)}>
              Edit
            </Button>
            <Button size="sm" variant="secondary" icon={<Repeat />} onClick={() => setMode('change')}>
              Change
            </Button>
            <Button size="sm" variant="secondary" icon={<UserMinus />} onClick={() => setEnding(true)}>
              Unassign
            </Button>
          </>
        ) : canEdit && view.data ? (
          <Button size="sm" variant="primary" icon={<UserPlus />} onClick={() => setMode('assign')}>
            Assign driver
          </Button>
        ) : undefined
      }
    >
      {view.isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : view.isError ? (
        <p className="text-sm text-danger-text">The assignment could not be read.</p>
      ) : current ? (
        <CurrentAssignment assignment={current} />
      ) : (
        <EmptyState
          size="sm"
          icon={<User />}
          title="No driver assigned"
          description="Assign a driver from the Drivers page's roster. The date, what was handed over and pickup photos are kept with the assignment."
          action={
            canEdit ? (
              <Button size="sm" variant="primary" icon={<UserPlus />} onClick={() => setMode('assign')}>
                Assign driver
              </Button>
            ) : undefined
          }
        />
      )}

      {view.data && view.data.history.length > 0 ? (
        <AssignmentHistory
          history={view.data.history}
          onEdit={canEdit ? (a) => setEditing(a) : undefined}
          onVoid={canEdit ? (a) => setVoiding(a) : undefined}
        />
      ) : null}

      {mode ? (
        <AssignDriverDialog
          truckId={truckId}
          unitNumber={unitNumber}
          replacing={mode === 'change' ? current : null}
          onClose={() => setMode(null)}
        />
      ) : null}
      {ending && current ? (
        <UnassignDialog truckId={truckId} assignment={current} onClose={() => setEnding(false)} />
      ) : null}
      {editing ? (
        <EditAssignmentDialog truckId={truckId} assignment={editing} onClose={() => setEditing(null)} />
      ) : null}
      {voiding ? (
        <VoidAssignmentDialog truckId={truckId} assignment={voiding} onClose={() => setVoiding(null)} />
      ) : null}
    </SectionCard>
  );
}

/** "12 Mar 2026", or "about 12 Mar 2026" for a reconstructed start. */
export function assignedOnWords(a: Pick<TruckDriverAssignment, 'assignedOn' | 'assignedOnApproximate'>): string {
  return `${a.assignedOnApproximate ? 'about ' : ''}${formatIsoDate(a.assignedOn)}`;
}

function ItemList({ items, empty }: { items: AssignmentEquipment[]; empty: string }) {
  if (items.length === 0) return <span className="text-muted">{empty}</span>;
  return (
    <span className="flex flex-col gap-0.5">
      {items.map((e, i) => (
        <span key={`${e.item}-${i}`} className="text-ink">
          {e.label}
          {e.detail ? <span className="text-muted"> · {e.detail}</span> : null}
        </span>
      ))}
    </span>
  );
}

function EditedLine({ a }: { a: TruckDriverAssignment }) {
  if (!a.editedByName || !a.editedAt) return null;
  return (
    <p className="text-xs text-muted">
      Edited by {a.editedByName} on {formatDateTime(a.editedAt)}
    </p>
  );
}

function CurrentAssignment({ assignment }: { assignment: TruckDriverAssignment }) {
  const handed = assignment.equipment.filter((e) => e.handedOver);
  const kept = assignment.equipment.filter((e) => !e.handedOver);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Avatar name={assignment.driverName} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-ink">{assignment.driverName}</p>
          <p className="text-xs text-muted">
            Driver {assignment.driverNumber} · in unit{' '}
            <span className="font-medium text-ink">{assignment.unitNumber}</span>
          </p>
        </div>
        <Button variant="secondary" size="sm" asChild>
          <Link to="/drivers/$driverId" params={{ driverId: assignment.driverId }}>
            Driver profile
            <ChevronRight aria-hidden />
          </Link>
        </Button>
      </div>
      <dl className="grid gap-3 rounded-lg border border-line-soft p-3 text-sm sm:grid-cols-2">
        <div className="flex items-start gap-2">
          <CalendarDays className="mt-0.5 size-4 shrink-0 text-nw-text-3" aria-hidden />
          <div>
            <dt className="text-xs text-muted">Assigned on</dt>
            <dd className="font-medium text-ink">{assignedOnWords(assignment)}</dd>
            <dd className="text-xs text-muted">
              by {assignment.createdByName || 'unknown'} · {formatDateTime(assignment.createdAt)}
            </dd>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Package className="mt-0.5 size-4 shrink-0 text-nw-text-3" aria-hidden />
          <div className="min-w-0">
            <dt className="text-xs text-muted">Handed over with the unit</dt>
            <dd>
              <ItemList items={handed} empty="Nothing recorded" />
            </dd>
            {kept.length > 0 ? (
              <dd className="mt-1 text-xs text-muted">
                Not handed over: {kept.map((e) => e.label).join(', ')}
              </dd>
            ) : null}
          </div>
        </div>
        {assignment.note ? (
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted">Note</dt>
            <dd className="whitespace-pre-line text-ink">{assignment.note}</dd>
          </div>
        ) : null}
        {assignment.pickupPhotos.length > 0 ? (
          <div className="sm:col-span-2">
            <PhotoStrip photos={assignment.pickupPhotos} label="Pickup photos" />
          </div>
        ) : null}
      </dl>
      <EditedLine a={assignment} />
    </div>
  );
}

/** Earlier drivers, newest first; each row opens to everything the record holds. */
export function AssignmentHistory({
  history,
  onEdit,
  onVoid,
}: {
  history: TruckDriverAssignment[];
  onEdit?: (a: TruckDriverAssignment) => void;
  onVoid?: (a: TruckDriverAssignment) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="mt-4 flex flex-col gap-1.5 border-t border-line-soft pt-3">
      <h4 className="text-xs font-semibold text-muted">Earlier drivers</h4>
      <ul className="flex flex-col divide-y divide-line-soft text-sm">
        {history.map((a) => {
          const expanded = open === a.id;
          return (
            <li key={a.id} className="py-1.5">
              <button
                type="button"
                className="flex w-full flex-wrap items-baseline justify-between gap-x-3 text-left"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : a.id)}
              >
                <span className="flex items-center gap-1 font-medium text-ink">
                  {expanded ? (
                    <ChevronDown className="size-4 text-nw-text-3" aria-hidden />
                  ) : (
                    <ChevronRight className="size-4 text-nw-text-3" aria-hidden />
                  )}
                  {a.driverName}
                </span>
                <span className="text-xs text-muted">
                  {assignedOnWords(a)} – {a.endedOn ? formatIsoDate(a.endedOn) : 'open'}
                  {a.endReason ? ` · ${a.endReason}` : ''}
                </span>
              </button>
              {expanded ? <HistoryDetails a={a} onEdit={onEdit} onVoid={onVoid} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function HistoryDetails({
  a,
  onEdit,
  onVoid,
}: {
  a: TruckDriverAssignment;
  onEdit?: (a: TruckDriverAssignment) => void;
  onVoid?: (a: TruckDriverAssignment) => void;
}) {
  const handed = a.equipment.filter((e) => e.handedOver);
  const returned = a.returnedEquipment?.filter((e) => e.handedOver) ?? null;
  const missing = a.returnedEquipment?.filter((e) => !e.handedOver) ?? [];
  return (
    <div className="mt-2 flex flex-col gap-3 rounded-lg border border-line-soft p-3" data-testid="assignment-history-details">
      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted">Assigned</dt>
          <dd className="text-ink">{assignedOnWords(a)}</dd>
          <dd className="text-xs text-muted">
            by {a.createdByName || 'unknown'} · {formatDateTime(a.createdAt)}
            {a.source === 'backfill' ? ' · record added from the truck pointer' : ''}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Drop</dt>
          <dd className="text-ink">{a.endedOn ? formatIsoDate(a.endedOn) : 'Still in the unit'}</dd>
          {a.endedByName ? (
            <dd className="text-xs text-muted">
              by {a.endedByName}
              {a.endedAt ? ` · ${formatDateTime(a.endedAt)}` : ''}
            </dd>
          ) : null}
        </div>
        <div>
          <dt className="text-xs text-muted">Handed over</dt>
          <dd>
            <ItemList items={handed} empty="Nothing recorded" />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Returned</dt>
          <dd>
            {returned === null ? (
              <span className="text-muted">Not recorded</span>
            ) : (
              <ItemList items={returned} empty="Nothing returned" />
            )}
          </dd>
          {missing.length > 0 ? (
            <dd className="mt-1 text-xs text-warning-text">
              Not returned: {missing.map((e) => e.label).join(', ')}
            </dd>
          ) : null}
        </div>
        {a.note ? (
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted">Note</dt>
            <dd className="whitespace-pre-line text-ink">{a.note}</dd>
          </div>
        ) : null}
        {a.dropNote ? (
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted">Drop note</dt>
            <dd className="whitespace-pre-line text-ink">{a.dropNote}</dd>
          </div>
        ) : null}
      </dl>
      <PhotoStrip photos={a.pickupPhotos} label="Pickup photos" />
      <PhotoStrip photos={a.dropPhotos} label="Drop photos" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <EditedLine a={a} />
        <div className="flex flex-wrap gap-2">
          {onVoid && a.endedOn ? (
            <Button size="sm" variant="ghost" icon={<Ban />} onClick={() => onVoid(a)}>
              Void entry
            </Button>
          ) : null}
          {onEdit ? (
            <Button size="sm" variant="secondary" icon={<Pencil />} onClick={() => onEdit(a)}>
              Edit
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Assign a driver to an empty unit, or Change: another driver takes the unit, and the previous
 * driver's drop (date, what came back, photos, note) is recorded in the same save.
 */
function AssignDriverDialog({
  truckId,
  unitNumber,
  replacing,
  onClose,
}: {
  truckId: string;
  unitNumber: string;
  replacing: TruckDriverAssignment | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const after = useAfterAssignmentChange(truckId);
  const drivers = useQuery({
    queryKey: ['drivers', 'options'],
    queryFn: () => apiGet<{ data: DriverRecord[] }>('/drivers', { pageSize: 10_000 }),
    staleTime: 60_000,
  });
  const today = companyToday();
  const [driverId, setDriverId] = useState<string | null>(null);
  const [assignedOn, setAssignedOn] = useState(today);
  const [items, setItems] = useState<ItemDraft[]>(DEFAULT_ITEMS);
  const [photos, setPhotos] = useState<AssignmentPhotoUpload[]>([]);
  const [note, setNote] = useState('');
  const [drop, setDrop] = useState<DropDraft | null>(() =>
    replacing ? newDropDraft(replacing, today) : null,
  );
  // In a Change the old driver hands the unit back the day the new one takes it, until the drop
  // date is set by hand (owner, 2026-10-08: picking an earlier start left the drop date behind).
  const [dropDateTouched, setDropDateTouched] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function changeAssignedOn(iso: string) {
    setAssignedOn(iso);
    if (!dropDateTouched) setDrop((current) => (current ? { ...current, endedOn: iso } : current));
  }

  function changeDrop(next: DropDraft) {
    if (drop && next.endedOn !== drop.endedOn) setDropDateTouched(true);
    setDrop(next);
  }

  const options = useMemo(
    () =>
      (drivers.data?.data ?? [])
        .filter((d) => d.status !== 'terminated' && d.id !== replacing?.driverId)
        .map((d) => ({
          value: d.id,
          label: d.name,
          description: [
            `Driver ${d.driverNumber}`,
            d.currentTruckUnit ? `in unit ${d.currentTruckUnit}` : 'no unit',
            d.status.replace(/_/g, ' '),
          ].join(' · '),
        })),
    [drivers.data, replacing?.driverId],
  );
  const chosen = drivers.data?.data.find((d) => d.id === driverId) ?? null;
  const displaces =
    chosen?.currentTruckUnit && chosen.currentTruckUnit !== unitNumber ? chosen.currentTruckUnit : null;

  // The new driver cannot take the unit before the current one had it: that period belongs to the
  // current driver. An earlier start means correcting the current assignment first (Edit).
  const assignedProblem =
    assignedDateProblem(assignedOn, today) ??
    (replacing && assignedOn && assignedOn < replacing.assignedOn
      ? `${replacing.driverName} has had the unit since ${formatIsoDate(replacing.assignedOn)}, so the new driver cannot take it earlier. To date the change earlier, first correct ${replacing.driverName}'s assigned date with Edit.`
      : null);
  const dropProblem =
    replacing && drop ? dropDateProblem(drop.endedOn, replacing.assignedOn, today, assignedOn) : null;

  const save = useMutation({
    mutationFn: async () => {
      if (!driverId) throw new Error('Pick the driver');
      const body: AssignDriverRequest = {
        driverId,
        assignedOn,
        equipment: draftsToEquipment(items, 'pickup'),
        note: note.trim() || null,
        pickupPhotoIds: photos.map((p) => p.fileId),
        expectedCurrentId: replacing?.id ?? null,
        ...(replacing && drop
          ? {
              previousDrop: {
                endedOn: drop.endedOn,
                returnedEquipment: draftsToEquipment(drop.returned, 'drop'),
                dropNote: drop.note.trim() || null,
                dropPhotoIds: drop.photos.map((p) => p.fileId),
              },
            }
          : {}),
      };
      return apiPost<TruckAssignmentView>(`/trucks/${truckId}/assignment`, body);
    },
    onSuccess: async (next) => {
      await after(next);
      toast({
        tone: 'success',
        title: `${chosen?.name ?? 'Driver'} assigned to unit ${unitNumber}`,
        description: `From ${formatIsoDate(assignedOn)}.${replacing ? ` ${replacing.driverName} dropped it on ${formatIsoDate(drop?.endedOn ?? assignedOn)}.` : ''}${displaces ? ` Unit ${displaces} no longer has this driver.` : ''}`,
      });
      onClose();
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The assignment could not be saved.'),
  });

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size={replacing ? 'lg' : 'md'}
      title={replacing ? 'Change driver' : 'Assign driver'}
      description={`Unit ${unitNumber}. The driver, the date, what goes with the unit and the photos stay on the record.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            disabled={!driverId || Boolean(assignedProblem || dropProblem) || uploading}
            onClick={() => {
              setError(null);
              save.mutate();
            }}
          >
            {replacing ? 'Change driver' : 'Assign driver'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <p role="alert" className="text-sm text-danger-text">
            {error}
          </p>
        ) : null}
        <FormField
          label={replacing ? 'New driver' : 'Driver'}
          required
          description={
            displaces
              ? `${chosen?.name} is in unit ${displaces} now and will be moved out of it (that assignment closes on the assigned date).`
              : 'From the Drivers page. Search by name or driver number.'
          }
        >
          <Combobox
            aria-label="Driver"
            options={options}
            value={driverId}
            onValueChange={setDriverId}
            placeholder="Search drivers…"
            searchPlaceholder="Name or driver number"
            emptyMessage="No driver matches"
            loading={drivers.isPending}
          />
        </FormField>
        <FormField
          label="Assigned date"
          required
          error={assignedProblem ?? undefined}
          description="The day the driver took the unit."
        >
          <DatePicker
            aria-label="Assigned date"
            value={assignedOn}
            invalid={Boolean(assignedProblem)}
            onIsoChange={(iso) => changeAssignedOn(iso ?? '')}
          />
        </FormField>
        <FormField
          label="Handed over with the unit"
          description="Tick what the driver received; add a serial or tag number where it helps."
        >
          <EquipmentChecklist mode="pickup" items={items} onChange={setItems} />
        </FormField>
        <FormField label="Pickup photos" description="The unit as the driver took it: outside, cab, dash, damage.">
          <PhotoPicker
            truckId={truckId}
            label="Add pickup photos"
            value={photos}
            onChange={setPhotos}
            onBusyChange={setUploading}
          />
        </FormField>
        <FormField label="Note">
          <Textarea rows={2} aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>

        {replacing && drop ? (
          <div className="flex flex-col gap-3 border-t border-line-soft pt-4">
            <h4 className="text-sm font-semibold text-ink">Drop of {replacing.driverName}</h4>
            <DropFields
              truckId={truckId}
              assignment={replacing}
              draft={drop}
              onChange={changeDrop}
              dateProblem={dropProblem}
              onBusyChange={setUploading}
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
