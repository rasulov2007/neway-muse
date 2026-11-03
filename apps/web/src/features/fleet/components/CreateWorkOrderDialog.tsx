import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  WORK_ORDER_CHARGE_PARTIES,
  WORK_ORDER_CHARGE_PARTY_LABEL,
  WORK_ORDER_ZERO_REASONS,
  WORK_ORDER_ZERO_REASON_LABEL,
  WORK_TYPES,
  WORK_TYPE_LABEL,
  WORK_ORDER_PAYMENT_TERMS,
  WORK_ORDER_PAYMENT_TERMS_LABEL,
  type WorkOrderPaymentTerms,
  type CreateWorkOrderRequest,
  type WorkOrder,
  type WorkOrderStatus,
  type DriverRecord,
  type WorkOrderChargeParty,
  type WorkOrderZeroReason,
  type WorkType,
  TIRE_EVENT_TYPES,
  TIRE_EVENT_TYPE_LABEL,
  parseTireText,
  tirePositionChip,
  type TireEventType,
  type TirePositionKey,
} from '@neway/shared';
import { TireTruckSvg } from '../tires/TireTruckSvg';
import { TireWorkSection, type TireWorkResult } from '../tires/TireWorkSection';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Combobox,
  DatePicker,
  FormField,
  Input,
  Modal,
  Select,
  Textarea,
  useToast,
} from '@/design-system';
import {
  attachWorkOrderInvoice,
  createRepairOrder,
  demoCurrentUser,
  listFleetVendors,
  listWorkOrderTypes,
  syncDriverChargeDeduction,
  type MaintenanceType,
  type Vendor,
  type WorkOrderUnitKind,
} from '@/demo';
import { apiGet, apiPost } from '@/lib/api-client';
import { nowMs } from '@/lib/clock';
import { isEnabled } from '@/lib/feature-flags';
import { formatDate, formatMoney, parseMoney } from '@/lib/format';
import { uploadFile } from '@/lib/files';
import { FileDropzone } from './FileDropzone';
import { VendorFormDialog } from './VendorFormDialog';
import { OTHER_WORK_SYSTEMS } from '../pm/board-model';
import { useFleet, useInvalidateFleet, type FleetTrailer, type FleetTruck } from '../useFleet';
import { useLeaseOperatorTrucks } from '../lease-operator';
import { assignmentKey } from '../use-truck-assignment';
import type { TruckAssignmentView, TruckRecord } from '@neway/shared';
import { useLeaveGuard } from '../pm/useLeaveGuard';
import { findDuplicateOrder } from '../work-order-duplicate';
import { unitIdentity } from '../unit-header';

/** A unit the dialog can open an order against: `truck:<id>` or `trailer:<id>`. */
export interface WorkOrderUnitRef {
  kind: WorkOrderUnitKind;
  id: string;
}

function keyOf(unit: WorkOrderUnitRef): string {
  return `${unit.kind}:${unit.id}`;
}

function parseKey(key: string): WorkOrderUnitRef | null {
  const [kind, id] = key.split(':');
  return (kind === 'truck' || kind === 'trailer') && id ? { kind, id } : null;
}

/** One line of "What was done": the system, the work, and what that part of the invoice cost. */
interface LineDraft {
  key: string;
  systemCode: string;
  description: string;
  amount: string;
}

let lineSeq = 0;
const newLine = (): LineDraft => ({
  key: `l${(lineSeq += 1)}`,
  systemCode: '',
  description: '',
  amount: '',
});

/** The systems a line can be coded to: the repair systems, plus PM and fees, which are not repairs. */
const LINE_SYSTEMS = [
  ...OTHER_WORK_SYSTEMS,
  { value: 'pm', label: 'PM / oil change' },
  { value: 'fees', label: 'Fees' },
];

const STATUS_OPTIONS: { value: WorkOrderStatus; label: string }[] = [
  { value: 'completed', label: 'Completed' },
  { value: 'in_shop', label: 'In the shop' },
  { value: 'scheduled', label: 'Scheduled into a shop' },
];

interface UnitOption {
  id: string;
  unitNumber: string;
  description: string;
  odometer: number | null;
}

/** A Postgres work type for a catalog code, when the write path only knows the six. */
function workTypeFor(code: string): WorkType {
  if ((WORK_TYPES as readonly string[]).includes(code)) return code as WorkType;
  if (/oil/.test(code)) return 'oil_change';
  if (/annual|dot/.test(code)) return 'annual_inspection';
  if (/pm/.test(code)) return 'pm_inspection';
  if (/tire/.test(code)) return 'tires';
  if (/accident/.test(code)) return 'accident_repair';
  return 'repair';
}

/** The catalog code a Postgres work type files under, when the write path is the workspace. */
function catalogTypeFor(code: string, types: { code: string }[]): MaintenanceType {
  if (types.some((t) => t.code === code)) return code as MaintenanceType;
  return 'other' as MaintenanceType;
}

/**
 * Create work order — and Create repair, which is the same form (the owner's 2026-09-20 mockup).
 *
 * One dialog, opened from the Repair log, Fleet today, the shop board and inside a unit. Opened
 * from a unit the picker is fixed — the unit is already known, and asking again invites picking
 * the wrong one. From a list the picker searches trucks and trailers together, because trailers
 * break too and a dialog that only knew trucks is why trailer spend was invisible.
 *
 * Completed is the default status, because the team fixes the truck first and does the paperwork
 * afterwards: this is written for somebody holding an invoice a week after the job. Only the five
 * things a completed record must say block saving (specification §2.3) — the unit, the shop, the
 * back-in-service date, the invoice total and at least one line with a system. Everything else,
 * the invoice file included, saves and is flagged for review.
 *
 * With `fleet_v2` on the record is written to the server's work orders; off, to the workspace the
 * older Fleet screens read, with the lines folded into the notes.
 */
