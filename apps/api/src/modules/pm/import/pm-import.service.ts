import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { dateInZone } from '@neway/shared';
import type { Principal } from '../../../common/auth/principal';
import { DatabaseService } from '../../../database/database.service';
import { vendors, workOrderLines, workOrders } from '../../../database/schema/fleet';
import { odometerReadings, pmPlans } from '../../../database/schema/pm';
import { companies, trucks } from '../../../database/schema/roster';
import { AuditService } from '../../people/audit.service';
import { PmService } from '../pm.service';
import { normalizeAddress } from './address-norm';
import { planPmImport, type ImportContext, type ImportPlan } from './plan';
import type { SheetRow } from './sheet';

/**
 * The importer's two halves: read what is on record into the plan's context, and apply a plan.
 *
 * Applying is the only write, and it is idempotent because the plan was built against what
 * exists: a service, a reading or a plan already on record is not made twice, and the same file
 * imported twice reports "unchanged". Nothing here creates a unit, a driver, an appointment or a
 * responsible person (04-sheet-import §6).
 */

export interface ImportOptions {
  exportedAt: Date | null;
  ownYardAddresses: string[];
  ownGroup?: string;
  fileName: string;
}

@Injectable()
export class PmImportService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly pm: PmService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async plan(principal: Principal, rows: SheetRow[], options: ImportOptions): Promise<ImportPlan> {
    const ctx = await this.context(principal.companyId, options);
    return planPmImport(rows, ctx);
  }

  private async context(companyId: string, options: ImportOptions): Promise<ImportContext> {
    const [company] = await this.db.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId)).limit(1);
    const timeZone = company?.timezone ?? 'America/New_York';
    const now = this.pm.clock();

    const fleet = await this.db
      .select({ id: trucks.id, unitNumber: trucks.unitNumber, groupName: trucks.groupName, pmResponsibility: trucks.pmResponsibility, lessorName: trucks.lessorName })
      .from(trucks)
      .where(eq(trucks.companyId, companyId));
    const units = new Map(fleet.map((t) => [t.unitNumber, t]));

    const vendorRows = await this.db
      .select({ id: vendors.id, name: vendors.name, addressNorm: vendors.addressNorm, isOwnYard: vendors.isOwnYard })
      .from(vendors)
      .where(and(eq(vendors.companyId, companyId), inArray(vendors.status, ['active', 'draft'])));
    const vendorMap = new Map<string, { id: string; name: string; isOwnYard: boolean }>();
    for (const v of vendorRows) if (v.addressNorm) vendorMap.set(v.addressNorm, { id: v.id, name: v.name, isOwnYard: v.isOwnYard });

    const serviceRows = await this.db
      .select({ unitId: workOrders.unitId, serviceAt: workOrders.serviceAt, serviceOdometer: workOrders.serviceOdometer })
      .from(workOrders)
      .where(and(eq(workOrders.companyId, companyId), eq(workOrders.pmServiceCode, 'OIL_CHANGE'), eq(workOrders.status, 'completed')));
    const services = new Set(
      serviceRows.filter((s) => s.serviceAt && s.serviceOdometer !== null).map((s) => `${s.unitId}|${dateInZone(s.serviceAt as Date, timeZone)}|${s.serviceOdometer}`),
    );

    const planRows = await this.db
      .select({ unitId: pmPlans.unitId, intervalMiles: pmPlans.intervalMiles })
      .from(pmPlans)
      .where(and(eq(pmPlans.companyId, companyId), eq(pmPlans.serviceCode, 'OIL_CHANGE'), eq(pmPlans.scope, 'unit'), isNull(pmPlans.voidedAt)));
    const unitPlans = new Map(planRows.filter((p) => p.unitId).map((p) => [p.unitId as string, p.intervalMiles]));

    const readingRows = await this.db
      .select({ unitId: odometerReadings.unitId, readingDate: odometerReadings.readingDate, odometerMiles: odometerReadings.odometerMiles, source: odometerReadings.source })
      .from(odometerReadings)
      .where(and(eq(odometerReadings.companyId, companyId), eq(odometerReadings.source, 'import')));
    const readings = new Set(readingRows.map((r) => `${r.unitId}|${r.readingDate}|${r.odometerMiles}|${r.source}`));

    return {
      units,
      vendors: vendorMap,
      services,
      unitPlans,
      readings,
      today: dateInZone(now, timeZone),
      importedAt: now,
      exportedAt: options.exportedAt,
      ownYardKeys: new Set(options.ownYardAddresses.map((a) => normalizeAddress(a).key).filter((k): k is string => k !== null)),
      timeZone,
      ownGroup: options.ownGroup ?? 'NWF',
    };
  }

  /** Writes the plan. Refuses a plan whose file did not parse. Recomputes every unit it touched. */
  async apply(principal: Principal, plan: ImportPlan, options: ImportOptions): Promise<{ vendorsCreated: number; servicesCreated: number; plansCreated: number; readingsCreated: number; unitsUpdated: number }> {
    if (plan.parseErrors.length > 0) throw new Error(`The file did not parse (${plan.parseErrors.length} row${plan.parseErrors.length === 1 ? '' : 's'}); nothing was written`);
    const companyId = principal.companyId;
    const now = this.pm.clock();
    const [company] = await this.db.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId)).limit(1);
    const timeZone = company?.timezone ?? 'America/New_York';

    let vendorsCreated = 0;
    let servicesCreated = 0;
    let plansCreated = 0;
    let readingsCreated = 0;
    let unitsUpdated = 0;
    const vendorIdByKey = new Map<string, { id: string; name: string }>();

    await this.db.transaction(async (tx) => {
      // 1 · shops: matched ones are reused, the rest become drafts for a person to confirm.
      for (const vendor of plan.vendors) {
        if (vendor.existingId) {
          vendorIdByKey.set(vendor.key, { id: vendor.existingId, name: vendor.name });
          continue;
        }
        const id = `ven_${crypto.randomUUID()}`;
        await tx.insert(vendors).values({
          id,
          companyId,
          name: vendor.name,
          kind: 'shop',
          addressLine: vendor.address.line,
          city: vendor.address.city,
          state: vendor.address.state,
          zip: vendor.address.zip,
          addressNorm: vendor.key,
          isOwnYard: vendor.isOwnYard,
          status: 'draft',
          source: 'import',
          createdAt: now,
          updatedAt: now,
        });
        vendorIdByKey.set(vendor.key, { id, name: vendor.name });
        vendorsCreated += 1;
      }

      // 2 · the units' group and responsibility, from the sheet's GROUP column.
      for (const change of plan.unitChanges) {
        if (change.unchanged) continue;
        await tx
          .update(trucks)
          .set({ groupName: change.groupName, pmResponsibility: change.pmResponsibility, lessorName: change.lessorName, updatedAt: now })
          .where(and(eq(trucks.id, change.unitId), eq(trucks.companyId, companyId)));
        unitsUpdated += 1;
      }

      // 3 · service records: one completed work order with one PM line, dated and priced as the sheet says.
      for (const service of plan.services) {
        const id = `wo_imp_${crypto.randomUUID()}`;
        const serviceAt = new Date(noon(service.serviceDate, timeZone));
        const vendor = service.vendorKey ? (vendorIdByKey.get(service.vendorKey) ?? null) : null;
        await tx.insert(workOrders).values({
          id,
          companyId,
          number: `RO-IMP-${service.unitNumber}-${service.serviceDate.replace(/-/g, '')}`,
          assetType: 'truck',
          unitId: service.unitId,
          unitNumber: service.unitNumber,
          status: 'completed',
          shopStage: null,
          workType: 'oil_change',
          workDone: 'Oil & filter change (PM A) — imported from the PM board',
          shopInAt: serviceAt,
          completedAt: serviceAt,
          downtimeMinutes: 0,
          odometer: service.serviceOdometer,
          vendorId: vendor?.id ?? null,
          vendorName: vendor?.name ?? '',
          total: service.amount === null ? '0' : service.amount.toFixed(2),
          invoiceTotal: service.amount === null ? null : service.amount.toFixed(2),
          invoiceDate: service.serviceDate,
          historic: true,
          flags: service.flags.filter((f) => f !== 'lease' && f !== 'reading_age_unknown'),
          createdBy: principal.userName ?? 'import',
          createdAt: now,
          updatedAt: now,
          pmServiceCode: 'OIL_CHANGE',
          serviceAt,
          serviceOdometer: service.serviceOdometer,
          enteredVia: 'import',
        });
        await tx.insert(workOrderLines).values({
          id: `wol_${crypto.randomUUID()}`,
          companyId,
          workOrderId: id,
          systemCode: 'pm.oil_change',
          lineKind: 'pm',
          description: 'Oil & filter change (PM A)',
          totalAmount: service.amount === null ? '0' : service.amount.toFixed(2),
          pmServiceCode: 'OIL_CHANGE',
          sort: 0,
          createdAt: now,
          updatedAt: now,
        });
        servicesCreated += 1;
      }

      // 4 · unit plans, superseding whatever was active.
      for (const p of plan.plans) {
        await tx
          .update(pmPlans)
          .set({ voidedAt: now, voidedBy: principal.userId, voidReason: 'superseded by import', updatedAt: now })
          .where(and(eq(pmPlans.companyId, companyId), eq(pmPlans.serviceCode, 'OIL_CHANGE'), eq(pmPlans.scope, 'unit'), eq(pmPlans.unitId, p.unitId), isNull(pmPlans.voidedAt)));
        await tx.insert(pmPlans).values({
          id: `pmp_${crypto.randomUUID()}`,
          companyId,
          serviceCode: 'OIL_CHANGE',
          scope: 'unit',
          unitId: p.unitId,
          intervalMiles: p.intervalMiles,
          reason: `imported from the PM board, ${dateInZone(now, timeZone)}`,
          setBy: principal.userId,
          setByName: principal.userName ?? principal.userId,
          setAt: now,
          createdAt: now,
          updatedAt: now,
        });
        plansCreated += 1;
      }

      // 5 · readings: the service odometer at the service date, the current one at the export time.
      for (const r of plan.readings) {
        const readingAt = new Date(r.readingAt);
        await tx.insert(odometerReadings).values({
          id: `odr_${crypto.randomUUID()}`,
          companyId,
          unitId: r.unitId,
          readingAt,
          readingDate: dateInZone(readingAt, timeZone),
          odometerMiles: r.odometerMiles,
          source: 'import',
          status: r.conflict ? 'conflict' : 'ok',
          conflictReason: r.conflict ? 'below_previous' : null,
          conflictWith: null,
          note: r.kind === 'service' ? 'LAST PM MILEAGE from the PM board' : r.ageUnknown ? 'CURRENT MILEAGE from the PM board; export time unknown' : 'CURRENT MILEAGE from the PM board',
          ageUnknown: r.ageUnknown,
          createdBy: principal.userId,
          createdByName: principal.userName ?? 'import',
          createdAt: now,
        });
        readingsCreated += 1;
      }
    });

    await this.audit.write(principal, {
      action: 'create',
      entityType: 'pm_import',
      entityId: `pmi_${now.getTime()}`,
      entityLabel: options.fileName,
      summary: `PM board imported: ${servicesCreated} services, ${plansCreated} intervals, ${readingsCreated} readings, ${vendorsCreated} draft vendors, ${unitsUpdated} units regrouped; ${plan.summary.skipped} rows skipped`,
      actorType: 'user',
    });

    const touched = [...new Set([...plan.services.map((s) => s.unitId), ...plan.plans.map((p) => p.unitId), ...plan.readings.map((r) => r.unitId), ...plan.unitChanges.map((u) => u.unitId)])];
    if (touched.length > 0) await this.pm.recompute(companyId, touched);

    return { vendorsCreated, servicesCreated, plansCreated, readingsCreated, unitsUpdated };
  }
}

function noon(date: string, timeZone: string): string {
  // A date the sheet gives without a time: noon in the company's zone keeps it on that day.
  const probe = new Date(`${date}T12:00:00Z`);
  const local = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).formatToParts(probe).find((p) => p.type === 'hour')?.value;
  const offsetHours = 12 - (Number(local) % 24);
  return new Date(probe.getTime() + offsetHours * 3_600_000).toISOString();
}
