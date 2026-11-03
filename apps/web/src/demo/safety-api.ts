/**
 * The Safety data boundary.
 *
 * This is the seam Phase 8 replaces. Every function here takes a query shaped like the API's — page,
 * pageSize, search, sort, filters — and returns a `ListResult`, so a real HTTP client can be
 * substituted behind the same signatures and nothing above this file changes. Pages never touch
 * `demoData` directly; they go through `useSafety`, which goes through here.
 *
 * Filtering and paging happen **in this function**, not in the page, for the same reason: when the
 * server does that work, the page's code is already written for it.
 */
import { demoData, isActiveStatus } from './data';
import { saveSoon } from './state-persist';
import {
  appendFleetAudit,
  cloneValue,
  fleetRespond,
  nowIsoString,
  type SimulateOptions,
} from './internals';
import type { ListResult } from './api';
import type {
  Accident,
  AccidentKind,
  Claim,
  CorrectiveAction,
  CorrectiveActionSubjectType,
  Defect,
  Inspection,
  Violation,
} from './safety-types';
import type { IsoDate } from './types';

// ---------------------------------------------------------------------------------------------
// Query shapes — deliberately server-shaped
// ---------------------------------------------------------------------------------------------

export interface SafetyQuery extends SimulateOptions {
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  sortDir?: 'asc' | 'desc';
  /** Restrict to an explicit id set, so an exception tile opens exactly what it counted. */
  ids?: string[];
  /** ISO date, inclusive. */
  from?: IsoDate;
  to?: IsoDate;
}

export interface InspectionQuery extends SafetyQuery {
  kind?: string;
  result?: 'pass' | 'fail';
  driverId?: string;
  assetId?: string;
  inspector?: string;
  outOfService?: boolean;
  /** A derived `InspectionState`; resolved against the engine by the caller. */
  state?: string;
}

export interface DefectQuery extends SafetyQuery {
  inspectionId?: string;
  assetId?: string;
  status?: string;
  severity?: string;
  source?: string;
}

export interface ViolationQuery extends SafetyQuery {
  category?: string;
  severity?: string;
  source?: string;
  driverId?: string;
  truckId?: string;
  state?: string;
  inspectionId?: string;
  contested?: boolean;
}

export interface AccidentQuery extends SafetyQuery {
  status?: string;
  severity?: string;
  kind?: string;
  driverId?: string;
  truckId?: string;
  preventable?: string;
  ownerId?: string;
  recordable?: boolean;
  withInjuries?: boolean;
}

export interface CorrectiveActionQuery extends SafetyQuery {
  subjectType?: CorrectiveActionSubjectType;
  subjectId?: string;
  assigneeId?: string;
  status?: string;
}