export function CreateWorkOrderDialog({
  open,
  onOpenChange,
  onDone,
  defaultTruckId,
  defaultUnit,
  defaultWorkType,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (order?: WorkOrder) => void;
  /** Kept for the truck page; the same as `defaultUnit: { kind: 'truck', id }`. */
  defaultTruckId?: string;
  defaultUnit?: WorkOrderUnitRef | null;
  defaultWorkType?: WorkType;
  /** Accepted for older callers; the dialog loads its own roster now. */
  trucks?: FleetTruck[];
  trailers?: FleetTrailer[];
}) {
  // Mounted fresh for each opening, keyed on what it was opened with, so reopening from another
  // row never shows the previous row's answers.
  if (!open) return null;
  const fixed: WorkOrderUnitRef | null =
    defaultUnit ?? (defaultTruckId ? { kind: 'truck', id: defaultTruckId } : null);
  return (
    <WorkOrderForm
      key={`${fixed ? keyOf(fixed) : ''}:${defaultWorkType ?? ''}`}
      onOpenChange={onOpenChange}
      onDone={onDone}
      fixed={fixed}
      defaultWorkType={defaultWorkType}
    />
  );
}

function WorkOrderForm({
  onOpenChange,
  onDone,
  fixed,
  defaultWorkType,
}: {
  onOpenChange: (open: boolean) => void;
  onDone: (order?: WorkOrder) => void;
  fixed: WorkOrderUnitRef | null;
  defaultWorkType?: WorkType;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateFleet();
  const v2 = isEnabled('fleet_v2');

  const [unit, setUnit] = useState<WorkOrderUnitRef | null>(fixed);
  const kind: WorkOrderUnitKind = unit?.kind ?? 'truck';
  /*
   * No default type.
   *
   * The list used to open on whatever happened to be first, so a form submitted without thinking
   * coded the repair as that - which is how three radiator jobs came to be filed as DPF work. An
   * empty picker asks the question instead of answering it wrongly (acceptance test A14).
   */
  const [type, setType] = useState<string | null>(defaultWorkType ?? null);
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<WorkOrderStatus>('completed');
  const [backInService, setBackInService] = useState<Date | null>(null);
  const [date, setDate] = useState<Date | null>(null);
  const [vendorId, setVendorId] = useState<string | null>(null);
  /** The name typed into the vendor picker that has no record yet; opens the nested form. */
  const [newVendorName, setNewVendorName] = useState<string | null>(null);
  const [technician, setTechnician] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  /** Tire positions picked by hand; null = what the tire rules read from the title and lines. */
  const [tirePicked, setTirePicked] = useState<Set<TirePositionKey> | null>(null);
  const [tireEvent, setTireEvent] = useState<TireEventType | null>(null);
  const [invoice, setInvoice] = useState<File | null>(null);
  const [invoiceTotal, setInvoiceTotal] = useState('');
  /** The mileage at an oil change: the Oil change board counts the next one from it (owner, 2026-10-18). */
  const [odometer, setOdometer] = useState('');
  /** The tire rows, when the type is Tires (owner, 2026-10-15: the Tire work order lives here now). */
  const [tireResult, setTireResult] = useState<TireWorkResult | null>(null);
  const [paymentTerms, setPaymentTerms] = useState<WorkOrderPaymentTerms | null>(null);
  const [zeroReason, setZeroReason] = useState<WorkOrderZeroReason | null>(null);
  const loTrucks = useLeaseOperatorTrucks();
  const [warranty, setWarranty] = useState(false);
  /*
   * Who pays (owner, 2026-09-24). Company is the ordinary case. A driver charge has to say
   * whether the driver was told: told, accounting takes it off what the driver earned; not told,
   * the charge is held and said plainly on the repair log and in accounting until somebody tells
   * the driver. Nobody's pay moves behind their back.
   */
  // Nothing is chosen for them (owner, 2026-10-13): who pays is a required answer.
  const [chargeParty, setChargeParty] = useState<WorkOrderChargeParty | null>(null);
  const [chargeDriverId, setChargeDriverId] = useState<string | null>(null);
  const [driverInformed, setDriverInformed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openedAt] = useState(() => nowMs());

  // ---- the roster: the server's units behind the flag, the workspace bundle before it
  const serverUnits = useQuery({
    queryKey: ['fleet', 'units', 'both'],
    queryFn: async () => {
      const [trucks, trailers] = await Promise.all([
        apiGet<{ data: UnitOption[] }>('/fleet/units', { assetType: 'truck' }),
        apiGet<{ data: UnitOption[] }>('/fleet/units', { assetType: 'trailer' }),
      ]);
      return { trucks: trucks.data, trailers: trailers.data };
    },
    enabled: v2,
    staleTime: 5 * 60_000,
  });
  /** The roster, for naming who is charged; only fetched once a driver charge is chosen. */
  const driverQuery = useQuery({
    queryKey: ['drivers', 'options'],
    queryFn: () => apiGet<{ data: DriverRecord[] }>('/drivers', { pageSize: 10_000 }),
    enabled: v2,
    // Opened right after an assignment, this has to show the new driver, not the list from a
    // minute ago.
    staleTime: 0,
  });
  /*
   * The truck's own assignment is the authority on who is in it. The assign flow writes its
   * answer straight into this query (see useAfterAssignmentChange), so the name is right the
   * moment the dialog opens - no refetch to wait on, no roster scan that can miss.
   */
  const truckAssignment = useQuery({
    queryKey: assignmentKey(unit?.kind === 'truck' ? unit.id : ''),
    queryFn: () => apiGet<TruckAssignmentView>(`/trucks/${unit!.id}/assignment`),
    enabled: v2 && unit?.kind === 'truck',
    staleTime: 0,
  });
  // A vendor truck (owner, 2026-10-28): its repairs are the vendor's, said beside Who pays.
  const unitTruck = useQuery({
    queryKey: ['truck', unit?.kind === 'truck' ? unit.id : ''],
    queryFn: () => apiGet<TruckRecord>(`/trucks/${encodeURIComponent(unit!.id)}`),
    enabled: unit?.kind === 'truck',
    staleTime: 60_000,
  });
  const unitVendor = unitTruck.data?.vendor ?? null;
  const driverOptions = useMemo(
    () =>
      (driverQuery.data?.data ?? [])
        .map((d) => ({ value: d.id, label: d.name || `${d.firstName} ${d.lastName}`.trim() }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [driverQuery.data],
  );
  /*
   * The driver on the chosen truck.
   *
   * Picking the unit answers "who is charged" on its own - the roster already says who is on that
   * truck - so the name fills itself in and the picker is only for the exception. Derived rather
   * than copied into state, so changing the truck changes the name instead of leaving the last
   * one sitting there.
   */
  const unitDriver = useMemo(() => {
    if (!unit || unit.kind !== 'truck') return null;
    const current = truckAssignment.data?.current;
    if (current) return { id: current.driverId, name: current.driverName };
    const fromRoster = (driverQuery.data?.data ?? []).find((d) => d.currentTruckId === unit.id);
    return fromRoster ? { id: fromRoster.id, name: fromRoster.name } : null;
  }, [truckAssignment.data, driverQuery.data, unit]);
  const chargedDriverId = chargeDriverId ?? unitDriver?.id ?? null;
  const chargedDriverName =
    driverOptions.find((o) => o.value === chargedDriverId)?.label ?? unitDriver?.name ?? null;

  const bundle = useFleet();
  const unitOptions = useMemo(() => {
    if (v2) {
      const data = serverUnits.data;
      return [
        ...(data?.trucks ?? []).map((row) => ({
          value: keyOf({ kind: 'truck', id: row.id }),
          label: row.unitNumber,
          description: `Truck · ${row.description}`,
        })),
        ...(data?.trailers ?? []).map((row) => ({
          value: keyOf({ kind: 'trailer', id: row.id }),
          label: row.unitNumber,
          description: `Trailer · ${row.description}`,
        })),
      ];
    }
    return [
      ...(bundle.data?.trucks ?? []).map((row) => ({
        value: keyOf({ kind: 'truck', id: row.truck.id }),
        label: row.truck.unitNumber,
        description: `Truck · ${row.truck.year} ${row.truck.make} ${row.truck.model}`,
      })),
      ...(bundle.data?.trailers ?? []).map((row) => ({
        value: keyOf({ kind: 'trailer', id: row.trailer.id }),
        label: row.trailer.unitNumber,
        description: [
          'Trailer',
          unitIdentity([row.trailer.year, row.trailer.make, row.trailer.model]),
          row.trailer.type.replace(/_/g, ' '),
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    ];
  }, [v2, serverUnits.data, bundle.data]);
  const unitNumberLabel = unit ? (unitOptions.find((o) => o.value === keyOf(unit))?.label ?? '') : '';

  // ---- the type list: the six the server knows, or the workspace catalog before the flag
  const catalog = useMemo(() => listWorkOrderTypes(kind), [kind]);
  const typeOptions = v2
    ? WORK_TYPES.map((t) => ({ value: t, label: WORK_TYPE_LABEL[t] }))
    : catalog.map((t) => ({ value: t.code, label: t.label }));
  // A type the new unit kind does not offer clears rather than guesses.
  const effectiveType = type !== null && typeOptions.some((t) => t.value === type) ? type : null;

  // ---- tire work order: Type = Tires opens the tire rows in place of the lines and the total
  const tireMode = v2 && effectiveType !== null && workTypeFor(effectiveType) === 'tires';
  const tireCount = tireMode ? (tireResult?.count ?? 0) : 0;
  const effectiveTitle = title.trim() || (tireMode ? (tireResult?.summary ?? '') : '');

  // ---- tire work: positions read from the title and the lines, until somebody picks by hand
  const tireWork =
    (effectiveType !== null && workTypeFor(effectiveType) === 'tires') || lines.some((l) => l.systemCode === 'tires_wheels');
  const tireRead = useMemo(
    () => (tireWork ? parseTireText([title, ...lines.map((l) => l.description)].filter(Boolean).join(' · '), kind) : []),
    [tireWork, title, lines, kind],
  );
  const tireUnassigned = tireRead.filter((e) => e.positionId === 'UNASSIGNED').reduce((n, e) => n + e.quantity, 0);
  const tireSet: Set<TirePositionKey> =
    tirePicked ?? new Set(tireRead.filter((e) => e.positionId !== 'UNASSIGNED').map((e) => e.positionId as TirePositionKey));
  const tireType: TireEventType = tireEvent ?? tireRead[0]?.eventType ?? 'replaced';

  // ---- the shop
  const vendors = useQuery({ queryKey: ['vendors', 'options'], queryFn: () => listFleetVendors() });
  const vendorOptions = useMemo(
    () =>
      (vendors.data ?? []).map((v) => ({
        value: v.id,
        label: v.name,
        description: [
          v.city && v.state ? `${v.city}, ${v.state}` : v.city,
          v.kind.replace(/_/g, ' '),
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    [vendors.data],
  );
  const vendor: Vendor | null = (vendors.data ?? []).find((v) => v.id === vendorId) ?? null;
  const contactSuggestions = (vendor?.contacts ?? []).map((c) => c.name);

  // ---- money
  // A tire order's total is the tires, labor and fees added up - nobody types it twice.
  const total = tireMode ? (tireCount > 0 ? (tireResult?.totalCents ?? 0) / 100 : null) : parseMoney(invoiceTotal);
  const totalValid = tireMode || invoiceTotal.trim() === '' || (total !== null && total >= 0);
  const linesTotal = lines.reduce((sum, line) => sum + (parseMoney(line.amount) ?? 0), 0);
  const coded = lines.filter((line) => line.systemCode !== '' && line.description.trim() !== '');
  const mismatch = !tireMode && total !== null && coded.length > 0 && Math.abs(linesTotal - total) > 0.005;

  const completing = status === 'completed';
  const oilMode = v2 && completing && kind === 'truck' && effectiveType !== null && workTypeFor(effectiveType) === 'oil_change';
  const odometerDigits = odometer.replace(/[,\s]/g, '');
  const odometerMiles = /^\d{1,7}$/.test(odometerDigits) ? Number(odometerDigits) : null;
  const unitOdometer = unit?.kind === 'truck' ? (serverUnits.data?.trucks.find((t) => t.id === unit.id)?.odometer ?? null) : null;
  /*
   * The five fields that block a completed save, and nothing else (specification §2.3).
   *
   * A repair written up as completed is a claim about money and about a truck that went back on
   * the road. Without these it is a row that cannot be costed, counted as downtime or reconciled.
   */
  const missingForCompleted = completing
    ? [
        vendor === null ? 'a shop' : null,
        backInService === null ? 'a back-in-service date' : null,
        tireMode ? (tireCount === 0 ? 'at least one tire' : null) : total === null ? 'an invoice total' : null,
        tireMode ? null : coded.length === 0 ? 'at least one line with a system' : null,
        total === 0 && zeroReason === null ? 'a reason for the $0 total' : null,
        oilMode && odometerMiles === null ? 'the odometer at the oil change' : null,
      ].filter((f): f is string => f !== null)
    : [];
  const backInFuture = backInService !== null && backInService.getTime() > openedAt + 60_000;
  const backBeforeIn =
    backInService !== null && date !== null && backInService.getTime() < date.getTime();
  /* A driver charge with no answer to "was the driver told" is the one thing we will not save. */
  const chargeUnanswered =
    (v2 && chargeParty === null) ||
    (chargeParty === 'driver' && (driverInformed === null || chargedDriverId === null));
  const valid =
    unit !== null &&
    !chargeUnanswered &&
    effectiveType !== null &&
    effectiveTitle !== '' &&
    totalValid &&
    !backInFuture &&
    !backBeforeIn &&
    missingForCompleted.length === 0;

  /*
   * A duplicate is caught before it is saved (owner, 2026-09-30: the same trailer repair was
   * entered twice because the first did not show). Same unit, same shop, within a week, and the
   * same total - or, for someone who may not see money, the same description. It asks; it does
   * not refuse, because two identical repairs a few days apart can be real.
   */
  const [duplicate, setDuplicate] = useState<{ number: string; when: string } | null>(null);
  const [checkingDuplicate, setCheckingDuplicate] = useState(false);
  const saveUnlessDuplicate = async () => {
    if (!v2 || !unit) {
      create.mutate();
      return;
    }
    setCheckingDuplicate(true);
    try {
      const existing = await apiGet<(WorkOrder & { total?: number | null })[]>('/fleet/work-orders', { unitId: unit.id });
      const match = findDuplicateOrder(existing, {
        vendorName: vendor?.name ?? null,
        total,
        title: effectiveTitle,
        at: (date ?? backInService ?? new Date()).getTime(),
      });
      if (match) {
        setDuplicate({ number: match.number, when: match.completedAt ?? match.shopInAt ?? match.createdAt });
        return;
      }
    } catch {
      // The check is a courtesy; if it cannot run, saving is still the user's call.
    } finally {
      setCheckingDuplicate(false);
    }
    create.mutate();
  };

  const create = useMutation({
    mutationFn: async (): Promise<WorkOrder | undefined> => {
      if (!unit || !effectiveType) throw new Error('Pick the unit the work is on');
      const lineInputs = coded.map((l) => ({
        systemCode: l.systemCode,
        description: l.description.trim(),
        amount: parseMoney(l.amount) ?? 0,
      }));

      if (v2) {
        let invoiceFileIds: string[] = [];
        if (invoice) {
          const stored = await uploadFile(invoice);
          invoiceFileIds = [stored.id];
        }
        const body: CreateWorkOrderRequest = {
          assetType: unit.kind,
          unitId: unit.id,
          status,
          workType: workTypeFor(effectiveType),
          title: effectiveTitle,
          shopInAt: status === 'scheduled' ? undefined : (date?.toISOString() ?? undefined),
          scheduledFor: status === 'scheduled' ? (date?.toISOString() ?? undefined) : undefined,
          completedAt: completing ? (backInService?.toISOString() ?? undefined) : undefined,
          assignedTo: technician.trim() || undefined,
          vendorId: vendor?.id ?? null,
          vendorName: vendor?.name ?? undefined,
          notes: notes.trim() || undefined,
          lines: tireMode ? (tireResult?.lines ?? []) : lineInputs,
          invoiceTotal: total,
          zeroReason: total === 0 ? zeroReason : null,
          paymentTerms: total !== null && total > 0 ? paymentTerms : null,
          invoiceFileIds,
          odometer: oilMode && odometerMiles !== null ? odometerMiles : undefined,
          tirePositions: tireMode
            ? tireCount > 0
              ? tireResult?.tirePositions
              : undefined
            : tireWork && tireSet.size > 0
              ? [...tireSet].map((positionId) => ({ positionId, eventType: tireType, quantity: 1 }))
              : undefined,
          warranty: warranty || chargeParty === 'warranty',
          chargeParty: chargeParty ?? 'company',
          chargeDriverId: chargeParty === 'driver' || chargeParty === 'investigation' ? chargedDriverId : null,
          driverInformed: chargeParty === 'driver' ? driverInformed : null,
        };
        const created = await apiPost<WorkOrder>('/fleet/work-orders', body);
        /*
         * A driver charge reaches accounting as a deduction on that driver - held until the
         * driver has been told, running once they have. Written here, from what the server
         * answered, so the plan always carries the order's own number and driver.
         */
        if (created.charge.party === 'driver' && created.charge.driverId) {
          syncDriverChargeDeduction({
            orderId: created.id,
            orderNumber: created.number,
            driverId: created.charge.driverId,
            amount: total ?? 0,
            informed: created.charge.driverInformed === true,
            summary: effectiveTitle,
            startsOn: created.completedAt ?? created.createdAt,
          });
        }
        return created;
      }

      // Before the flag: the workspace record the older screens read, lines folded into the notes.
      const lineText = lineInputs
        .map(
          (l) => `${l.systemCode.replace(/_/g, ' ')}: ${l.description} (${formatMoney(l.amount)})`,
        )
        .join('\n');
      const order = await createRepairOrder({
        truckId: unit.kind === 'truck' ? unit.id : '',
        unitType: unit.kind,
        trailerId: unit.kind === 'trailer' ? unit.id : null,
        type: catalogTypeFor(effectiveType, catalog),
        summary: title.trim(),
        priority: 'normal',
        vendorName: vendor?.name ?? '',
        vendorId: vendor?.id ?? null,
        technician,
        promisedAt: date?.toISOString() ?? null,
        backInServiceAt: backInService?.toISOString() ?? null,
        status: status === 'in_shop' ? 'in_shop' : status,
        warranty,
        notes: [notes.trim(), lineText].filter(Boolean).join('\n\n') || null,
        price: total ?? undefined,
      });
      if (invoice) {
        const stored = await uploadFile(invoice);
        await attachWorkOrderInvoice({
          orderId: order.id,
          fileName: invoice.name,
          sizeBytes: invoice.size,
          mimeType: invoice.type || 'application/octet-stream',
          fileUrl: stored.url,
          fileId: stored.id,
          uploadedBy: demoCurrentUser.name,
          amount: total,
        });
      }
      return undefined;
    },
    onSuccess: async (order) => {
      await Promise.all([
        invalidate(),
        queryClient.invalidateQueries({ queryKey: ['work-orders'] }),
        queryClient.invalidateQueries({ queryKey: ['pm'] }),
      ]);
      const unitLabel = unitOptions.find((o) => o.value === (unit ? keyOf(unit) : ''))?.label;
      toast({
        tone: 'success',
        title: `${order?.number ?? 'Work order'} ${completing ? 'recorded' : 'opened'}${unitLabel ? ` on ${unitLabel}` : ''}`,
        description: completing
          ? invoice
            ? `${invoice.name} attached as the invoice.`
            : unit?.kind === 'truck' && loTrucks.has(unit.id)
              ? 'Lease operator truck: no invoice needed.'
              : 'No invoice attached — it is listed for review until one is.'
          : status === 'scheduled'
            ? 'The unit stays in dispatch until the shop has it.'
            : 'The unit is out of dispatch while the shop has it.',
      });
      // A typed odometer the server did not accept as a reading (owner, 2026-10-22): said, not hidden.
      const odometerWarning = order && typeof order === 'object' && 'odometerWarning' in order ? (order as { odometerWarning?: string | null }).odometerWarning : null;
      if (odometerWarning) toast({ tone: 'warning', title: 'Odometer not accepted', description: `${odometerWarning}. It is kept as a conflict and not used; correct it on the work order.` });
      onDone(order);
      onOpenChange(false);
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The work order could not be created.'),
  });

  const patchLine = (index: number, next: Partial<LineDraft>) =>
    setLines(lines.map((line, i) => (i === index ? { ...line, ...next } : line)));

  // Anything typed makes closing a question, not a click (owner's ask, 2026-09-21).
  const dirty = Boolean(
    title.trim() || vendorId || invoice || invoiceTotal.trim() || notes.trim() || coded.length > 0 || tireCount > 0,
  );
  const leave = useLeaveGuard(dirty, () => onOpenChange(false));

  const holdLine =
    kind === 'trailer'
      ? 'A work order is opened against one unit. Moving a trailer into a shop marks it unavailable and detaches it from its truck; the truck itself stays dispatchable.'
      : 'A work order is opened against one unit. Moving it into a shop takes that unit out of dispatch automatically.';

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) leave.requestClose();
      }}
      size="lg"
      // The tire rows need room for five fields a row (owner, 2026-10-15).
      className={tireMode ? 'max-w-[1080px]' : undefined}
      title="Create work order"
      description={holdLine}
      footer={
        <>
          {missingForCompleted.length > 0 ? (
            <span className="mr-auto text-xs text-danger-text">
              Completed work needs {missingForCompleted.join(', ').replace(/, ([^,]*)$/, ' and $1')}
              .
            </span>
          ) : backInFuture ? (
            <span className="mr-auto text-xs text-danger-text">
              Back in service cannot be in the future.
            </span>
          ) : backBeforeIn ? (
            <span className="mr-auto text-xs text-danger-text">
              Back in service cannot be before the unit went in.
            </span>
          ) : v2 && chargeParty === null ? (
            <span className="mr-auto text-xs text-danger-text">Choose who pays.</span>
          ) : null}
          <Button variant="secondary" onClick={leave.requestClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            loading={create.isPending || checkingDuplicate}
            onClick={() => {
              setError(null);
              void saveUnlessDuplicate();
            }}
          >
            Create work order
          </Button>
        </>
      }
    >
      <ConfirmDialog
        open={duplicate !== null}
        onOpenChange={(open) => {
          if (!open) setDuplicate(null);
        }}
        title={`This looks like ${duplicate?.number ?? 'an existing work order'}`}
        description={`${duplicate?.number ?? 'A work order'} already records this repair on the same unit, at the same shop${duplicate ? `, ${formatDate(duplicate.when)}` : ''}. Save a second one only if it is really a separate repair.`}
        confirmLabel="Save anyway"
        cancelLabel="Don't save"
        onConfirm={() => {
          setDuplicate(null);
          create.mutate();
        }}
      />
      <div className="flex flex-col gap-4">
        {error ? (
          <p role="alert" className="text-sm text-danger-text">
            {error}
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Unit (truck or trailer)" required>
            {fixed ? (
              <Input autoComplete="off"
                readOnly
                aria-label="Unit (truck or trailer)"
                value={unitOptions.find((o) => o.value === keyOf(fixed))?.label ?? '…'}
              />
            ) : (
              <Combobox
                aria-label="Unit (truck or trailer)"
                options={unitOptions}
                value={unit ? keyOf(unit) : null}
                onValueChange={(key) => setUnit(key ? parseKey(key) : null)}
                placeholder="Type a unit or trailer number…"
                searchPlaceholder="Unit number, make or model"
                emptyMessage="No truck or trailer matches"
                loading={v2 ? serverUnits.isPending : bundle.isPending}
              />
            )}
          </FormField>
          <FormField label="Type" required>
            <Select
              aria-label="Type"
              options={typeOptions}
              value={effectiveType ?? undefined}
              placeholder="Pick a type…"
              onValueChange={setType}
            />
          </FormField>
        </div>

        {oilMode ? (
          <FormField
            label="Odometer (miles)"
            required
            description={`The mileage on the invoice. The Oil change board counts the next oil change from it${unitOdometer !== null ? ` (ELD now: ${unitOdometer.toLocaleString('en-US')} mi)` : ''}.`}
          >
            <Input autoComplete="off"
              inputMode="numeric"
              aria-label="Odometer (miles)"
              value={odometer}
              onChange={(e) => setOdometer(e.target.value)}
              placeholder={unitOdometer !== null ? unitOdometer.toLocaleString('en-US') : '412,500'}
            />
          </FormField>
        ) : null}

        <FormField label="Title" required={!tireMode} description={tireMode ? 'Left blank, it reads from the tires (e.g. Tire replacement · 2 tires).' : undefined}>
          <Input autoComplete="off"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={
              tireMode
                ? tireResult?.summary || 'Tire replacement · 2 tires'
                : kind === 'trailer'
                  ? 'Landing gear crank seized'
                  : 'Air leak at the trailer supply line'
            }
          />
        </FormField>

        <FormField label="Status" required>
          <Select
            aria-label="Status"
            options={STATUS_OPTIONS}
            value={status}
            onValueChange={(value) => setStatus(value as WorkOrderStatus)}
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          {completing ? (
            <FormField
              label="Back in service"
              required
              description="When the unit went back on the road. Downtime is measured to this, not to the invoice."
            >
              <DatePicker
                aria-label="Back in service"
                value={backInService}
                onChange={(d) => setBackInService(d ?? null)}
              />
            </FormField>
          ) : null}
          <FormField
            label="Date"
            description={
              status === 'scheduled'
                ? 'When the shop has it.'
                : completing
                  ? 'When it went into the shop. Left blank, the day it came back.'
                  : 'When it went into the shop. Left blank, today.'
            }
          >
            <DatePicker aria-label="Date" value={date} onChange={(d) => setDate(d ?? null)} />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Vendor/shop"
            required={completing}
            description="A shop that is not on the list can be created here."
          >
            <Combobox
              aria-label="Vendor/shop"
              options={vendorOptions}
              value={vendorId}
              onValueChange={setVendorId}
              onCreate={(typed) => setNewVendorName(typed)}
              createLabel={(typed) => `+ Create vendor "${typed}"`}
              placeholder="Search vendors…"
              searchPlaceholder="Name, city or type"
              emptyMessage="No vendor matches"
              loading={vendors.isPending}
            />
          </FormField>
          <FormField
            label="Technician"
            description={
              contactSuggestions.length > 0
                ? `${vendor?.name} has ${contactSuggestions.length} saved contact${contactSuggestions.length === 1 ? '' : 's'}.`
                : undefined
            }
          >
            <Input autoComplete="off"
              list="work-order-technicians"
              value={technician}
              onChange={(e) => setTechnician(e.target.value)}
            />
            <datalist id="work-order-technicians">
              {contactSuggestions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </FormField>
        </div>

        <FormField label="Description" description="What was reported, what the shop found.">
          <Textarea autoComplete="off" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>

        {/* Who pays. A driver charge only reaches the driver's pay once the driver has been told. */}
        {v2 ? (
          <section
            aria-label="Who pays"
            className="overflow-hidden rounded-md border border-nw-border bg-nw-panel"
          >
            <header className="border-b border-nw-border px-4 py-3">
              <h3 className="text-sm font-semibold text-ink">
                Who pays <span className="text-danger-text" aria-hidden>*</span>
              </h3>
              <p className="text-xs text-muted">
                A company expense goes to the company's books. A driver charge is taken off what
                that driver earned - but only once the driver has been told. Under investigation
                holds it until a fleet manager or Safety decides; Vendor pays is the truck's vendor's
                cost, never the company's; a warranty claim is claimed back from the maker or the shop.
              </p>
            </header>
            <div className="space-y-3 px-4 py-3">
              <div role="radiogroup" aria-label="Who pays" className="flex flex-wrap gap-2">
                {WORK_ORDER_CHARGE_PARTIES.map((party) => (
                  <button
                    key={party}
                    type="button"
                    role="radio"
                    aria-checked={chargeParty === party}
                    onClick={() => {
                      setChargeParty(party);
                      if (party !== 'driver') setDriverInformed(null);
                      if (party === 'company' || party === 'warranty') setChargeDriverId(null);
                    }}
                    className={
                      chargeParty === party
                        ? 'inline-flex h-9 items-center rounded-md border border-nw-accent bg-nw-accent-tint px-3 text-sm font-semibold text-nw-accent-ink'
                        : 'inline-flex h-9 items-center rounded-md border border-nw-border bg-nw-subtle px-3 text-sm text-nw-text-2 hover:bg-nw-hover'
                    }
                  >
                    {WORK_ORDER_CHARGE_PARTY_LABEL[party]}
                  </button>
                ))}
              </div>
              {unitVendor && chargeParty !== 'vendor' ? (
                <p className="text-xs text-info-text">
                  Unit {unit?.kind === 'truck' ? unitTruck.data?.unitNumber : ''} is {unitVendor.vendorName}'s truck: its repairs are the vendor's, so this is usually Vendor pays.
                </p>
              ) : null}

              {chargeParty === 'driver' ? (
                <div className="space-y-3">
                  <FormField
                    label="Driver charged"
                    required
                    description={
                      unitDriver && chargedDriverId === unitDriver.id
                        ? `${unitDriver.name} is the driver on unit ${unitNumberLabel}`.trim()
                        : 'Pick the driver this repair is charged to.'
                    }
                  >
                    <Select
                      value={chargedDriverId ?? ''}
                      placeholder={
                        unit && unit.kind === 'truck'
                          ? 'No driver on this unit - pick one'
                          : 'Pick the driver'
                      }
                      options={driverOptions}
                      onValueChange={(v) => setChargeDriverId(v || null)}
                    />
                  </FormField>
                  {chargedDriverId === null ? (
                    <p className="text-xs font-semibold text-nw-urgent-text">
                      {unit
                        ? 'Nobody is assigned to this unit, so the driver has to be named.'
                        : 'Pick the unit first and the driver on it fills itself in.'}
                    </p>
                  ) : null}

                  <FormField
                    label="Has the driver been told about this charge?"
                    required
                    description="Told: accounting deducts it from the driver's earnings. Not told: the charge is held and flagged until somebody tells them."
                  >
                    <div role="radiogroup" aria-label="Driver informed" className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={driverInformed === true}
                        onClick={() => setDriverInformed(true)}
                        className={
                          driverInformed === true
                            ? 'inline-flex h-9 items-center rounded-md border border-nw-done-text bg-nw-done-bg px-3 text-sm font-semibold text-nw-done-text'
                            : 'inline-flex h-9 items-center rounded-md border border-nw-border bg-nw-panel px-3 text-sm text-nw-text-2 hover:bg-nw-hover'
                        }
                      >
                        Driver informed
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={driverInformed === false}
                        onClick={() => setDriverInformed(false)}
                        className={
                          driverInformed === false
                            ? 'inline-flex h-9 items-center rounded-md border border-nw-warning-text bg-nw-warning-bg px-3 text-sm font-semibold text-nw-warning-text'
                            : 'inline-flex h-9 items-center rounded-md border border-nw-border bg-nw-panel px-3 text-sm text-nw-text-2 hover:bg-nw-hover'
                        }
                      >
                        Not informed yet
                      </button>
                    </div>
                  </FormField>

                  {driverInformed === false ? (
                    <p className="rounded-md bg-nw-warning-bg px-3 py-2 text-xs font-semibold text-nw-warning-text">
                      Held: nothing comes off {chargedDriverName ?? 'this driver'}'s pay. The repair
                      log and accounting will both show this charge as waiting until the driver is
                      told.
                    </p>
                  ) : null}
                  {driverInformed === true ? (
                    <p className="rounded-md bg-nw-done-bg px-3 py-2 text-xs font-semibold text-nw-done-text">
                      Accounting will take this off {chargedDriverName ?? 'the driver'}'s earnings.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {/* Not decided yet (owner, 2026-10-13): nothing is charged; it waits on Costs, the unit and the driver. */}
              {chargeParty === 'investigation' ? (
                <div className="space-y-3" data-testid="charge-investigation">
                  <FormField
                    label="Driver in question"
                    description={
                      unitDriver && chargedDriverId === unitDriver.id
                        ? `${unitDriver.name} is the driver on unit ${unitNumberLabel}`.trim()
                        : 'Optional. The repair shows on this driver while it is investigated.'
                    }
                  >
                    <Select
                      value={chargedDriverId ?? ''}
                      placeholder="No driver named"
                      options={driverOptions}
                      onValueChange={(v) => setChargeDriverId(v || null)}
                    />
                  </FormField>
                  <p className="rounded-md bg-nw-warning-bg px-3 py-2 text-xs font-semibold text-nw-warning-text">
                    Under investigation: nothing comes off anyone's pay. It shows on Costs
                    {chargedDriverName ? `, on ${chargedDriverName}` : ''} and on the unit until a
                    fleet manager or Safety decides Company or Driver.
                  </p>
                </div>
              ) : null}
              {chargeParty === 'warranty' ? (
                <p className="rounded-md bg-nw-moving-bg px-3 py-2 text-xs font-semibold text-nw-moving-text" data-testid="charge-warranty">
                  Warranty claim: the repair is flagged for a claim with the maker or the shop, and
                  Costs counts it under Warranty, apart from company spend.
                </p>
              ) : null}
            </div>
          </section>
        ) : null}

        {tireMode ? (
          <TireWorkSection
            unit={unit}
            unitNumber={unitOptions.find((o) => o.value === (unit ? keyOf(unit) : ''))?.label ?? ''}
            trailers={(serverUnits.data?.trailers ?? []).map((t) => ({ id: t.id, unitNumber: t.unitNumber }))}
            serviceDate={(backInService ?? new Date()).toISOString().slice(0, 10)}
            onChange={setTireResult}
          />
        ) : null}

        {/* What was done: one line per system. The system is what makes a repeat findable. */}
        {tireMode ? null : (
        <section
          aria-label="What was done"
          className="overflow-hidden rounded-md border border-nw-border bg-nw-panel"
        >
          <header className="border-b border-nw-border px-4 py-3">
            <h3 className="text-sm font-semibold text-ink">
              What was done
              {completing ? (
                <span aria-hidden className="ml-0.5 text-nw-urgent-text">
                  *
                </span>
              ) : null}
            </h3>
            <p className="text-xs text-muted">
              One line per system · at least one line for completed work
            </p>
          </header>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-nw-border text-left text-xs font-semibold text-nw-text-2">
                <th className="px-3 py-2">
                  System{completing ? <span className="ml-0.5 text-nw-urgent-text">*</span> : null}
                </th>
                <th className="px-3 py-2">
                  Work performed
                  {completing ? <span className="ml-0.5 text-nw-urgent-text">*</span> : null}
                </th>
                <th className="w-28 px-3 py-2">Amount</th>
                <th className="w-10 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={line.key} className="border-b border-nw-border">
                  <td className="w-40 px-3 py-2">
                    <Select
                      size="sm"
                      aria-label="System"
                      value={line.systemCode || undefined}
                      placeholder="Pick a system…"
                      onValueChange={(value) => patchLine(index, { systemCode: value })}
                      options={LINE_SYSTEMS}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input autoComplete="off"
                      size="sm"
                      aria-label="Work performed"
                      value={line.description}
                      onChange={(e) => patchLine(index, { description: e.target.value })}
                      placeholder="Describe the completed work…"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input autoComplete="off"
                      size="sm"
                      aria-label="Amount"
                      inputMode="decimal"
                      className="text-right"
                      value={line.amount}
                      onChange={(e) => patchLine(index, { amount: e.target.value })}
                      placeholder="0.00"
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 />}
                      aria-label="Remove line"
                      disabled={lines.length === 1}
                      onClick={() => setLines(lines.filter((_, i) => i !== index))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <footer className="flex flex-wrap items-center gap-3 px-3 py-2.5">
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus />}
              onClick={() => setLines([...lines, newLine()])}
            >
              Add line
            </Button>
            <span className="text-xs text-muted">
              Choose the system for each repair to track repeat issues.
            </span>
            <span className="ml-auto text-xs text-muted">
              Lines total{' '}
              <span
                className={
                  mismatch
                    ? 'font-semibold text-warning-text tabular-nums'
                    : 'font-semibold text-ink tabular-nums'
                }
              >
                {formatMoney(linesTotal)}
              </span>
            </span>
          </footer>
        </section>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <FileDropzone
            title={completing ? 'Invoice *' : 'Invoice'}
            subtitle="The shop's invoice"
            hint={
              completing
                ? 'Required to write up completed work: the invoice is what the shop actually charged. Without it the record saves and is listed for review.'
                : 'Optional until the work is completed.'
            }
            actionLabel="Browse files"
            file={invoice}
            onFile={setInvoice}
          />
          <section className="flex flex-col gap-3 rounded-md border border-nw-border bg-nw-panel p-3">
            <FormField
              label="Invoice total"
              required={completing}
              description={
                tireMode
                  ? 'Tires, labor and fees from the tire rows above.'
                  : mismatch
                    ? `Lines add up to ${formatMoney(linesTotal)}; the record saves and is flagged.`
                    : 'Match the total to the invoice.'
              }
              error={totalValid ? undefined : 'Enter an amount of zero or more'}
            >
              <Input autoComplete="off"
                aria-label="Invoice total"
                inputMode="decimal"
                placeholder="0.00"
                readOnly={tireMode}
                value={tireMode ? (total === null ? '' : total.toFixed(2)) : invoiceTotal}
                onChange={(e) => setInvoiceTotal(e.target.value)}
              />
            </FormField>
            {/* Company paid, or Pay later - which counts in Unpaid vendor bills until paid (owner, 2026-10-13). */}
            {v2 && total !== 0 ? (
              <FormField label="Payment" description={paymentTerms === 'pay_later' ? 'Counts in Unpaid vendor bills until Accounting pays it.' : paymentTerms === 'company_paid' ? 'Paid at the shop: nothing owed.' : 'Was the invoice paid, or is it owed?'}>
                <div role="radiogroup" aria-label="Payment" className="grid grid-cols-2 gap-2">
                  {WORK_ORDER_PAYMENT_TERMS.map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="radio"
                      aria-checked={paymentTerms === t}
                      onClick={() => setPaymentTerms(paymentTerms === t ? null : t)}
                      className={
                        paymentTerms === t
                          ? 'inline-flex h-9 items-center justify-center rounded-md border border-nw-accent bg-nw-accent-tint px-3 text-sm font-semibold text-nw-accent-ink'
                          : 'inline-flex h-9 items-center justify-center rounded-md border border-nw-border bg-nw-subtle px-3 text-sm text-nw-text-2 hover:bg-nw-hover'
                      }
                      data-testid={`payment-${t}`}
                    >
                      {WORK_ORDER_PAYMENT_TERMS_LABEL[t]}
                    </button>
                  ))}
                </div>
              </FormField>
            ) : null}
            {total === 0 ? (
              <FormField label="Why $0?" required>
                <Select
                  aria-label="Why $0?"
                  options={WORK_ORDER_ZERO_REASONS.map((r) => ({
                    value: r,
                    label: WORK_ORDER_ZERO_REASON_LABEL[r],
                  }))}
                  value={zeroReason ?? undefined}
                  placeholder="Pick a reason…"
                  onValueChange={(value) => setZeroReason(value as WorkOrderZeroReason)}
                />
              </FormField>
            ) : null}
          </section>
        </div>

        {/* Tire work: the wheel positions, prefilled by the tire rules (owner, 2026-10-13). Never blocks saving. */}
        {v2 && tireWork && !tireMode ? (
          <section className="flex flex-col gap-2 rounded-md border border-nw-border bg-nw-panel p-3" aria-label="Tire positions" data-testid="wo-tire-positions">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-ink">Tire positions</h3>
              <span className="text-xs text-muted">
                {tirePicked ? 'Picked by hand.' : tireRead.length > 0 ? 'Read from the description - check them.' : 'Click the tires that were worked on.'}
                {tireUnassigned > 0 && !tirePicked ? ` ${tireUnassigned} tire${tireUnassigned === 1 ? '' : 's'} could not be placed; they are listed for review if left.` : ''}
              </span>
              <div role="radiogroup" aria-label="What happened" className="ml-auto inline-flex gap-0.5 rounded-lg bg-nw-segment p-0.5">
                {TIRE_EVENT_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="radio"
                    aria-checked={tireType === t}
                    onClick={() => setTireEvent(t)}
                    className={tireType === t ? 'h-7 rounded-md bg-nw-panel px-2.5 text-xs font-semibold text-nw-text shadow-(--nw-shadow-segment)' : 'h-7 rounded-md px-2.5 text-xs font-semibold text-nw-text-2'}
                  >
                    {TIRE_EVENT_TYPE_LABEL[t]}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto rounded-md border border-nw-border" data-theme="light">
              <div className="min-w-[560px] bg-nw-subtle p-1.5">
                <TireTruckSvg
                  badges={false}
                  selected={tireSet}
                  onSelect={(id) => {
                    const next = new Set(tireSet);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    setTirePicked(next);
                  }}
                  className="mx-auto block h-auto w-full max-w-[1000px]"
                />
              </div>
            </div>
            <div className="flex min-h-6 flex-wrap gap-1">
              {[...tireSet].map((id) => (
                <span key={id} className="inline-flex h-6 items-center rounded bg-nw-accent-tint px-2 text-xs font-semibold text-nw-accent-ink">
                  {tirePositionChip(id)}
                </span>
              ))}
            </div>
          </section>
        ) : null}

        {/* With the server's orders, Warranty claim is one of the Who pays choices (owner, 2026-10-13). */}
        {v2 ? null : (
          <Checkbox
            checked={warranty}
            onCheckedChange={(checked) => setWarranty(checked === true)}
            label="Warranty claim"
          />
        )}
      </div>

      {leave.dialog}
      {/* Window in window: the order stays exactly as it was behind the vendor form. */}
      {newVendorName !== null ? (
        <VendorFormDialog
          name={newVendorName}
          onClose={() => setNewVendorName(null)}
          onSaved={(created) => {
            setNewVendorName(null);
            void vendors.refetch().then(() => setVendorId(created.id));
          }}
        />
      ) : null}
    </Modal>
  );
}
