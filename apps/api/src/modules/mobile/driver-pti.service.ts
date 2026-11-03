import { Injectable } from '@nestjs/common';
import {
  DRIVER_PTI_STATE_LABEL,
  PTI_DEFECT_STATE_LABEL,
  driverPtiState,
  ptiDueDateOf,
  ptiWeekStartOf,
  type DriverPtiCurrent,
  type DriverPtiSubmitInput,
  type PtiInspection,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { PtiService } from '../fleet/pti.service';
import { LoadsService } from '../loads/loads.service';
import { companyDay, DriverContextService, type DriverContext } from './driver-context.service';

/**
 * The driver's weekly walk-around. The truck is the one the driver is assigned to on the server;
 * the inspection is that truck's row for this week (the same row Safety → PTI shows).
 */
@Injectable()
export class DriverPtiService {
  constructor(
    private readonly context: DriverContextService,
    private readonly pti: PtiService,
    private readonly loads: LoadsService,
  ) {}

  private today(ctx: DriverContext): string {
    return companyDay(ctx.companyTimezone, this.loads.clock());
  }

  async current(principal: Principal): Promise<DriverPtiCurrent> {
    const ctx = await this.context.resolve(principal);
    const today = this.today(ctx);
    const inspection = ctx.truck ? await this.pti.inspectionForUnit(principal, ctx.truck.id, today) : null;
    return this.view(principal, ctx, today, inspection);
  }

  async submit(principal: Principal, input: DriverPtiSubmitInput): Promise<DriverPtiCurrent> {
    const ctx = await this.context.resolve(principal);
    if (!ctx.truck) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'You have no truck assigned, so there is no walk-around to send. Call dispatch.' });
    }
    const today = this.today(ctx);
    const { inspection } = await this.pti.submitFromDriver(
      principal,
      {
        driverId: ctx.driverId,
        driverName: ctx.driverName,
        truckId: ctx.truck.id,
        truckUnit: ctx.truck.unitNumber,
        trailerId: ctx.trailer?.id ?? null,
        trailerUnit: ctx.trailer?.unitNumber ?? null,
      },
      input,
      today,
    );
    return this.view(principal, ctx, today, inspection);
  }

  private async view(principal: Principal, ctx: DriverContext, today: string, inspection: PtiInspection | null): Promise<DriverPtiCurrent> {
    const weekStart = ptiWeekStartOf(today);
    const defects = inspection ? await this.pti.defectsForInspection(principal, inspection.id) : [];
    const state = inspection ? driverPtiState(inspection) : 'not_submitted';
    const correction = inspection?.correction ?? null;
    return {
      weekStart,
      dueAt: ptiDueDateOf(weekStart),
      today,
      truck: ctx.truck ? { id: ctx.truck.id, unitNumber: ctx.truck.unitNumber } : null,
      trailer: ctx.trailer ? { id: ctx.trailer.id, unitNumber: ctx.trailer.unitNumber } : null,
      inspection: inspection
        ? {
            id: inspection.id,
            receiptStatus: inspection.receiptStatus,
            receivedAt: inspection.receivedAt,
            reviewState: inspection.reviewState,
            reviewResult: inspection.reviewResult,
            reviewerName: inspection.reviewerName,
            reviewedAt: inspection.reviewedAt,
            version: inspection.version,
          }
        : null,
      state,
      stateLabel: DRIVER_PTI_STATE_LABEL[state],
      correction,
      canSubmit: Boolean(inspection) && (state === 'not_submitted' || state === 'received' || state === 'correction_requested'),
      submission: inspection?.driverSubmission ?? null,
      history: inspection?.driverHistory ?? [],
      defects: defects.map((d) => ({
        id: d.id,
        defectNumber: d.defectNumber,
        component: d.component,
        componentName: d.componentName,
        description: d.description,
        state: d.state,
        stateLabel: PTI_DEFECT_STATE_LABEL[d.state],
        workOrderNumber: d.workOrderNumber,
      })),
      checklist: await this.pti.checklistTemplate(principal),
    };
  }
}
