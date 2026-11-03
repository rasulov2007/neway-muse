import { Body, Controller, Get, Header, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  VoidWorkOrderSchema,
  type VoidWorkOrderInput,
  AddWorkOrderNoteSchema,
  type AddWorkOrderNoteInput,
  AttachInvoiceSchema,
  ChangeShopStageSchema,
  CheckInWorkOrderSchema,
  type CheckInWorkOrderInput,
  CompleteWorkOrderSchema,
  CreateWorkOrderSchema,
  SetWorkOrderChargeSchema,
  UpdateWorkOrderSchema,
  WorkOrderStatusSchema,
  type AttachInvoiceInput,
  type ChangeShopStageInput,
  type CompleteWorkOrderInput,
  type CreateWorkOrderInput,
  type SetWorkOrderChargeInput,
  type FleetToday,
  type UpdateWorkOrderInput,
  type WorkOrder,
  type WorkOrderDetail,
  type WorkOrderWithCost,
  MergeVendorSchema,
  type MergeVendorInput,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { FeatureFlagGuard } from '../../common/flags/feature-flag.guard';
import { RequireFlag } from '../../common/flags/require-flag.decorator';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequireAnyPermission, RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { FleetTodayService } from './fleet-today.service';
import { WorkOrdersService } from './work-orders.service';

/**
 * The shop floor's API.
 *
 * Every route here requires `maintenance.view` to read and `maintenance.edit` to write, and none
 * of them requires the cost permission — which is what lets a mechanic hold an account that can
 * work the queue and cannot see a price. The cost fields are added by the service only when the
 * principal holds `maintenance_costs.view`, so the omission is one decision in one place rather
 * than a rule every endpoint has to remember.
 *
 * The whole controller sits behind `fleet_v2`. A flag that only hides the page would leave every
 * one of these answering a direct request just as well as before, so with the flag off they are
 * 404: the feature does not exist on that server, for a browser or for curl.
 */
@Controller('fleet')
@RequireFlag('fleet_v2')
@UseGuards(FeatureFlagGuard, CompanyScopeGuard, PermissionGuard)
export class WorkOrdersController {
  constructor(
    private readonly workOrders: WorkOrdersService,
    private readonly todayBoard: FleetTodayService,
  ) {}

  /**
   * Everything the Today page shows, in one request.
   *
   * Computed server-side because the three sections are three different questions about the same
   * fleet, and a client assembling them from separate endpoints is a client that can show three
   * answers from three different moments.
   */
  @Get('today')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  today(
    @CurrentPrincipal() principal: Principal,
    @Query('today') today?: string,
  ): Promise<FleetToday> {
    // The board's day comes from the company's clock, not the browser's; a date may be passed for
    // a test or for looking at another day, and is validated by being parsed.
    const day = today && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : companyToday(principal);
    return this.todayBoard.today(principal, day);
  }

  /** The trailer a truck pulls now, for the tire work order (a guess the form lets you change). */
  @Get('units/:truckId/hooked-trailer')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  hookedTrailer(@CurrentPrincipal() principal: Principal, @Param('truckId') truckId: string) {
    return this.workOrders.hookedTrailer(principal, truckId);
  }

  /** Trucks or trailers, for the unit picker. Needs only the maintenance read permission. */
  @Get('units')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  units(
    @CurrentPrincipal() principal: Principal,
    @Query('assetType') assetType?: string,
  ): Promise<{ data: { id: string; unitNumber: string; description: string; odometer: number | null }[] }> {
    return this.workOrders.units(principal, assetType === 'trailer' ? 'trailer' : 'truck');
  }

  @Get('work-orders')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query('status') status?: string,
    @Query('unitId') unitId?: string,
  ): Promise<WorkOrder[] | WorkOrderWithCost[]> {
    const parsed = WorkOrderStatusSchema.safeParse(status);
    return this.workOrders.list(principal, {
      status: parsed.success ? parsed.data : undefined,
      unitId: unitId || undefined,
    });
  }

  /**
   * Which units are in the shop right now, and nothing else about the orders (owner, 2026-11-02:
   * Safety, without maintenance.view, read 108 Assigned where Fleet read 99 - the in-shop trucks
   * with a driver). Anyone who sees the units may know which of them are in the shop.
   */
  /** Trucks a lease operator drives: their invoices are optional (owner, 2026-11-03). */
  @Get('work-orders/lease-operator-units')
  @RequireAnyPermission('maintenance.view', 'trucks.view', 'trailers.view')
  @Header('Cache-Control', 'private, no-store')
  async leaseOperatorUnits(@CurrentPrincipal() principal: Principal): Promise<{ truckIds: string[] }> {
    return { truckIds: await this.workOrders.leaseOperatorTruckIds(principal.companyId) };
  }

  @Get('work-orders/in-shop-units')
  @RequireAnyPermission('maintenance.view', 'trucks.view', 'trailers.view')
  @Header('Cache-Control', 'private, no-store')
  inShopUnits(@CurrentPrincipal() principal: Principal): Promise<{ assetType: string; unitId: string }[]> {
    return this.workOrders.inShopUnits(principal);
  }

  /** One shop entered twice: its orders move to the record that stays (owner, 2026-10-14). */
  @Post('work-orders/merge-vendor')
  @RequirePermission('maintenance.edit')
  mergeVendor(@CurrentPrincipal() principal: Principal, @Body(new ZodValidationPipe(MergeVendorSchema)) body: MergeVendorInput) {
    return this.workOrders.mergeVendor(principal, body);
  }

  @Get('work-orders/:id')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  detail(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<WorkOrderDetail> {
    return this.workOrders.detail(principal, id);
  }

  @Post('work-orders')
  @RequirePermission('maintenance.edit')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(CreateWorkOrderSchema)) body: CreateWorkOrderInput,
  ): Promise<WorkOrder> {
    return this.workOrders.create(principal, body);
  }

  /**
   * Who pays - and the moment the driver is recorded as told, which is what lets accounting take
   * a driver charge off what that driver earned.
   */
  @Post('work-orders/:id/charge')
  @RequireAnyPermission('maintenance.edit', 'compliance.manage')
  setCharge(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SetWorkOrderChargeSchema)) body: SetWorkOrderChargeInput,
  ): Promise<WorkOrder> {
    return this.workOrders.setCharge(principal, id, body);
  }

  @Patch('work-orders/:id')
  @RequirePermission('maintenance.edit')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateWorkOrderSchema)) body: UpdateWorkOrderInput,
  ): Promise<WorkOrder> {
    return this.workOrders.update(principal, id, body);
  }

  /** A scheduled order taken into the shop (owner, 2026-10-30): the same record, now In the shop. */
  @Post('work-orders/:id/check-in')
  @RequirePermission('maintenance.edit')
  checkIn(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CheckInWorkOrderSchema)) body: CheckInWorkOrderInput,
  ): Promise<WorkOrderDetail> {
    return this.workOrders.checkIn(principal, id, body);
  }

  /** Only while the shop has the unit; the service refuses a stage on a completed record. */
  @Post('work-orders/:id/stage')
  @RequirePermission('maintenance.edit')
  changeStage(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ChangeShopStageSchema)) body: ChangeShopStageInput,
  ): Promise<WorkOrderDetail> {
    return this.workOrders.changeStage(principal, id, body);
  }

  @Post('work-orders/:id/complete')
  @RequirePermission('maintenance.edit')
  complete(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CompleteWorkOrderSchema)) body: CompleteWorkOrderInput,
  ): Promise<WorkOrderDetail> {
    return this.workOrders.complete(principal, id, body);
  }

  /**
   * Reopening a completed record.
   *
   * Needs `trucks.edit` on top of the maintenance permission, checked inside the service: a
   * completed work order has already moved money and reset a service clock, so undoing it is a
   * fleet manager's decision. It is logged either way.
   */
  @Post('work-orders/:id/note')
  @RequirePermission('maintenance.edit')
  addNote(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AddWorkOrderNoteSchema)) body: AddWorkOrderNoteInput,
  ): Promise<WorkOrderDetail> {
    return this.workOrders.addNote(principal, id, body);
  }

  @Post('work-orders/:id/invoice')
  @RequirePermission('maintenance.edit')
  attachInvoice(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AttachInvoiceSchema)) body: AttachInvoiceInput,
  ): Promise<WorkOrderDetail> {
    return this.workOrders.attachInvoice(principal, id, body);
  }

  /** Voids a work order entered by mistake; kept, marked, left out of every total. */
  @Post('work-orders/:id/void')
  @RequirePermission('maintenance.edit')
  voidOrder(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(VoidWorkOrderSchema)) body: VoidWorkOrderInput,
  ): Promise<WorkOrderDetail> {
    return this.workOrders.void(principal, id, body);
  }

  @Post('work-orders/:id/reopen')
  @RequirePermission('maintenance.edit')
  reopen(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: { note?: string },
  ): Promise<WorkOrderDetail> {
    return this.workOrders.reopen(principal, id, body?.note);
  }
}

/** Today in the company's timezone, which is the only day a due date may be judged against. */
function companyToday(principal: Principal): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: principal.companyTimezone || 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
