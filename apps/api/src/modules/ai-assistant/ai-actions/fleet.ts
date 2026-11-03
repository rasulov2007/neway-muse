import {
  CompletePmSchema,
  CreateWorkOrderSchema,
  DEFECT_DISPOSITION_LABEL,
  DEFECT_DISPOSITIONS,
  FIXED_VIA,
  PM_WORK_ITEM_LABEL,
  PM_WORK_ITEMS,
  PM_ZERO_REASONS,
  PTI_DEFECT_STATE_LABEL,
  SHOP_STAGE_LABEL,
  SHOP_STAGES,
  WORK_ORDER_CHARGE_PARTIES,
  WORK_ORDER_CHARGE_PARTY_LABEL,
  WORK_ORDER_PAYMENT_TERMS,
  WORK_ORDER_PAYMENT_TERMS_LABEL,
  WORK_ORDER_ZERO_REASONS,
  WORK_TYPE_LABEL,
  WORK_TYPES,
  canTransition,
  odometerCheck,
  type CompletePmInput,
  type CreateWorkOrderInput,
  type DefectDisposition,
  type FixedVia,
  type PtiDefectState,
  type ReviewInput,
  type ShopStage,
  type TransitionDefectInput,
  type WorkOrder,
  type WorkType,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../../common/auth/principal';
import { isFeatureEnabled } from '../../../common/flags/flags';
import { PayablesService } from '../../accounting/payables.service';
import { PmBoardService } from '../../fleet/pm-board.service';
import { PtiService } from '../../fleet/pti.service';
import { WorkOrdersService } from '../../fleet/work-orders.service';
import { refusal, StaleActionError, usd, type ActionContext, type ActionDef, type ActionRefusal } from './types';

/**
 * NeWay AI actions for Fleet: the same doors the Fleet screens use.
 *
 *   repair_record     - the Create work order form, written up as Completed (fleet spec §2.3: only
 *                       the five fields block - unit, shop, back in service, invoice total, a line
 *                       with a system; trailer work is filed on the trailer).
 *   unit_in_shop      - the same form with status "In the shop": the unit's down period.
 *   oil_change_record - the Oil change board's Record completion sheet (PmBoardService.complete).
 *   work_order_void   - Void on the work order page.
 *   pti_review        - the PTI review drawer's clean review, or a defect's "Mark fixed".
 *
 * Plans only read. Every run re-reads the record and refuses when it moved on.
 */

// ------------------------------------------------------------------------------------ helpers

const LINE_SYSTEMS: Record<string, string> = {
  body_doors: 'Body & doors',
  brakes: 'Brakes',
  electrical: 'Electrical & lights',
  tires_wheels: 'Tires & wheels',
  engine: 'Engine',
  cooling: 'Cooling',
  aftertreatment: 'Exhaust / aftertreatment',
  hvac: 'HVAC',
  suspension: 'Suspension & steering',
  other: 'Other',
  pm: 'PM / oil change',
  fees: 'Fees',
};

const TZ = 'America/New_York';
const WEEK_MS = 7 * 86_400_000;

type UnitKind = 'truck' | 'trailer';
interface UnitHit {
  id: string;
  unitNumber: string;
  kind: UnitKind;
  odometer: number | null;
}

const errText = (e: unknown): string => {
  if (e && typeof e === 'object') {
    const detail = (e as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail) return detail;
    const response = (e as { getResponse?: () => unknown }).getResponse?.();
    if (response && typeof response === 'object') {
      const m = (response as { message?: unknown }).message;
      if (Array.isArray(m)) return m.join('; ');
      if (typeof m === 'string') return m;
    }
    const message = (e as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return 'The request was refused.';
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const normUnit = (s: string) => s.trim().toUpperCase().replace(/^(UNIT|TRUCK|TRAILER|TRK|TRL)\s*#?\s*/, '').replace(/^0+(?=\d)/, '');
const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

function zoneOffsetMs(at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - at;
}

/** Today in US Eastern, from the server clock. */
function easternToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * A date the person said: a full timestamp stands as given; a bare day is noon Eastern on that
 * day, or now when that noon has not come yet (the form's date picker means "that day").
 */
function parseDay(value: string, now: Date): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) {
    const utcNoon = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
    const at = new Date(utcNoon - zoneOffsetMs(utcNoon));
    return at.getTime() > now.getTime() ? now : at;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const fmtDay = (d: Date | string) => new Date(d).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' });

/** A truck or trailer by its unit number; ambiguity is a refusal listing up to five. */
async function resolveUnit(ctx: ActionContext, principal: Principal, raw: string, kind: UnitKind | null): Promise<UnitHit | ActionRefusal> {
  const wanted = normUnit(raw);
  if (!wanted) return refusal('Say which unit, e.g. truck 2702 or trailer 5310.');
  const wo = ctx.get(WorkOrdersService);
  const kinds: UnitKind[] = kind ? [kind] : ['truck', 'trailer'];
  const all: UnitHit[] = [];
  for (const k of kinds) {
    const { data } = await wo.units(principal, k);
    for (const u of data) all.push({ id: u.id, unitNumber: u.unitNumber, kind: k, odometer: u.odometer });
  }
  const exact = all.filter((u) => normUnit(u.unitNumber) === wanted);
  if (exact.length === 1) return exact[0] as UnitHit;
  if (exact.length > 1) {
    return refusal(`Unit ${raw} is both ${exact.map((u) => `a ${u.kind}`).join(' and ')}. Say whether the work is on the truck or the trailer.`);
  }
  const near = all.filter((u) => normUnit(u.unitNumber).includes(wanted) || wanted.includes(normUnit(u.unitNumber)));
  if (near.length === 0) return refusal(`There is no ${kind ?? 'truck or trailer'} ${raw} in this company's fleet.`);
  return refusal(
    `No ${kind ?? 'unit'} is numbered exactly ${raw}. Did you mean: ${near
      .slice(0, 5)
      .map((u) => `${u.kind} ${u.unitNumber}`)
      .join(', ')}${near.length > 5 ? ` (and ${near.length - 5} more)` : ''}?`,
  );
}

const isRefusal = (v: unknown): v is ActionRefusal => !!v && typeof v === 'object' && (v as { ok?: unknown }).ok === false;

function pickByName<T extends { id: string; name: string }>(list: T[], raw: string, what: string, where: string): T | ActionRefusal {
  const wanted = norm(raw);
  if (!wanted) return refusal(`Say which ${what}.`);
  const exact = list.filter((v) => norm(v.name) === wanted);
  if (exact.length === 1) return exact[0] as T;
  if (exact.length > 1) return refusal(`There are ${exact.length} ${what}s named "${raw}". Merge them on ${where} first, or say which (${exact.slice(0, 5).map((v) => v.id).join(', ')}).`);
  const near = list.filter((v) => norm(v.name).includes(wanted) || wanted.includes(norm(v.name)));
  if (near.length === 1) return near[0] as T;
  if (near.length === 0) return refusal(`There is no ${what} named "${raw}". Add it on ${where} first, then ask again.`);
  return refusal(`"${raw}" matches more than one ${what}: ${near.slice(0, 5).map((v) => v.name).join('; ')}${near.length > 5 ? ` (and ${near.length - 5} more)` : ''}. Say which one.`);
}

/** The shops the Create work order form offers: the vendors table plus the workspace's list, active only. */
async function resolveVendor(ctx: ActionContext, principal: Principal, raw: string): Promise<{ id: string; name: string } | ActionRefusal> {
  const list = (await ctx.get(PayablesService).vendors(principal)).filter(
    (v) => v.status !== 'inactive' && !(v as { mergedIntoId?: string | null }).mergedIntoId,
  );
  return pickByName(list, raw, 'vendor/shop', 'Fleet › Vendors (/fleet/vendors)');
}

const unitLink = (u: { id: string; unitNumber: string; kind: UnitKind }) => ({
  kind: 'link' as const,
  label: `Open ${u.kind} ${u.unitNumber}`,
  to: u.kind === 'truck' ? `/fleet/trucks/${encodeURIComponent(u.id)}` : `/fleet/trailers/${encodeURIComponent(u.id)}`,
});
const orderLink = (o: { id: string; number: string }) => ({ kind: 'link' as const, label: `Open ${o.number}`, to: `/fleet/maintenance/${encodeURIComponent(o.id)}` });

function fleetFlagRefusal(): ActionRefusal | null {
  return isFeatureEnabled('fleet_v2') ? null : refusal('Work orders are not switched on for this server (fleet_v2 is off).');
}

type ListedOrder = WorkOrder & { total?: number | null };

/** Same unit, same shop, within a week, same total (or same words) - the form's duplicate check. */
function findDuplicate(existing: ListedOrder[], next: { vendorName: string; total: number | null; title: string; at: number }): ListedOrder | null {
  return (
    existing.find((o) => {
      if (o.voided) return false;
      if (norm(o.vendorName) !== norm(next.vendorName)) return false;
      const at = Date.parse(o.completedAt ?? o.shopInAt ?? o.createdAt);
      if (!Number.isFinite(at) || Math.abs(at - next.at) > WEEK_MS) return false;
      if (typeof o.total === 'number' && next.total !== null) return Math.abs(o.total - next.total) < 0.005;
      return norm(o.workDone ?? o.label) === norm(next.title);
    }) ?? null
  );
}

// ------------------------------------------------------------------------------ repair_record

interface RepairParams {
  body: CreateWorkOrderInput;
  unit: UnitHit;
  vendorName: string;
  /** The duplicate the person was warned about at plan time; a new one appearing makes the plan stale. */
  duplicateSeen: string | null;
  dupAt: number;
}

const lineSchema = {
  type: 'object',
  properties: {
    system: { type: 'string', enum: Object.keys(LINE_SYSTEMS), description: `The system the line was on: ${Object.entries(LINE_SYSTEMS).map(([k, v]) => `${k} = ${v}`).join(', ')}.` },
    description: { type: 'string', description: 'What the shop did on this line.' },
    amount: { type: 'number', description: 'Dollars for this line, e.g. 412.50.' },
  },
  required: ['system', 'amount'],
} as const;

const repairRecord: ActionDef<RepairParams> = {
  name: 'repair_record',
  description:
    'Record a repair that is already done (a completed work order), exactly like Fleet › Repairs › Create work order with status Completed. Needs: the unit number (truck or trailer - trailer work goes on the trailer, not the truck pulling it), the shop/vendor by name, the back-in-service date, the invoice total in dollars, and at least one line with a system and amount. Who pays defaults to Company expense. An oil change on a truck also needs the odometer. A $0 total needs a zero reason.',
  input_schema: {
    type: 'object',
    properties: {
      unit_number: { type: 'string', description: 'e.g. 2702' },
      asset_type: { type: 'string', enum: ['truck', 'trailer'], description: 'Say when the unit number could be either.' },
      vendor_name: { type: 'string', description: 'The shop as named on the Vendors page.' },
      back_in_service: { type: 'string', description: 'YYYY-MM-DD (Eastern) or ISO time the unit went back on the road. Not in the future.' },
      shop_in: { type: 'string', description: 'Optional: when it went into the shop. Left out, the same day as back in service.' },
      invoice_total: { type: 'number', description: 'The invoice total in dollars.' },
      lines: { type: 'array', items: lineSchema, minItems: 1 },
      work_type: { type: 'string', enum: [...WORK_TYPES], description: `Kind of work; default repair. ${WORK_TYPES.map((w) => `${w} = ${WORK_TYPE_LABEL[w]}`).join(', ')}.` },
      title: { type: 'string', description: 'What was wrong, in a few words. Defaults to the work type.' },
      odometer: { type: 'integer', description: 'Miles; required for a truck oil change.' },
      invoice_number: { type: 'string', description: "The shop's invoice number, when known." },
      zero_reason: { type: 'string', enum: [...WORK_ORDER_ZERO_REASONS], description: 'Only for a $0 total.' },
      payment_terms: { type: 'string', enum: [...WORK_ORDER_PAYMENT_TERMS], description: 'company_paid = paid at the shop; pay_later = counts in Unpaid vendor bills.' },
      who_pays: { type: 'string', enum: [...WORK_ORDER_CHARGE_PARTIES], description: 'Default company.' },
      driver_informed: { type: 'boolean', description: 'Required when who_pays is driver: has the driver been told?' },
      technician: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['unit_number', 'vendor_name', 'back_in_service', 'invoice_total', 'lines'],
  },
  permission: 'maintenance.edit',
  risk: 'confirm',
  async plan(ctx, principal, input) {
    const off = fleetFlagRefusal();
    if (off) return off;
    const kind = input.asset_type === 'truck' || input.asset_type === 'trailer' ? input.asset_type : null;
    const unit = await resolveUnit(ctx, principal, str(input.unit_number), kind);
    if (isRefusal(unit)) return unit;
    const vendor = await resolveVendor(ctx, principal, str(input.vendor_name));
    if (isRefusal(vendor)) return vendor;

    const now = new Date();
    const backIn = parseDay(str(input.back_in_service), now);
    if (!backIn) return refusal('Say when the unit went back in service (a date).');
    if (backIn.getTime() > now.getTime() + 60_000) return refusal('Back in service cannot be in the future');
    const shopIn = str(input.shop_in) ? parseDay(str(input.shop_in), now) : null;
    if (str(input.shop_in) && !shopIn) return refusal('That shop-in date is not a date');
    if (shopIn && backIn.getTime() < shopIn.getTime()) return refusal('Back in service cannot be before the unit went into the shop');

    const rawLines = Array.isArray(input.lines) ? (input.lines as Record<string, unknown>[]) : [];
    const lines: CreateWorkOrderInput['lines'] = [];
    for (const l of rawLines) {
      const system = str(l.system ?? l.systemCode);
      if (!LINE_SYSTEMS[system]) return refusal(`Pick the system for each line (${Object.keys(LINE_SYSTEMS).join(', ')}).`);
      const amount = num(l.amount);
      if (amount === null || amount < 0) return refusal('Each line needs an amount in dollars (0 or more).');
      lines.push({ systemCode: system, description: (str(l.description) || (LINE_SYSTEMS[system] as string)).slice(0, 200), amount: Math.round(amount * 100) / 100 });
    }
    const total = num(input.invoice_total);
    if (total === null || total < 0) return refusal('Enter the invoice total');

    const workType: WorkType = (WORK_TYPES as readonly string[]).includes(str(input.work_type)) ? (str(input.work_type) as WorkType) : 'repair';
    const party = (WORK_ORDER_CHARGE_PARTIES as readonly string[]).includes(str(input.who_pays)) ? (str(input.who_pays) as CreateWorkOrderInput['chargeParty']) : 'company';
    const zero = (WORK_ORDER_ZERO_REASONS as readonly string[]).includes(str(input.zero_reason)) ? (str(input.zero_reason) as (typeof WORK_ORDER_ZERO_REASONS)[number]) : null;
    const terms = (WORK_ORDER_PAYMENT_TERMS as readonly string[]).includes(str(input.payment_terms)) ? (str(input.payment_terms) as (typeof WORK_ORDER_PAYMENT_TERMS)[number]) : null;
    const odometer = num(input.odometer);
    const title = (str(input.title) || WORK_TYPE_LABEL[workType]).slice(0, 160);

    const parsed = CreateWorkOrderSchema.safeParse({
      assetType: unit.kind,
      unitId: unit.id,
      status: 'completed',
      workType,
      title,
      shopInAt: shopIn?.toISOString(),
      completedAt: backIn.toISOString(),
      odometer: unit.kind === 'truck' && odometer !== null ? Math.round(odometer) : undefined,
      assignedTo: str(input.technician) || undefined,
      vendorId: vendor.id,
      vendorName: vendor.name,
      notes: str(input.notes) || undefined,
      lines,
      invoiceTotal: total,
      zeroReason: total === 0 ? zero : null,
      paymentTerms: total > 0 ? terms : null,
      invoiceFileIds: [],
      invoiceNumber: str(input.invoice_number) || null,
      warranty: party === 'warranty',
      chargeParty: party,
      chargeDriverId: null,
      driverInformed: party === 'driver' ? (typeof input.driver_informed === 'boolean' ? input.driver_informed : null) : null,
    });
    if (!parsed.success) return refusal(parsed.error.issues.map((i) => i.message).join('; '));
    const body = parsed.data;

    const wo = ctx.get(WorkOrdersService);
    // The oil change rules the server enforces (owner, 2026-10-18), said before the card.
    if (unit.kind === 'truck' && workType === 'oil_change') {
      if (body.odometer === undefined) return refusal('Enter the odometer (miles) at the oil change');
      const twin = await wo.oilChangeNear(principal.companyId, unit.id, backIn);
      if (twin) {
        return refusal(
          `This oil change is already recorded as ${twin.number} (${twin.completedAt ? fmtDay(twin.completedAt) : 'no date'}). Open it to correct it instead of adding another.`,
        );
      }
    }

    const existing = (await wo.list(principal, { unitId: unit.id })) as ListedOrder[];
    const dupAt = (shopIn ?? backIn).getTime();
    const dup = findDuplicate(existing, { vendorName: vendor.name, total, title, at: dupAt });
    const warnings: string[] = [];
    if (dup) {
      warnings.push(
        `This looks like ${dup.number}: it already records this repair on the same unit, at the same shop, ${fmtDay(dup.completedAt ?? dup.shopInAt ?? dup.createdAt)}. Save a second one only if it is really a separate repair.`,
      );
    }
    const linesTotal = lines.reduce((s, l) => s + l.amount, 0);
    if (Math.abs(linesTotal - total) > 0.005) warnings.push(`The lines add up to ${usd(Math.round(linesTotal * 100))}, not ${usd(Math.round(total * 100))}; it saves and is flagged for review.`);
    warnings.push('No invoice file is attached; it saves flagged "invoice missing" - attach it on the work order page.');
    if (party === 'driver' && body.driverInformed !== true) warnings.push('The driver has not been told: the charge is held until somebody records that they were.');

    return {
      ok: true,
      title: `Record a completed repair · ${unit.kind === 'truck' ? 'Truck' : 'Trailer'} ${unit.unitNumber}`,
      lines: [
        `Shop: ${vendor.name}`,
        `Back in service: ${fmtDay(backIn)}${shopIn ? ` (in the shop ${fmtDay(shopIn)})` : ''}`,
        `Work: ${WORK_TYPE_LABEL[workType]} - ${title}`,
        ...lines.map((l) => `• ${LINE_SYSTEMS[l.systemCode]}: ${l.description} - ${usd(Math.round(l.amount * 100))}`),
        `Invoice total: ${usd(Math.round(total * 100))}${body.invoiceNumber ? ` · invoice ${body.invoiceNumber}` : ''}${total === 0 && zero ? ` · ${zero.replace(/_/g, ' ')}` : ''}`,
        ...(body.odometer !== undefined ? [`Odometer: ${body.odometer.toLocaleString('en-US')} mi`] : []),
        `Who pays: ${WORK_ORDER_CHARGE_PARTY_LABEL[party]}${terms && total > 0 ? ` · ${WORK_ORDER_PAYMENT_TERMS_LABEL[terms]}` : ''}`,
        'Status: Completed',
      ],
      params: { body, unit, vendorName: vendor.name, duplicateSeen: dup?.id ?? null, dupAt },
      fingerprint: `repair_record:${unit.kind}:${unit.id}:${norm(vendor.name)}:${backIn.toISOString().slice(0, 10)}:${total.toFixed(2)}`,
      totalCents: Math.round(total * 100),
      destination: `${unit.kind === 'truck' ? 'Truck' : 'Trailer'} ${unit.unitNumber} · Repair log`,
      warnings,
    };
  },
  async run(ctx, principal, p) {
    const wo = ctx.get(WorkOrdersService);
    const existing = (await wo.list(principal, { unitId: p.unit.id })) as ListedOrder[];
    const dup = findDuplicate(existing, { vendorName: p.vendorName, total: p.body.invoiceTotal ?? null, title: p.body.title ?? '', at: p.dupAt });
    if (dup && dup.id !== p.duplicateSeen) {
      throw new StaleActionError(`${dup.number} was saved for this repair since the plan; open it instead of adding another.`);
    }
    const created = await wo.create(principal, p.body);
    return {
      text: `${created.number} recorded as completed on ${p.unit.kind} ${p.unit.unitNumber} (${p.vendorName}).`,
      cards: [orderLink(created), unitLink(p.unit)],
    };
  },
};

// -------------------------------------------------------------------------------- unit_in_shop

interface InShopParams {
  body: CreateWorkOrderInput;
  unit: UnitHit;
}

const unitInShop: ActionDef<InShopParams> = {
  name: 'unit_in_shop',
  description:
    'Put a truck or trailer in the shop: opens a work order with status "In the shop" (the unit is down until it is completed), like Create work order with status In the shop. Needs the unit number and the issue; shop/vendor, shop-in time, work type and stage are optional. A unit can have only one open shop visit.',
  input_schema: {
    type: 'object',
    properties: {
      unit_number: { type: 'string' },
      asset_type: { type: 'string', enum: ['truck', 'trailer'] },
      issue: { type: 'string', description: 'What is wrong, in a few words.' },
      vendor_name: { type: 'string', description: 'Optional: the shop that has it.' },
      shop_in: { type: 'string', description: 'Optional: when it went in (YYYY-MM-DD Eastern or ISO). Default now.' },
      work_type: { type: 'string', enum: [...WORK_TYPES], description: 'Default repair.' },
      stage: { type: 'string', enum: [...SHOP_STAGES], description: `Default diagnosing. ${SHOP_STAGES.map((s) => `${s} = ${SHOP_STAGE_LABEL[s]}`).join(', ')}.` },
      technician: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['unit_number', 'issue'],
  },
  permission: 'maintenance.edit',
  risk: 'confirm',
  async plan(ctx, principal, input) {
    const off = fleetFlagRefusal();
    if (off) return off;
    const kind = input.asset_type === 'truck' || input.asset_type === 'trailer' ? input.asset_type : null;
    const unit = await resolveUnit(ctx, principal, str(input.unit_number), kind);
    if (isRefusal(unit)) return unit;
    const issue = str(input.issue);
    if (!issue) return refusal('Say what is wrong with the unit.');
    const vendor = str(input.vendor_name) ? await resolveVendor(ctx, principal, str(input.vendor_name)) : null;
    if (isRefusal(vendor)) return vendor;
    const now = new Date();
    const shopIn = str(input.shop_in) ? parseDay(str(input.shop_in), now) : null;
    if (str(input.shop_in) && !shopIn) return refusal('That shop-in date is not a date');

    const wo = ctx.get(WorkOrdersService);
    const open = (await wo.list(principal, { unitId: unit.id, status: 'in_shop' })) as ListedOrder[];
    const sameKind = open.filter((o) => o.assetType === unit.kind);
    if (sameKind.length > 0) {
      const o = sameKind[0] as ListedOrder;
      return refusal(`${unit.kind === 'truck' ? 'Truck' : 'Trailer'} ${unit.unitNumber} is already in the shop on ${o.number} (since ${fmtDay(o.shopInAt)}). Add a note or change its stage there instead of opening another.`);
    }
    const workType: WorkType = (WORK_TYPES as readonly string[]).includes(str(input.work_type)) ? (str(input.work_type) as WorkType) : 'repair';
    const stage: ShopStage = (SHOP_STAGES as readonly string[]).includes(str(input.stage)) ? (str(input.stage) as ShopStage) : 'diagnosing';
    const parsed = CreateWorkOrderSchema.safeParse({
      assetType: unit.kind,
      unitId: unit.id,
      status: 'in_shop',
      workType,
      title: issue.slice(0, 160),
      shopStage: stage,
      shopInAt: shopIn?.toISOString(),
      assignedTo: str(input.technician) || undefined,
      vendorId: vendor?.id ?? null,
      vendorName: vendor?.name ?? undefined,
      notes: str(input.notes) || undefined,
      lines: [],
      invoiceFileIds: [],
      chargeParty: 'company',
    });
    if (!parsed.success) return refusal(parsed.error.issues.map((i) => i.message).join('; '));
    return {
      ok: true,
      title: `Put ${unit.kind} ${unit.unitNumber} in the shop`,
      lines: [
        `Issue: ${issue.slice(0, 160)}`,
        `Work: ${WORK_TYPE_LABEL[workType]} · stage ${SHOP_STAGE_LABEL[stage]}`,
        `Shop: ${vendor?.name ?? 'not named yet'}`,
        `In the shop since: ${shopIn ? fmtDay(shopIn) : 'now'}`,
        'The unit counts as down until the work order is completed.',
      ],
      params: { body: parsed.data, unit },
      fingerprint: `unit_in_shop:${unit.kind}:${unit.id}`,
      destination: `${unit.kind === 'truck' ? 'Truck' : 'Trailer'} ${unit.unitNumber}`,
    };
  },
  async run(ctx, principal, p) {
    const wo = ctx.get(WorkOrdersService);
    const open = ((await wo.list(principal, { unitId: p.unit.id, status: 'in_shop' })) as ListedOrder[]).filter((o) => o.assetType === p.unit.kind);
    if (open.length > 0) throw new StaleActionError(`${p.unit.kind} ${p.unit.unitNumber} went into the shop on ${open[0]?.number} since the plan.`);
    const created = await wo.create(principal, p.body);
    return { text: `${created.number} opened: ${p.unit.kind} ${p.unit.unitNumber} is in the shop.`, cards: [orderLink(created), unitLink(p.unit)] };
  },
};

// --------------------------------------------------------------------------- work_order_void

interface VoidParams {
  id: string;
  number: string;
  reason: string;
  expectedUpdatedAt: string;
}

const workOrderVoid: ActionDef<VoidParams> = {
  name: 'work_order_void',
  description:
    'Void a work order / repair entered by mistake (most often a duplicate), with a reason. The record stays, marked void, and leaves every list and total. Needs the work order number (e.g. RO-2026-1041) and the reason.',
  input_schema: {
    type: 'object',
    properties: {
      work_order_number: { type: 'string', description: 'e.g. RO-2026-1041' },
      reason: { type: 'string', description: 'Why it is being voided (at least 3 characters).' },
    },
    required: ['work_order_number', 'reason'],
  },
  permission: 'maintenance.edit',
  risk: 'confirm',
  async plan(ctx, principal, input) {
    const off = fleetFlagRefusal();
    if (off) return off;
    const raw = str(input.work_order_number).toUpperCase();
    const reason = str(input.reason);
    if (!raw) return refusal('Say which work order, e.g. RO-2026-1041.');
    if (reason.length < 3) return refusal('Say why it is being voided');
    const wo = ctx.get(WorkOrdersService);
    const all = (await wo.list(principal)) as ListedOrder[];
    let hits = all.filter((o) => o.number.toUpperCase() === raw);
    if (hits.length === 0) hits = all.filter((o) => o.number.toUpperCase().endsWith(raw.replace(/^RO-?/, '')));
    if (hits.length === 0) return refusal(`There is no work order ${raw} in this company (voided ones are not listed).`);
    if (hits.length > 1) return refusal(`${raw} matches ${hits.length} work orders: ${hits.slice(0, 5).map((o) => `${o.number} (${o.label})`).join('; ')}. Say the full number.`);
    const order = await wo.detail(principal, (hits[0] as ListedOrder).id);
    if (order.voided) return refusal(`${order.number} is already void`);
    if (order.status === 'in_shop') return refusal(`The unit is still in the shop on ${order.number}. Complete it first, then void it.`);
    if (order.charge.party === 'driver') return refusal(`${order.number} is charged to a driver. Change "Who pays" to the company first, so the driver's deduction is withdrawn.`);
    const total = (order as { invoiceTotal?: number | null }).invoiceTotal;
    return {
      ok: true,
      title: `Void ${order.number} · ${order.label}`,
      lines: [
        `Unit: ${order.assetType} ${order.unitNumber}${order.vendorName ? ` · ${order.vendorName}` : ''}`,
        `Status: ${order.status === 'completed' ? `Completed ${order.completedAt ? fmtDay(order.completedAt) : ''}` : 'Scheduled into a shop'}`,
        ...(typeof total === 'number' ? [`Invoice total: ${usd(Math.round(total * 100))}`] : []),
        `Reason: ${reason.slice(0, 400)}`,
        'The record stays, marked void; lists, spend and the dashboard stop counting it.',
      ],
      params: { id: order.id, number: order.number, reason: reason.slice(0, 400), expectedUpdatedAt: order.updatedAt },
      fingerprint: `work_order_void:${order.id}`,
      totalCents: typeof total === 'number' ? Math.round(total * 100) : null,
      destination: order.number,
      warnings: ['If the order is billed in Accounts Payable, the void is refused until that bill is voided.'],
    };
  },
  async run(ctx, principal, p) {
    const wo = ctx.get(WorkOrdersService);
    const now = await wo.detail(principal, p.id);
    if (now.voided) throw new StaleActionError(`${p.number} was voided since the plan.`);
    if (now.updatedAt !== p.expectedUpdatedAt) throw new StaleActionError(`${p.number} changed since the plan.`);
    const after = await wo.void(principal, p.id, { reason: p.reason });
    return { text: `${after.number} voided: ${p.reason}`, cards: [orderLink(after)] };
  },
};

// ------------------------------------------------------------------------- oil_change_record

interface OilParams {
  body: CompletePmInput;
  unit: UnitHit;
  vendorName: string;
  appointmentUpdatedAt: string | null;
  lastServiceId: string | null;
}

const oilChangeRecord: ActionDef<OilParams> = {
  name: 'oil_change_record',
  description:
    "Record a truck's oil change on the Oil change board (Record completion): the date, the odometer at the service, the shop, the invoice total and what was done (oil & filter always). It becomes the unit's new PM baseline and completes the unit's open oil-change appointment when there is one. When the odometer is far from the ELD's reading a reason is needed; a $0 total needs a zero reason.",
  input_schema: {
    type: 'object',
    properties: {
      unit_number: { type: 'string', description: 'The truck, e.g. 2702.' },
      service_date: { type: 'string', description: 'YYYY-MM-DD (Eastern) or ISO time it was done. Not in the future.' },
      odometer: { type: 'integer', description: 'Miles at the service.' },
      shop_name: { type: 'string', description: 'The shop, as listed on the Oil change board.' },
      invoice_total: { type: 'number', description: 'Dollars.' },
      work: { type: 'array', items: { type: 'string', enum: [...PM_WORK_ITEMS] }, description: `Default oil_filter. ${PM_WORK_ITEMS.map((w) => `${w} = ${PM_WORK_ITEM_LABEL[w].label}`).join(', ')}.` },
      other_lines: { type: 'array', items: lineSchema, description: 'Other work on the same invoice.' },
      invoice_number: { type: 'string' },
      zero_reason: { type: 'string', enum: [...PM_ZERO_REASONS] },
      odometer_reason: { type: 'string', description: "Why the odometer differs from the ELD's, when it does." },
    },
    required: ['unit_number', 'service_date', 'odometer', 'shop_name', 'invoice_total'],
  },
  permission: 'maintenance.edit',
  risk: 'confirm',
  async plan(ctx, principal, input) {
    if (!isFeatureEnabled('pm_module')) return refusal('The Oil change board is not switched on for this server (pm_module is off). Use repair_record with work type oil_change instead.');
    const unit = await resolveUnit(ctx, principal, str(input.unit_number), 'truck');
    if (isRefusal(unit)) return unit;
    const board = ctx.get(PmBoardService);
    const shops = await board.shops(principal);
    const shop = pickByName(shops, str(input.shop_name), 'shop', 'the Oil change board (Add shop)');
    if (isRefusal(shop)) return shop;
    const now = new Date();
    const serviceAt = parseDay(str(input.service_date), now);
    if (!serviceAt) return refusal('When was it done?');
    if (serviceAt.getTime() > now.getTime() + 5 * 60_000) return refusal('The service time is in the future');
    const odometer = num(input.odometer);
    if (odometer === null || odometer < 0) return refusal('Enter the odometer (miles) at the oil change');
    const total = num(input.invoice_total);
    if (total === null || total < 0) return refusal('Enter the invoice total');
    const work = Array.isArray(input.work) ? (input.work as unknown[]).map(str).filter((w) => (PM_WORK_ITEMS as readonly string[]).includes(w)) : [];
    if (!work.includes('oil_filter')) work.unshift('oil_filter');
    const otherLines: CompletePmInput['otherLines'] = [];
    for (const l of Array.isArray(input.other_lines) ? (input.other_lines as Record<string, unknown>[]) : []) {
      const system = str(l.system ?? l.systemCode);
      const amount = num(l.amount);
      if (!LINE_SYSTEMS[system] || amount === null || amount < 0) return refusal('Each other line needs a system and an amount.');
      otherLines.push({ systemCode: system, description: (str(l.description) || (LINE_SYSTEMS[system] as string)).slice(0, 200), amount });
    }

    const wo = ctx.get(WorkOrdersService);
    const orders = (await wo.list(principal, { unitId: unit.id })) as ListedOrder[];
    const appointment = orders.find((o) => o.assetType === 'truck' && o.pmServiceCode === 'OIL_CHANGE' && (o.status === 'scheduled' || o.status === 'in_shop')) ?? null;

    const parsed = CompletePmSchema.safeParse({
      unitId: unit.id,
      serviceCode: 'OIL_CHANGE',
      workOrderId: appointment?.id ?? null,
      serviceAt: serviceAt.toISOString(),
      serviceOdometer: Math.round(odometer),
      odometerReason: str(input.odometer_reason) || null,
      work,
      otherLines,
      vendorId: shop.id,
      invoiceTotal: total,
      zeroReason: total === 0 && (PM_ZERO_REASONS as readonly string[]).includes(str(input.zero_reason)) ? str(input.zero_reason) : null,
      invoiceNumber: str(input.invoice_number) || null,
      invoiceFileIds: [],
    });
    if (!parsed.success) return refusal(parsed.error.issues.map((i) => i.message).join('; '));
    const body = parsed.data;

    // The checks the board makes on save, said now (§6.2, §8, owner 2026-10-18).
    const eld = await board.nearestReading(principal.companyId, unit.id, serviceAt);
    const check = odometerCheck({ serviceOdometer: body.serviceOdometer, eldOdometer: eld?.odometerMiles ?? null, eldAt: eld?.readingAt.toISOString() ?? null });
    if (check.verdict === 'needs_reason' && !body.odometerReason?.trim()) {
      return refusal(`The odometer is ${check.gapMiles} miles from the ELD's ${eld?.odometerMiles}. Say why before saving.`);
    }
    const twin = await wo.oilChangeNear(principal.companyId, unit.id, serviceAt, appointment?.id);
    if (twin) return refusal(`This oil change is already recorded as ${twin.number}. Correct that one instead of adding another.`);
    if (body.invoiceNumber) {
      const dupInvoice = orders.find((o) => (o as { vendorId?: string | null }).vendorId === shop.id && (o as { invoiceNumber?: string | null }).invoiceNumber === body.invoiceNumber && o.id !== appointment?.id);
      if (dupInvoice) return refusal(`Invoice ${body.invoiceNumber} from ${shop.name} is already on ${dupInvoice.number}`);
    }
    const detail = await board.unitDetail(principal, unit.id);
    const warnings: string[] = ['No invoice file is attached; attach it from the oil change row afterwards.'];
    if (check.verdict === 'no_eld') warnings.push('There is no ELD reading near that time to check the odometer against.');
    return {
      ok: true,
      title: `Record an oil change · Truck ${unit.unitNumber}`,
      lines: [
        `Done: ${fmtDay(serviceAt)} at ${shop.name}`,
        `Odometer: ${body.serviceOdometer.toLocaleString('en-US')} mi${eld ? ` (ELD ${eld.odometerMiles.toLocaleString('en-US')} mi)` : ''}`,
        `Work: ${body.work.map((w) => PM_WORK_ITEM_LABEL[w].label).join(', ')}`,
        ...body.otherLines.map((l) => `• ${LINE_SYSTEMS[l.systemCode] ?? l.systemCode}: ${l.description} - ${usd(Math.round(l.amount * 100))}`),
        `Invoice total: ${usd(Math.round(total * 100))}${body.invoiceNumber ? ` · invoice ${body.invoiceNumber}` : ''}`,
        ...(appointment ? [`Completes the appointment ${appointment.number}.`] : []),
        "Becomes the unit's new oil change baseline.",
      ],
      params: { body, unit, vendorName: shop.name, appointmentUpdatedAt: appointment?.updatedAt ?? null, lastServiceId: detail.services[0]?.workOrderId ?? null },
      fingerprint: `oil_change_record:${unit.id}:${serviceAt.toISOString().slice(0, 10)}:${body.serviceOdometer}`,
      totalCents: Math.round(total * 100),
      destination: `Truck ${unit.unitNumber} · Oil change board`,
      warnings,
    };
  },
  async run(ctx, principal, p) {
    const board = ctx.get(PmBoardService);
    const wo = ctx.get(WorkOrdersService);
    const detail = await board.unitDetail(principal, p.unit.id);
    if ((detail.services[0]?.workOrderId ?? null) !== p.lastServiceId) {
      throw new StaleActionError(`Truck ${p.unit.unitNumber} has a newer oil change on record since the plan.`);
    }
    if (p.body.workOrderId) {
      const appt = await wo.detail(principal, p.body.workOrderId);
      if (appt.updatedAt !== p.appointmentUpdatedAt || appt.voided) throw new StaleActionError(`${appt.number} changed since the plan.`);
    }
    const { workOrder } = await board.complete(principal, p.body);
    return {
      text: `Oil change recorded for truck ${p.unit.unitNumber} at ${p.body.serviceOdometer.toLocaleString('en-US')} mi, ${p.vendorName} (${workOrder.number}).`,
      cards: [{ kind: 'link', label: 'Open the Oil change board', to: '/fleet/oil-change' }, orderLink(workOrder)],
    };
  },
};

// -------------------------------------------------------------------------------- pti_review

type PtiParams =
  | { what: 'approve_inspection'; inspectionId: string; unitNumber: string; weekStart: string; version: number; dispositions: { defectId: string; seen: DefectDisposition }[] }
  | { what: 'mark_defect_fixed'; defectId: string; defectNumber: string; unitNumber: string; version: number; fixedVia: FixedVia | null; note: string | null };

const ptiReview: ActionDef<PtiParams> = {
  name: 'pti_review',
  description:
    "PTI (walk-around video) review. what=approve_inspection: save a clean review (\"No issues\") of a truck's weekly PTI - every defect still open on the unit must be answered (still_present / looks_fixed / not_visible). what=mark_defect_fixed: mark an open defect (e.g. DEF-0012) fixed; it then waits for Safety to verify. Reviews that find new issues need screenshots and stay on the PTI page.",
  input_schema: {
    type: 'object',
    properties: {
      what: { type: 'string', enum: ['approve_inspection', 'mark_defect_fixed'] },
      unit_number: { type: 'string', description: 'approve_inspection: the truck.' },
      week_start: { type: 'string', description: "approve_inspection: the week's Monday YYYY-MM-DD; default the latest week." },
      open_defects: {
        type: 'array',
        description: 'approve_inspection: what the video showed for each defect still open on the unit.',
        items: {
          type: 'object',
          properties: { defect_number: { type: 'string' }, seen: { type: 'string', enum: [...DEFECT_DISPOSITIONS] } },
          required: ['defect_number', 'seen'],
        },
      },
      defect_number: { type: 'string', description: 'mark_defect_fixed: e.g. DEF-0012.' },
      fixed_via: { type: 'string', enum: [...FIXED_VIA], description: 'mark_defect_fixed: how it was fixed.' },
      note: { type: 'string' },
    },
    required: ['what'],
  },
  // The route takes maintenance.view; the service itself requires maintenance.edit or safety.manage.
  permission: 'maintenance.view',
  risk: 'confirm',
  async plan(ctx, principal, input) {
    const off = fleetFlagRefusal();
    if (off) return off;
    if (!hasPermission(principal, 'maintenance.edit') && !hasPermission(principal, 'safety.manage')) {
      return refusal('Missing permission: maintenance.edit or safety.manage');
    }
    const pti = ctx.get(PtiService);

    if (input.what === 'mark_defect_fixed') {
      const number = str(input.defect_number).toUpperCase();
      if (!number) return refusal('Say which defect, e.g. DEF-0012.');
      const open = await pti.listDefects(principal, { open: true });
      const hits = open.filter((d) => d.defectNumber.toUpperCase() === number || d.defectNumber.toUpperCase().endsWith(number.replace(/^DEF-?/, '')));
      if (hits.length === 0) return refusal(`${number} is not an open defect in this company.`);
      if (hits.length > 1) return refusal(`${number} matches ${hits.slice(0, 5).map((d) => `${d.defectNumber} (unit ${d.unitNumber})`).join('; ')}. Say the full number.`);
      const d = hits[0] as (typeof hits)[number];
      if (!canTransition(d.state as PtiDefectState, 'fixed_pending_verify')) {
        return refusal(`${d.defectNumber} cannot go from ${d.state} to fixed_pending_verify (it is ${PTI_DEFECT_STATE_LABEL[d.state]}).`);
      }
      const fixedVia = (FIXED_VIA as readonly string[]).includes(str(input.fixed_via)) ? (str(input.fixed_via) as FixedVia) : null;
      const note = str(input.note) || null;
      return {
        ok: true,
        title: `Mark ${d.defectNumber} fixed · unit ${d.unitNumber}`,
        lines: [
          `${d.componentName}: ${d.description.slice(0, 200)}`,
          `${PTI_DEFECT_STATE_LABEL[d.state]} → ${PTI_DEFECT_STATE_LABEL.fixed_pending_verify}`,
          ...(fixedVia ? [`Fixed via: ${fixedVia.replace(/_/g, ' ')}`] : []),
          ...(note ? [`Note: ${note.slice(0, 300)}`] : []),
          'Safety still verifies it before the hold lifts.',
        ],
        params: { what: 'mark_defect_fixed', defectId: d.id, defectNumber: d.defectNumber, unitNumber: d.unitNumber, version: d.version, fixedVia, note: note?.slice(0, 2000) ?? null },
        fingerprint: `pti_defect_fixed:${d.id}`,
        destination: `Unit ${d.unitNumber} · PTI`,
      };
    }

    if (input.what !== 'approve_inspection') return refusal('Say what to do: approve_inspection or mark_defect_fixed.');
    const unit = await resolveUnit(ctx, principal, str(input.unit_number), 'truck');
    if (isRefusal(unit)) return unit;
    const history = await pti.unitHistory(principal, unit.id, 12);
    const week = str(input.week_start);
    const entry = week ? history.find((h) => h.weekStart === week) : history[0];
    if (!entry) return refusal(week ? `Truck ${unit.unitNumber} has no PTI for the week of ${week}.` : `Truck ${unit.unitNumber} has no PTI on record yet; open the PTI page for this week first.`);
    const inspection = await pti.inspection(principal, entry.id);
    if (inspection.reviewState === 'reviewed') {
      return refusal(`The PTI of the week of ${inspection.weekStart} for truck ${unit.unitNumber} is already reviewed (${inspection.reviewResult === 'no_issues' ? 'no issues' : 'issues found'}${inspection.reviewerName ? `, by ${inspection.reviewerName}` : ''}).`);
    }
    const openDefects = await pti.listDefects(principal, { unitId: unit.id, open: true });
    const given = Array.isArray(input.open_defects) ? (input.open_defects as Record<string, unknown>[]) : [];
    const dispositions: { defectId: string; seen: DefectDisposition }[] = [];
    for (const g of given) {
      const n = str(g.defect_number).toUpperCase();
      const seen = str(g.seen);
      const d = openDefects.find((x) => x.defectNumber.toUpperCase() === n);
      if (!d) return refusal(`${n} is not an open defect on truck ${unit.unitNumber}.`);
      if (!(DEFECT_DISPOSITIONS as readonly string[]).includes(seen)) return refusal(`Say what the video showed for ${d.defectNumber}: ${DEFECT_DISPOSITIONS.join(', ')}.`);
      dispositions.push({ defectId: d.id, seen: seen as DefectDisposition });
    }
    const missing = openDefects.filter((d) => !dispositions.some((x) => x.defectId === d.id));
    if (missing.length > 0) {
      return refusal(
        `Say what this video showed for ${missing.map((d) => `${d.defectNumber} (${d.componentName}: ${d.description.slice(0, 60)})`).join(', ')} before saving a clean review - still_present, looks_fixed or not_visible.`,
      );
    }
    const warnings: string[] = [];
    if (!inspection.receivedAt) warnings.push('No video is marked received for this week.');
    if (inspection.inReviewBy && inspection.inReviewBy !== principal.userId) warnings.push(`${inspection.inReviewByName ?? 'Somebody else'} has this review open.`);
    return {
      ok: true,
      title: `Approve PTI · truck ${unit.unitNumber} · week of ${inspection.weekStart}`,
      lines: [
        'Result: No issues',
        `Driver: ${inspection.driverName ?? 'not recorded'}${inspection.receivedAt ? ` · received ${fmtDay(inspection.receivedAt)}` : ''}`,
        ...dispositions.map((x) => {
          const d = openDefects.find((o) => o.id === x.defectId);
          return `• ${d?.defectNumber}: ${DEFECT_DISPOSITION_LABEL[x.seen]}`;
        }),
      ],
      params: { what: 'approve_inspection', inspectionId: inspection.id, unitNumber: unit.unitNumber, weekStart: inspection.weekStart, version: inspection.version, dispositions },
      fingerprint: `pti_approve:${inspection.id}`,
      destination: `Truck ${unit.unitNumber} · PTI`,
      warnings,
    };
  },
  async run(ctx, principal, p) {
    const pti = ctx.get(PtiService);
    if (p.what === 'mark_defect_fixed') {
      const now = await pti.defect(principal, p.defectId);
      if (now.version !== p.version) throw new StaleActionError(`${p.defectNumber} changed since the plan.`);
      const input: TransitionDefectInput = {
        version: p.version,
        to: 'fixed_pending_verify',
        note: p.note,
        reason: null,
        fixedVia: p.fixedVia,
        workOrderId: null,
        workOrderNumber: null,
        ownerId: null,
      };
      const after = await pti.transition(principal, p.defectId, input);
      return { text: `${after.defectNumber} marked fixed on unit ${after.unitNumber}; it now waits for Safety to verify.`, cards: [{ kind: 'link', label: 'Open PTI', to: '/fleet/pti' }] };
    }
    const now = await pti.inspection(principal, p.inspectionId);
    if (now.version !== p.version) throw new StaleActionError(`The PTI of truck ${p.unitNumber} for the week of ${p.weekStart} changed since the plan.`);
    const input: ReviewInput = { version: p.version, result: 'no_issues', receivedAt: null, source: null, dispositions: p.dispositions, defects: [] };
    await pti.review(principal, p.inspectionId, input, easternToday());
    return { text: `PTI of truck ${p.unitNumber} (week of ${p.weekStart}) approved: no issues.`, cards: [{ kind: 'link', label: 'Open PTI', to: '/fleet/pti' }] };
  },
};

/** Wraps plan so a service refusal (NotFound, BadRequest, AppError) reads as the app's own words. */
function guarded<P>(def: ActionDef<P>): ActionDef<P> {
  return {
    ...def,
    async plan(ctx, principal, input) {
      try {
        return await def.plan(ctx, principal, input);
      } catch (e) {
        if (e instanceof StaleActionError) throw e;
        return refusal(errText(e));
      }
    },
  };
}

/** NeWay AI actions for fleet. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const FLEET_ACTIONS: ActionDef<any>[] = [
  guarded(repairRecord),
  guarded(unitInShop),
  guarded(oilChangeRecord),
  guarded(workOrderVoid),
  guarded(ptiReview),
];