const MAX_PAGE = 200;

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function matches(haystack: Array<string | null | undefined>, needle: string): boolean {
  const q = normalize(needle);
  if (!q) return true;
  return haystack.some((v) => v !== null && v !== undefined && normalize(v).includes(q));
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

function page<T>(rows: T[], query: SafetyQuery): ListResult<T> {
  const pageNumber = Math.max(1, query.page ?? 1);
  const pageSize = Math.max(1, Math.min(MAX_PAGE, query.pageSize ?? 25));
  const start = (pageNumber - 1) * pageSize;
  return {
    data: cloneValue(rows.slice(start, start + pageSize)),
    total: rows.length,
    page: pageNumber,
    pageSize,
  };
}

function empty<T>(query: SafetyQuery): ListResult<T> {
  return { data: [], total: 0, page: Math.max(1, query.page ?? 1), pageSize: query.pageSize ?? 25 };
}

function withinRange(value: string, query: SafetyQuery): boolean {
  const day = value.slice(0, 10);
  if (query.from && day < query.from) return false;
  if (query.to && day > query.to) return false;
  return true;
}

function run<T extends object>(
  rows: T[],
  query: SafetyQuery,
  searchable: (row: T) => Array<string | null | undefined>,
  extra: (row: T) => boolean,
): Promise<ListResult<T>> {
  return fleetRespond(
    query,
    () => {
      let result = rows.filter(extra);
      if (query.ids && query.ids.length > 0) {
        const set = new Set(query.ids);
        result = result.filter((row) => set.has((row as { id: string }).id));
      }
      if (query.search)
        result = result.filter((row) => matches(searchable(row), query.search ?? ''));
      if (query.sort) {
        const key = query.sort as keyof T;
        result = [...result].sort((a, b) => compare(a[key], b[key]));
        if (query.sortDir === 'desc') result.reverse();
      }
      return page(result, query);
    },
    () => empty<T>(query),
  );
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export function listInspections(query: InspectionQuery = {}): Promise<ListResult<Inspection>> {
  return run(
    demoData.inspections,
    query,
    (i) => [
      i.inspectionNumber,
      i.unitNumber,
      i.driverName,
      i.inspector,
      i.inspectorAgency,
      i.reportNumber,
      i.location ? `${i.location.city} ${i.location.state}` : null,
    ],
    (i) =>
      (!query.kind || i.kind === query.kind) &&
      (!query.result || i.result === query.result) &&
      (!query.driverId || i.driverId === query.driverId) &&
      (!query.assetId || i.assetId === query.assetId) &&
      (!query.inspector || i.inspector === query.inspector) &&
      (query.outOfService === undefined || i.outOfService === query.outOfService) &&
      withinRange(i.at, query),
  );
}

export function getInspection(
  idOrNumber: string,
  options?: SimulateOptions,
): Promise<Inspection | null> {
  return fleetRespond(
    options,
    () => {
      const row = demoData.inspections.find(
        (i) => i.id === idOrNumber || i.inspectionNumber === idOrNumber,
      );
      return row ? cloneValue(row) : null;
    },
    () => null,
  );
}

export function listDefects(query: DefectQuery = {}): Promise<ListResult<Defect>> {
  return run(
    demoData.defects,
    query,
    (d) => [d.defectNumber, d.unitNumber, d.component, d.description, d.regulation],
    (d) =>
      (!query.inspectionId || d.inspectionId === query.inspectionId) &&
      (!query.assetId || d.assetId === query.assetId) &&
      (!query.status || d.status === query.status) &&
      (!query.severity || d.severity === query.severity) &&
      (!query.source || d.source === query.source) &&
      withinRange(d.reportedAt, query),
  );
}

export function listViolations(query: ViolationQuery = {}): Promise<ListResult<Violation>> {
  return run(
    demoData.violations,
    query,
    (v) => [
      v.violationNumber,
      v.driverName,
      v.unitNumber,
      v.code,
      v.description,
      v.citationNumber,
      v.location ? `${v.location.city} ${v.location.state}` : null,
    ],
    (v) =>
      (!query.category || v.category === query.category) &&
      (!query.severity || v.severity === query.severity) &&
      (!query.source || v.source === query.source) &&
      (!query.driverId || v.driverId === query.driverId) &&
      (!query.truckId || v.truckId === query.truckId) &&
      (!query.inspectionId || v.inspectionId === query.inspectionId) &&
      (query.contested === undefined || v.contested === query.contested) &&
      withinRange(v.onDate, query),
  );
}

export function getViolation(
  idOrNumber: string,
  options?: SimulateOptions,
): Promise<Violation | null> {
  return fleetRespond(
    options,
    () => {
      const row = demoData.violations.find(
        (v) => v.id === idOrNumber || v.violationNumber === idOrNumber,
      );
      return row ? cloneValue(row) : null;
    },
    () => null,
  );
}

export function listAccidents(query: AccidentQuery = {}): Promise<ListResult<Accident>> {
  return run(
    demoData.accidents,
    query,
    (a) => [
      a.accidentNumber,
      a.driverName,
      a.unitNumber,
      a.trailerUnit,
      a.loadNumber,
      a.description,
      a.policeReportNumber,
      `${a.location.city} ${a.location.state}`,
    ],
    (a) =>
      (!query.status || a.status === query.status) &&
      (!query.severity || a.severity === query.severity) &&
      (!query.kind || a.kind === query.kind) &&
      (!query.driverId || a.driverId === query.driverId) &&
      (!query.truckId || a.truckId === query.truckId) &&
      (!query.preventable || a.preventable === query.preventable) &&
      (!query.ownerId ||
        (query.ownerId === 'unassigned' ? a.ownerId === null : a.ownerId === query.ownerId)) &&
      (query.recordable === undefined || a.dotRecordable === query.recordable) &&
      (query.withInjuries === undefined || a.injuries.length > 0 === query.withInjuries) &&
      withinRange(a.at, query),
  );
}

export function getAccident(
  idOrNumber: string,
  options?: SimulateOptions,
): Promise<Accident | null> {
  return fleetRespond(
    options,
    () => {
      const row = demoData.accidents.find(
        (a) => a.id === idOrNumber || a.accidentNumber === idOrNumber,
      );
      return row ? cloneValue(row) : null;
    },
    () => null,
  );
}

export function listClaims(query: SafetyQuery = {}): Promise<ListResult<Claim>> {
  return run(
    demoData.claims,
    query,
    (c) => [c.claimNumber, c.accidentNumber, c.insurer, c.driverName, c.unitNumber],
    () => true,
  );
}

/**
 * One claim, by its id or by the number a person reads off a letter.
 *
 * Both, because a claim number is what somebody pastes out of an email while the id is what the
 * application holds — the same courtesy `getAccident` and `getViolation` already extend.
 */
export function getClaim(idOrNumber: string, options?: SimulateOptions): Promise<Claim | null> {
  return fleetRespond(
    options,
    () => {
      const row = demoData.claims.find((c) => c.id === idOrNumber || c.claimNumber === idOrNumber);
      return row ? cloneValue(row) : null;
    },
    () => null,
  );
}

export function listCorrectiveActions(
  query: CorrectiveActionQuery = {},
): Promise<ListResult<CorrectiveAction>> {
  return run(
    demoData.correctiveActions,
    query,
    (a) => [a.actionNumber, a.title, a.description, a.assigneeName, a.subjectLabel],
    (a) =>
      (!query.subjectType || a.subjectType === query.subjectType) &&
      (!query.subjectId || a.subjectId === query.subjectId) &&
      (!query.assigneeId || a.assigneeId === query.assigneeId) &&
      (!query.status || a.status === query.status),
  );
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

function nextNumber(rows: Array<{ id: string }>, prefix: string): { id: string; seq: number } {
  const highest = rows.reduce((max, row) => {
    const value = Number.parseInt(row.id.replace(/^[a-z]+_/, ''), 10);
    return Number.isNaN(value) ? max : Math.max(max, value);
  }, 0);
  const seq = highest + 1;
  return { id: `${prefix}_${String(seq).padStart(4, '0')}`, seq };
}

export interface CreateInspectionInput {
  assetId: string;
  kind: Inspection['kind'];
  at: string;
  inspector: string;
  inspectorAgency: string | null;
  driverId: string | null;
  trailerId: string | null;
  location: { city: string; state: string } | null;
  level: Inspection['level'];
  reportNumber: string | null;
  notes: string | null;
}

export function createInspection(
  input: CreateInspectionInput,
  options?: SimulateOptions,
): Promise<Inspection> {
  return fleetRespond(
    options,
    () => {
      const truck = demoData.trucks.find((t) => t.id === input.assetId);
      if (!truck) throw new Error('That unit is not in the fleet');
      const driver = input.driverId
        ? demoData.drivers.find((d) => d.id === input.driverId)
        : undefined;
      const trailer = input.trailerId
        ? demoData.trailers.find((t) => t.id === input.trailerId)
        : undefined;

      const { id, seq } = nextNumber(demoData.inspections, 'insp');
      const inspection: Inspection = {
        id,
        inspectionNumber: `INS-2026-${String(seq).padStart(4, '0')}`,
        assetType: 'truck',
        assetId: truck.id,
        unitNumber: truck.unitNumber,
        kind: input.kind,
        at: input.at,
        inspector: input.inspector.trim(),
        inspectorAgency: input.inspectorAgency?.trim() ? input.inspectorAgency.trim() : null,
        location: input.location,
        // A booked inspection has no result. Anything else would be a claim about work not done.
        result: null,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        driverId: driver?.id ?? null,
        driverName: driver?.name ?? null,
        trailerId: trailer?.id ?? null,
        trailerUnit: trailer?.unitNumber ?? null,
        odometer: truck.odometer,
        reportNumber: input.reportNumber?.trim() ? input.reportNumber.trim() : null,
        level: input.level,
        outOfService: false,
        notes: input.notes?.trim() ? input.notes.trim() : null,
      };

      demoData.inspections.unshift(inspection);
      appendFleetAudit({
        action: 'status_changed',
        entity: { type: 'truck', id: truck.id, label: `Unit ${truck.unitNumber}` },
        subject: 'Inspection',
        before: null,
        after: 'Scheduled',
        reason: `${inspection.inspectionNumber} booked for ${input.at.slice(0, 10)}`,
      });
      return cloneValue(inspection);
    },
    () => {
      throw new Error('Inspection could not be created');
    },
  );
}

export interface RecordInspectionResultInput {
  id: string;
  result: 'pass' | 'fail';
  completedAt?: string;
  odometer?: number | null;
  outOfService?: boolean;
  notes?: string | null;
}

export function recordInspectionResult(
  input: RecordInspectionResultInput,
  options?: SimulateOptions,
): Promise<{ ok: boolean; inspection: Inspection | null; blocked?: string }> {
  return fleetRespond(
    options,
    () => {
      const inspection = demoData.inspections.find((i) => i.id === input.id);
      if (!inspection) return { ok: false, inspection: null, blocked: 'That inspection is gone' };
      if (inspection.cancelledAt) {
        return {
          ok: false,
          inspection: cloneValue(inspection),
          blocked: 'A cancelled inspection cannot be given a result',
        };
      }

      const before = inspection.result;
      inspection.result = input.result;
      inspection.startedAt = inspection.startedAt ?? nowIsoString();
      inspection.completedAt = input.completedAt ?? nowIsoString();
      if (typeof input.odometer === 'number') inspection.odometer = input.odometer;
      if (input.outOfService !== undefined) inspection.outOfService = input.outOfService;
      if (input.notes !== undefined) inspection.notes = input.notes;

      // An out-of-service inspection takes the unit out of dispatch, exactly as it would at the
      // roadside. The fleet list and the safety desk cannot disagree about whether a unit can run.
      if (inspection.outOfService) {
        const truck = demoData.trucks.find((t) => t.id === inspection.assetId);
        if (truck && truck.status !== 'sold') truck.status = 'out_of_service';
      }

      appendFleetAudit({
        action: 'status_changed',
        entity: { type: 'truck', id: inspection.assetId, label: `Unit ${inspection.unitNumber}` },
        subject: 'Inspection result',
        before: before ?? 'Not performed',
        after: input.result === 'pass' ? 'Passed' : 'Failed',
        reason: `${inspection.inspectionNumber} recorded as ${input.result}${
          inspection.outOfService ? '; unit placed out of service' : ''
        }`,
      });

      return { ok: true, inspection: cloneValue(inspection) };
    },
    () => ({ ok: false, inspection: null, blocked: 'The result could not be recorded' }),
  );
}

export interface StartInspectionInput {
  id: string;
}

export function startInspection(
  input: StartInspectionInput,
  options?: SimulateOptions,
): Promise<{ ok: boolean; inspection: Inspection | null; blocked?: string }> {
  return fleetRespond(
    options,
    () => {
      const inspection = demoData.inspections.find((i) => i.id === input.id);
      if (!inspection) return { ok: false, inspection: null, blocked: 'That inspection is gone' };
      if (inspection.completedAt) {
        return {
          ok: false,
          inspection: cloneValue(inspection),
          blocked: 'That inspection has already been performed',
        };
      }
      inspection.startedAt = nowIsoString();
      inspection.cancelledAt = null;
      return { ok: true, inspection: cloneValue(inspection) };
    },
    () => ({ ok: false, inspection: null, blocked: 'The inspection could not be started' }),
  );
}

export interface CreateDefectInput {
  inspectionId: string | null;
  assetId: string;
  severity: Defect['severity'];
  component: string;
  description: string;
  regulation: string | null;
  dueOn: IsoDate | null;
  outOfService: boolean;
  notes: string | null;
}

export function createDefect(input: CreateDefectInput, options?: SimulateOptions): Promise<Defect> {
  return fleetRespond(
    options,
    () => {
      const truck = demoData.trucks.find((t) => t.id === input.assetId);
      if (!truck) throw new Error('That unit is not in the fleet');
      const { id, seq } = nextNumber(demoData.defects, 'def');
      const defect: Defect = {
        id,
        defectNumber: `DEF-${String(seq).padStart(4, '0')}`,
        assetType: 'truck',
        assetId: truck.id,
        unitNumber: truck.unitNumber,
        source: input.inspectionId ? 'inspection' : 'driver_report',
        inspectionId: input.inspectionId,
        severity: input.severity,
        component: input.component.trim(),
        description: input.description.trim(),
        regulation: input.regulation?.trim() ? input.regulation.trim() : null,
        status: 'open',
        repairOrderId: null,
        reportedAt: nowIsoString(),
        resolvedAt: null,
        dueOn: input.dueOn,
        outOfService: input.outOfService,
        notes: input.notes?.trim() ? input.notes.trim() : null,
      };
      demoData.defects.unshift(defect);

      if (input.outOfService && truck.status !== 'sold') {
        truck.status = 'out_of_service';
      }

      appendFleetAudit({
        action: 'item_updated',
        entity: { type: 'truck', id: truck.id, label: `Unit ${truck.unitNumber}` },
        subject: 'Defect',
        before: null,
        after: input.severity,
        reason: `${defect.defectNumber}: ${defect.description}`,
      });
      return cloneValue(defect);
    },
    () => {
      throw new Error('Defect could not be recorded');
    },
  );
}

export interface ResolveDefectInput {
  id: string;
  status: Defect['status'];
  repairOrderId?: string | null;
  notes?: string | null;
}

export function updateDefect(
  input: ResolveDefectInput,
  options?: SimulateOptions,
): Promise<{ ok: boolean; defect: Defect | null; blocked?: string }> {
  return fleetRespond(
    options,
    () => {
      const defect = demoData.defects.find((d) => d.id === input.id);
      if (!defect) return { ok: false, defect: null, blocked: 'That defect is gone' };
      const before = defect.status;
      defect.status = input.status;
      defect.resolvedAt = input.status === 'resolved' ? nowIsoString() : null;
      if (input.repairOrderId !== undefined) defect.repairOrderId = input.repairOrderId;
      if (input.notes !== undefined) defect.notes = input.notes;

      // Clearing the last out-of-service defect on a unit returns it to service; anything still
      // open keeps it parked.
      if (input.status === 'resolved' && defect.outOfService) {
        const stillBlocked = demoData.defects.some(
          (d) => d.assetId === defect.assetId && d.outOfService && d.status !== 'resolved',
        );
        const truck = demoData.trucks.find((t) => t.id === defect.assetId);
        if (!stillBlocked && truck && truck.status === 'out_of_service') {
          truck.status = 'available';
        }
      }

      appendFleetAudit({
        action: 'status_changed',
        entity: { type: 'truck', id: defect.assetId, label: `Unit ${defect.unitNumber}` },
        subject: 'Defect status',
        before,
        after: input.status,
        reason: `${defect.defectNumber}: ${defect.description}`,
      });
      return { ok: true, defect: cloneValue(defect) };
    },
    () => ({ ok: false, defect: null, blocked: 'The defect could not be updated' }),
  );
}

export interface CreateViolationInput {
  driverId: string | null;
  truckId: string | null;
  onDate: IsoDate;
  category: Violation['category'];
  code: string;
  description: string;
  severity: Violation['severity'];
  points: number | null;
  source: Violation['source'];
  inspectionId: string | null;
  location: { city: string; state: string } | null;
  citationNumber: string | null;
  issuingAgency: string | null;
  fineAmount: number | null;
  courtDate: IsoDate | null;
  notes: string | null;
}

export function createViolation(
  input: CreateViolationInput,
  options?: SimulateOptions,
): Promise<Violation> {
  return fleetRespond(
    options,
    () => {
      const driver = input.driverId
        ? demoData.drivers.find((d) => d.id === input.driverId)
        : undefined;
      const truck = input.truckId ? demoData.trucks.find((t) => t.id === input.truckId) : undefined;
      if (!driver && !truck) {
        throw new Error('A violation must name a driver, a unit, or both');
      }

      const { id, seq } = nextNumber(demoData.violations, 'vio');
      const violation: Violation = {
        id,
        violationNumber: `VIO-2026-${String(seq).padStart(4, '0')}`,
        driverId: driver?.id ?? null,
        driverName: driver?.name ?? null,
        truckId: truck?.id ?? null,
        unitNumber: truck?.unitNumber ?? null,
        onDate: input.onDate,
        category: input.category,
        code: input.code.trim(),
        description: input.description.trim(),
        severity: input.severity,
        // A company-recorded finding never went on a roadside report, so it carries no FMCSA
        // weight. Recording points against it would overstate the carrier's exposure.
        points: input.source === 'company' ? null : input.points,
        source: input.source,
        inspectionId: input.inspectionId,
        location: input.location,
        citationNumber: input.citationNumber?.trim() ? input.citationNumber.trim() : null,
        issuingAgency: input.issuingAgency?.trim() ? input.issuingAgency.trim() : null,
        fineAmount: input.fineAmount,
        courtDate: input.courtDate,
        disposition: null,
        contested: false,
        resolvedAt: null,
        notes: input.notes?.trim() ? input.notes.trim() : null,
      };

      demoData.violations.unshift(violation);
      appendFleetAudit({
        action: 'status_changed',
        entity: driver
          ? { type: 'driver', id: driver.id, label: driver.name }
          : { type: 'truck', id: truck?.id ?? '', label: `Unit ${truck?.unitNumber ?? ''}` },
        subject: 'Violation',
        before: null,
        after: input.severity,
        reason: `${violation.violationNumber} ${input.code}: ${input.description}`,
      });
      return cloneValue(violation);
    },
    () => {
      throw new Error('Violation could not be recorded');
    },
  );
}

export interface UpdateViolationInput {
  id: string;
  resolved?: boolean;
  contested?: boolean;
  disposition?: string | null;
  notes?: string | null;
  reason?: string | null;
}

export function updateViolation(
  input: UpdateViolationInput,
  options?: SimulateOptions,
): Promise<{ ok: boolean; violation: Violation | null; blocked?: string }> {
  return fleetRespond(
    options,
    () => {
      const violation = demoData.violations.find((v) => v.id === input.id);
      if (!violation) return { ok: false, violation: null, blocked: 'That violation is gone' };

      if (input.resolved === true) {
        const open = demoData.correctiveActions.filter(
          (a) =>
            a.subjectType === 'violation' &&
            a.subjectId === violation.id &&
            a.status !== 'completed' &&
            a.status !== 'cancelled',
        );
        if (open.length > 0) {
          return {
            ok: false,
            violation: cloneValue(violation),
            blocked: `${open.length} corrective action${open.length === 1 ? '' : 's'} against this violation ${open.length === 1 ? 'is' : 'are'} still open. Close ${open.length === 1 ? 'it' : 'them'} first.`,
          };
        }
      }

      const before = violation.resolvedAt ? 'Resolved' : violation.contested ? 'Disputed' : 'Open';
      if (input.resolved !== undefined) {
        violation.resolvedAt = input.resolved ? nowIsoString() : null;
      }
      if (input.contested !== undefined) violation.contested = input.contested;
      if (input.disposition !== undefined) violation.disposition = input.disposition;
      if (input.notes !== undefined) violation.notes = input.notes;

      appendFleetAudit({
        action: 'status_changed',
        entity: violation.driverId
          ? { type: 'driver', id: violation.driverId, label: violation.driverName ?? '' }
          : {
              type: 'truck',
              id: violation.truckId ?? '',
              label: `Unit ${violation.unitNumber ?? ''}`,
            },
        subject: 'Violation status',
        before,
        after: violation.resolvedAt ? 'Resolved' : violation.contested ? 'Disputed' : 'Open',
        reason: input.reason ?? `${violation.violationNumber} updated`,
      });
      return { ok: true, violation: cloneValue(violation) };
    },
    () => ({ ok: false, violation: null, blocked: 'The violation could not be updated' }),
  );
}

export interface ReportAccidentInput {
  at: string;
  driverId: string;
  truckId: string;
  trailerId: string | null;
  loadId: string | null;
  location: { city: string; state: string; highway: string | null };
  kind: AccidentKind;
  severity: Accident['severity'];
  description: string;
  weather: string | null;
  roadConditions: string | null;
  trafficConditions: string | null;
  fatalities: number;
  injuriesTreatedAway: number;
  towedFromScene: boolean;
  policeReportNumber: string | null;
  policeAgency: string | null;
}

export function reportAccident(
  input: ReportAccidentInput,
  options?: SimulateOptions,
): Promise<Accident> {
  return fleetRespond(
    options,
    () => {
      const driver = demoData.drivers.find((d) => d.id === input.driverId);
      const truck = demoData.trucks.find((t) => t.id === input.truckId);
      if (!driver) throw new Error('That driver is not on the roster');
      if (!truck) throw new Error('That unit is not in the fleet');
      const trailer = input.trailerId
        ? demoData.trailers.find((t) => t.id === input.trailerId)
        : undefined;
      const load = input.loadId ? demoData.loads.find((l) => l.id === input.loadId) : undefined;

      // Recordability is the federal definition applied to what was reported, not an opinion.
      const recordable =
        input.fatalities > 0 || input.injuriesTreatedAway > 0 || input.towedFromScene;

      const { id, seq } = nextNumber(demoData.accidents, 'acc');
      const accident: Accident = {
        id,
        accidentNumber: `ACC-2026-${String(seq).padStart(4, '0')}`,
        at: input.at,
        driverId: driver.id,
        driverName: driver.name,
        truckId: truck.id,
        unitNumber: truck.unitNumber,
        trailerId: trailer?.id ?? null,
        trailerUnit: trailer?.unitNumber ?? null,
        loadId: load?.id ?? null,
        loadNumber: load?.loadNumber ?? null,
        location: input.location,
        kind: input.kind,
        severity: input.severity,
        description: input.description.trim(),
        narrative: null,
        primaryCause: null,
        contributingFactors: [],
        weather: input.weather,
        roadConditions: input.roadConditions,
        trafficConditions: input.trafficConditions,
        // Nobody has decided this yet, and the system will not guess.
        preventable: 'undetermined',
        preventabilityDecidedBy: null,
        preventabilityDecidedAt: null,
        dotRecordable: recordable,
        injuries: [],
        fatalities: input.fatalities,
        towedFromScene: input.towedFromScene,
        policeReportNumber: input.policeReportNumber?.trim()
          ? input.policeReportNumber.trim()
          : null,
        policeAgency: input.policeAgency?.trim() ? input.policeAgency.trim() : null,
        damage: {
          truckRepairEstimate: null,
          truckRepairFinal: null,
          trailerRepairEstimate: null,
          trailerRepairFinal: null,
          cargoLossAmount: null,
          thirdPartyEstimate: null,
          propertyDamageEstimate: null,
          towingCost: null,
          storageCost: null,
          otherCost: null,
        },
        status: 'reported',
        ownerId: null,
        ownerName: null,
        investigationOpenedAt: null,
        investigationDueOn: null,
        rootCause: null,
        conclusion: null,
        closedAt: null,
        evidence: input.policeReportNumber ? ['police_report'] : [],
        claimId: null,
      };

      demoData.accidents.unshift(accident);
      appendFleetAudit({
        action: 'status_changed',
        entity: { type: 'driver', id: driver.id, label: driver.name },
        subject: 'Accident',
        before: null,
        after: 'Reported',
        reason: `${accident.accidentNumber} reported on unit ${truck.unitNumber}${
          recordable ? '; DOT recordable' : ''
        }`,
      });
      return cloneValue(accident);
    },
    () => {
      throw new Error('Accident could not be reported');
    },
  );
}

export interface UpdateAccidentInput {
  id: string;
  status?: Accident['status'];
  ownerId?: string | null;
  preventable?: Accident['preventable'];
  investigationDueOn?: IsoDate | null;
  narrative?: string | null;
  primaryCause?: string | null;
  contributingFactors?: string[];
  rootCause?: string | null;
  conclusion?: string | null;
  damage?: Partial<Accident['damage']>;
  addEvidence?: Accident['evidence'][number];
  reason?: string | null;
}

export function updateAccident(
  input: UpdateAccidentInput,
  options?: SimulateOptions,
): Promise<{ ok: boolean; accident: Accident | null; blocked?: string }> {
  return fleetRespond(
    options,
    () => {
      const accident = demoData.accidents.find((a) => a.id === input.id);
      if (!accident) return { ok: false, accident: null, blocked: 'That accident file is gone' };

      // Closing a file is the one transition with a standard to meet.
      if (input.status === 'closed') {
        const blockers: string[] = [];
        if ((input.preventable ?? accident.preventable) === 'undetermined') {
          blockers.push('preventability has not been decided');
        }
        const openActions = demoData.correctiveActions.filter(
          (a) =>
            a.subjectType === 'accident' &&
            a.subjectId === accident.id &&
            a.status !== 'completed' &&
            a.status !== 'cancelled',
        );
        if (openActions.length > 0) {
          blockers.push(
            `${openActions.length} corrective action${openActions.length === 1 ? '' : 's'} still open`,
          );
        }
        if (accident.dotRecordable) {
          const required = ['police_report', 'driver_statement', 'photos'] as const;
          const missing = required.filter((k) => !accident.evidence.includes(k));
          if (missing.length > 0) {
            blockers.push(
              `a DOT recordable file still needs its ${missing.map((m) => m.replace(/_/g, ' ')).join(' and ')}`,
            );
          }
        }
        if (blockers.length > 0) {
          return {
            ok: false,
            accident: cloneValue(accident),
            blocked: `This file cannot be closed yet: ${blockers.join('; ')}.`,
          };
        }
      }

      const before = accident.status;
      if (input.status) {
        accident.status = input.status;
        accident.closedAt = input.status === 'closed' ? nowIsoString() : null;
      }
      if (input.ownerId !== undefined) {
        const owner = input.ownerId
          ? demoData.users.find((u) => u.id === input.ownerId)
          : undefined;
        accident.ownerId = owner?.id ?? null;
        accident.ownerName = owner?.name ?? null;
        if (owner && !accident.investigationOpenedAt) {
          accident.investigationOpenedAt = nowIsoString();
        }
      }
      if (input.preventable !== undefined && input.preventable !== accident.preventable) {
        accident.preventable = input.preventable;
        accident.preventabilityDecidedBy =
          input.preventable === 'undetermined' ? null : (accident.ownerName ?? 'Safety');
        accident.preventabilityDecidedAt =
          input.preventable === 'undetermined' ? null : nowIsoString();
      }
      if (input.investigationDueOn !== undefined) {
        accident.investigationDueOn = input.investigationDueOn;
      }
      if (input.narrative !== undefined) accident.narrative = input.narrative;
      if (input.primaryCause !== undefined) accident.primaryCause = input.primaryCause;
      if (input.contributingFactors) accident.contributingFactors = input.contributingFactors;
      if (input.rootCause !== undefined) accident.rootCause = input.rootCause;
      if (input.conclusion !== undefined) accident.conclusion = input.conclusion;
      if (input.damage) accident.damage = { ...accident.damage, ...input.damage };
      if (input.addEvidence && !accident.evidence.includes(input.addEvidence)) {
        accident.evidence.push(input.addEvidence);
      }

      appendFleetAudit({
        action: 'status_changed',
        entity: { type: 'driver', id: accident.driverId, label: accident.driverName },
        subject: 'Accident file',
        before,
        after: accident.status,
        reason: input.reason ?? `${accident.accidentNumber} updated`,
      });

      return { ok: true, accident: cloneValue(accident) };
    },
    () => ({ ok: false, accident: null, blocked: 'The accident could not be updated' }),
  );
}

/**
 * A claim that did not come from an accident.
 *
 * Most claims do: a truck hits something and an insurer hears about it. But cargo soaked in a
 * trailer, a windscreen on the interstate, a theft off a yard — those are claims with no accident
 * behind them, and until now the only way to open one was to invent an accident that never
 * happened. Whatever context is known is carried; nothing is invented to fill the shape.
 */
export interface CreateStandaloneClaimInput {
  kind: Claim['kind'];
  insurer: string;
  description: string;
  reserveAmount: number | null;
  deductible: number | null;
  notes: string | null;
  /** Anything the claim is actually about, when it is known. */
  truckId?: string | null;
  driverId?: string | null;
  loadId?: string | null;
}

export function createStandaloneClaim(
  input: CreateStandaloneClaimInput,
  options?: SimulateOptions,
): Promise<Claim> {
  return fleetRespond(
    options,
    () => {
      const description = input.description.trim();
      if (!description) throw new Error('Say what the claim is for');
      const truck = input.truckId ? demoData.trucks.find((t) => t.id === input.truckId) : undefined;
      const driver = input.driverId
        ? demoData.drivers.find((d) => d.id === input.driverId)
        : undefined;
      const load = input.loadId ? demoData.loads.find((l) => l.id === input.loadId) : undefined;
      const { id, seq } = nextNumber(demoData.claims, 'clm');

      const claim: Claim = {
        id,
        claimNumber: `CLM-2026-${String(seq).padStart(4, '0')}`,
        // No accident, and the record says so rather than pointing at one that does not exist.
        accidentId: null,
        accidentNumber: null,
        kind: input.kind,
        insurer: input.insurer.trim(),
        insurerClaimNumber: null,
        status: 'draft',
        reserveAmount: input.reserveAmount,
        paidAmount: 0,
        deductible: input.deductible,
        description,
        driverId: driver?.id ?? load?.driverId ?? null,
        driverName: driver?.name ?? load?.driverName ?? null,
        truckId: truck?.id ?? load?.truckId ?? null,
        unitNumber: truck?.unitNumber ?? load?.truckUnit ?? null,
        trailerId: load?.trailerId ?? null,
        loadId: load?.id ?? null,
        loadNumber: load?.loadNumber ?? null,
        customerId: load?.customerId ?? null,
        customerName: load?.customerName ?? null,
        brokerId: load?.brokerId ?? null,
        brokerName: load?.brokerName ?? null,
        openedAt: nowIsoString(),
        closedAt: null,
        ownerId: null,
        ownerName: null,
        notes: input.notes?.trim() ? input.notes.trim() : null,
      };

      demoData.claims.unshift(claim);
      appendFleetAudit({
        action: 'status_changed',
        entity: {
          type: 'truck',
          id: claim.truckId ?? claim.id,
          label: claim.unitNumber ? `Unit ${claim.unitNumber}` : claim.claimNumber,
        },
        subject: 'Claim',
        before: null,
        after: 'Draft',
        reason: `${claim.claimNumber} opened with ${claim.insurer}`,
      });
      saveSoon();
      return cloneValue(claim);
    },
    () => {
      throw new Error('Claim could not be opened');
    },
  );
}

export interface CreateClaimFromAccidentInput {
  accidentId: string;
  kind: Claim['kind'];
  insurer: string;
  reserveAmount: number | null;
  deductible: number | null;
  notes: string | null;
}

/**
 * Opens a claim against an accident, inheriting everything the TMS already knows.
 *
 * Nothing the system holds is asked for again: driver, unit, trailer, load, customer, broker and
 * the damage estimate all come off the accident and the load it was running.
 */
export function createClaimFromAccident(
  input: CreateClaimFromAccidentInput,
  options?: SimulateOptions,
): Promise<Claim> {
  return fleetRespond(
    options,
    () => {
      const accident = demoData.accidents.find((a) => a.id === input.accidentId);
      if (!accident) throw new Error('That accident file is gone');
      if (accident.claimId) {
        const existing = demoData.claims.find((c) => c.id === accident.claimId);
        throw new Error(
          `${accident.accidentNumber} already has claim ${existing?.claimNumber ?? accident.claimId}`,
        );
      }

      const load = accident.loadId
        ? demoData.loads.find((l) => l.id === accident.loadId)
        : undefined;
      const { id, seq } = nextNumber(demoData.claims, 'clm');

      const claim: Claim = {
        id,
        claimNumber: `CLM-2026-${String(seq).padStart(4, '0')}`,
        accidentId: accident.id,
        accidentNumber: accident.accidentNumber,
        kind: input.kind,
        insurer: input.insurer.trim(),
        insurerClaimNumber: null,
        status: 'draft',
        reserveAmount: input.reserveAmount,
        paidAmount: 0,
        deductible: input.deductible,
        description: accident.description,
        driverId: accident.driverId,
        driverName: accident.driverName,
        truckId: accident.truckId,
        unitNumber: accident.unitNumber,
        trailerId: accident.trailerId,
        loadId: accident.loadId,
        loadNumber: accident.loadNumber,
        customerId: load?.customerId ?? null,
        customerName: load?.customerName ?? null,
        brokerId: load?.brokerId ?? null,
        brokerName: load?.brokerName ?? null,
        openedAt: nowIsoString(),
        closedAt: null,
        ownerId: accident.ownerId,
        ownerName: accident.ownerName,
        notes: input.notes?.trim() ? input.notes.trim() : null,
      };

      demoData.claims.unshift(claim);
      accident.claimId = claim.id;
      // The claim and the link back to the accident are both written now; the snapshot is what
      // keeps them across a refresh.
      saveSoon();

      appendFleetAudit({
        action: 'status_changed',
        entity: { type: 'driver', id: accident.driverId, label: accident.driverName },
        subject: 'Claim',
        before: null,
        after: 'Draft',
        reason: `${claim.claimNumber} opened against ${accident.accidentNumber} with ${input.insurer}`,
      });
      return cloneValue(claim);
    },
    () => {
      throw new Error('Claim could not be opened');
    },
  );
}

export interface CreateCorrectiveActionInput {
  subjectType: CorrectiveActionSubjectType;
  subjectId: string;
  subjectLabel: string;
  title: string;
  description: string;
  assigneeId: string | null;
  priority: CorrectiveAction['priority'];
  dueOn: IsoDate;
}

export function createCorrectiveAction(
  input: CreateCorrectiveActionInput,
  options?: SimulateOptions,
): Promise<CorrectiveAction> {
  return fleetRespond(
    options,
    () => {
      const assignee = input.assigneeId
        ? demoData.users.find((u) => u.id === input.assigneeId)
        : undefined;
      const { id, seq } = nextNumber(demoData.correctiveActions, 'cap');
      const action: CorrectiveAction = {
        id,
        actionNumber: `CAP-${String(seq).padStart(4, '0')}`,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        subjectLabel: input.subjectLabel,
        title: input.title.trim(),
        description: input.description.trim(),
        assigneeId: assignee?.id ?? null,
        assigneeName: assignee?.name ?? null,
        priority: input.priority,
        status: 'open',
        dueAt: `${input.dueOn}T17:00:00Z`,
        completedAt: null,
        resolution: null,
        createdAt: nowIsoString(),
        createdBy: 'Safety',
      };
      demoData.correctiveActions.unshift(action);
      return cloneValue(action);
    },
    () => {
      throw new Error('Corrective action could not be created');
    },
  );
}

export interface UpdateCorrectiveActionInput {
  id: string;
  status?: CorrectiveAction['status'];
  assigneeId?: string | null;
  resolution?: string | null;
  dueOn?: IsoDate;
}

export function updateCorrectiveAction(
  input: UpdateCorrectiveActionInput,
  options?: SimulateOptions,
): Promise<{ ok: boolean; action: CorrectiveAction | null; blocked?: string }> {
  return fleetRespond(
    options,
    () => {
      const action = demoData.correctiveActions.find((a) => a.id === input.id);
      if (!action) return { ok: false, action: null, blocked: 'That corrective action is gone' };

      if (input.status === 'completed' && !(input.resolution ?? action.resolution)) {
        return {
          ok: false,
          action: cloneValue(action),
          blocked: 'Record what was done before closing a corrective action.',
        };
      }

      if (input.status) {
        action.status = input.status;
        action.completedAt = input.status === 'completed' ? nowIsoString() : null;
      }
      if (input.assigneeId !== undefined) {
        const assignee = input.assigneeId
          ? demoData.users.find((u) => u.id === input.assigneeId)
          : undefined;
        action.assigneeId = assignee?.id ?? null;
        action.assigneeName = assignee?.name ?? null;
      }
      if (input.resolution !== undefined) action.resolution = input.resolution;
      if (input.dueOn) action.dueAt = `${input.dueOn}T17:00:00Z`;

      return { ok: true, action: cloneValue(action) };
    },
    () => ({ ok: false, action: null, blocked: 'The corrective action could not be updated' }),
  );
}

/** Loads still running on a driver, used before a status change that would stand them down. */
export function countDriverActiveLoads(driverId: string): number {
  return demoData.loads.filter((l) => l.driverId === driverId && isActiveStatus(l.status)).length;
}
