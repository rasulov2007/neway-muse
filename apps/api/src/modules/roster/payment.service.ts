import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  maskNumber,
  type DriverPaymentDetails,
  type SaveDriverPaymentInput,
} from '@neway/shared';
import { AppError } from '../../common/errors/app-error';
import type { Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import { driverPaymentDetails } from '../../database/schema/roster';
import { FilesService } from '../files/files.service';
import { AuditService } from '../people/audit.service';
import { DriversService } from './drivers.service';

type Row = typeof driverPaymentDetails.$inferSelect;

/**
 * How a driver is paid (owner's brief, 2026-09-21).
 *
 * One row per driver. Account and routing numbers are written when given and served masked; the
 * audit entry records that a number changed, never the number. Saving is version-checked.
 */
@Injectable()
export class DriverPaymentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly drivers: DriversService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async get(principal: Principal, driverIdOrNumber: string): Promise<DriverPaymentDetails | null> {
    const driver = await this.drivers.get(principal, driverIdOrNumber);
    const row = await this.row(principal, driver.id);
    return row ? toDetails(row) : null;
  }

  async save(
    principal: Principal,
    driverIdOrNumber: string,
    input: SaveDriverPaymentInput,
  ): Promise<DriverPaymentDetails> {
    const driver = await this.drivers.get(principal, driverIdOrNumber);
    const before = await this.row(principal, driver.id);
    if (before && input.version !== null && before.version !== input.version) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'These payment details were changed by somebody else; reload and try again',
      });
    }
    const now = new Date();
    const by = principal.userName ?? principal.userId;
    const fields = {
      paymentMethod: input.paymentMethod,
      payeeName: input.payeeName,
      bankName: input.bankName,
      accountType: input.accountType,
      currency: input.currency,
      payFrequency: input.payFrequency,
      ...(input.routingNumber !== undefined ? { routingNumber: input.routingNumber } : {}),
      ...(input.accountNumber !== undefined ? { accountNumber: input.accountNumber } : {}),
      ...(input.authorizationFileId !== undefined
        ? {
            authorizationFileId: input.authorizationFileId,
            authorizationFileName: input.authorizationFileId
              ? (input.authorizationFileName ?? null)
              : null,
          }
        : {}),
      updatedBy: by,
      updatedAt: now,
    };
    if (before) {
      await this.db
        .update(driverPaymentDetails)
        .set({ ...fields, version: before.version + 1 })
        .where(eq(driverPaymentDetails.driverId, driver.id));
    } else {
      await this.db.insert(driverPaymentDetails).values({
        driverId: driver.id,
        companyId: principal.companyId,
        ...fields,
        createdAt: now,
      });
    }
    const changes: { field: string; old: string | null; new: string | null }[] = [];
    const track = (field: string, oldValue: string | null, newValue: string | null) => {
      if (oldValue !== newValue) changes.push({ field, old: oldValue, new: newValue });
    };
    track('paymentMethod', before?.paymentMethod ?? null, input.paymentMethod);
    track('payeeName', before?.payeeName ?? null, input.payeeName);
    track('bankName', before?.bankName ?? null, input.bankName);
    track('accountType', before?.accountType ?? null, input.accountType);
    track('currency', before?.currency ?? null, input.currency);
    track('payFrequency', before?.payFrequency ?? null, input.payFrequency);
    // The numbers themselves never reach the audit trail: only that they changed.
    if (input.routingNumber !== undefined && input.routingNumber !== before?.routingNumber)
      changes.push({ field: 'routingNumber', old: maskNumber(before?.routingNumber), new: maskNumber(input.routingNumber) });
    if (input.accountNumber !== undefined && input.accountNumber !== before?.accountNumber)
      changes.push({ field: 'accountNumber', old: maskNumber(before?.accountNumber), new: maskNumber(input.accountNumber) });
    if (input.authorizationFileId !== undefined && input.authorizationFileId !== (before?.authorizationFileId ?? null))
      changes.push({ field: 'authorization', old: before?.authorizationFileName ?? null, new: input.authorizationFileName ?? null });
    await this.audit.write(principal, {
      action: before ? 'update' : 'create',
      entityType: 'driver_payment',
      entityId: driver.id,
      entityLabel: driver.name,
      summary: `Payment details ${before ? 'updated' : 'set up'} for ${driver.name}`,
      changes,
    });
    const after = await this.row(principal, driver.id);
    if (!after) throw new AppError({ status: 500, title: 'Error', detail: 'Payment details did not save' });
    return toDetails(after);
  }

  private async row(principal: Principal, driverId: string): Promise<Row | null> {
    const [row] = await this.db
      .select()
      .from(driverPaymentDetails)
      .where(
        and(
          eq(driverPaymentDetails.companyId, principal.companyId),
          eq(driverPaymentDetails.driverId, driverId),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}

function toDetails(row: Row): DriverPaymentDetails {
  return {
    driverId: row.driverId,
    paymentMethod: row.paymentMethod as DriverPaymentDetails['paymentMethod'],
    payeeName: row.payeeName ?? null,
    bankName: row.bankName ?? null,
    accountType: (row.accountType as DriverPaymentDetails['accountType']) ?? null,
    routingNumberMasked: maskNumber(row.routingNumber),
    accountNumberMasked: maskNumber(row.accountNumber),
    currency: row.currency,
    payFrequency: row.payFrequency as DriverPaymentDetails['payFrequency'],
    authorization: row.authorizationFileId
      ? {
          fileId: row.authorizationFileId,
          fileName: row.authorizationFileName ?? 'Payment authorization',
          url: FilesService.urlFor(row.authorizationFileId),
        }
      : null,
    version: row.version,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}
