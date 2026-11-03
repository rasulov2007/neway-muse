import { BadRequestException, Body, Controller, Get, Header, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  AddLoadNoteSchema,
  AssignLoadSchema,
  AttachLoadDocumentSchema,
  ChangeStatusSchema,
  StopEventSchema,
  type AssignLoadInput,
  type AttachLoadDocumentInput,
  type ChangeStatusInput,
  type StopEventInput,
  CancelLoadSchema,
  CheckCallSchema,
  type CheckCallInput,
  ConfirmUploadSchema,
  PinLoadNoteSchema,
  DecideLoadChargeSchema,
  RemoveLoadDocumentSchema,
  ReviewDocumentSchema,
  type AddLoadNoteInput,
  type CancelLoadInput,
  type ConfirmUploadInput,
  type PinLoadNoteInput,
  type DecideLoadChargeInput,
  type RemoveLoadDocumentInput,
  type ReviewDocumentInput,
  type StoredLoad,
  type DriverLastDrop,
  ChooseRouteSchema,
  ClearRouteSchema,
  type ChooseRouteInput,
  type ClearRouteInput,
  type RouteOptionsResult,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequireAnyPermission, RequirePermission } from '../../common/auth/require-permission.decorator';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { LoadsService, type LoadWriteResponse } from './loads.service';
import { ROUTE_OPTION_ERRORS, RouteOptionsService } from './route-options.service';
import { AppError } from '../../common/errors/app-error';

const pipe = {
  // A booking arrives as the whole document; the rules inside the server decide what it must hold.
  create: new ZodValidationPipe(z.object({ loadNumber: z.string().trim().min(1) }).passthrough()),
  patch: new ZodValidationPipe(
    z.object({ expectedUpdatedAt: z.string().min(1), patch: z.record(z.string(), z.unknown()), summary: z.string().max(2000).nullish() }),
  ),
  cancel: new ZodValidationPipe(CancelLoadSchema),
  note: new ZodValidationPipe(AddLoadNoteSchema),
  pin: new ZodValidationPipe(PinLoadNoteSchema),
  review: new ZodValidationPipe(ReviewDocumentSchema),
  remove: new ZodValidationPipe(RemoveLoadDocumentSchema),
  decide: new ZodValidationPipe(DecideLoadChargeSchema),
  confirm: new ZodValidationPipe(ConfirmUploadSchema),
  checkCall: new ZodValidationPipe(CheckCallSchema),
} as const;

/**
 * The per-record writes a load accepts (docs/dispatch/00-plan.md, P0.1 and P0.5).
 *
 * Reads need `loads.view`; every write needs `loads.edit`. Cancelling after dispatch also needs
 * `dispatch.manage`, checked in the rule against the principal's own permissions - the screen
 * hides the button for people without it, and the server refuses them regardless.
 */
@Controller('loads')
@UseGuards(CompanyScopeGuard, PermissionGuard)
export class LoadsController {
  constructor(
    private readonly loads: LoadsService,
    private readonly routes: RouteOptionsService,
  ) {}

  /** Every load, newest first. `includeDemo=true` shows the seeded ones; nothing else does. */
  @Get()
  @RequirePermission('loads.view')
  @Header('Cache-Control', 'private, no-store')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query('includeDemo') includeDemo?: string,
  ): Promise<StoredLoad[]> {
    return this.loads.list(principal, { includeDemo: includeDemo === 'true' });
  }

  /** The highest load number used so far, hidden loads included, for the next booking's number. */
  @Get('highest-number')
  @RequirePermission('loads.view')
  @Header('Cache-Control', 'private, no-store')
  async highestNumber(@CurrentPrincipal() principal: Principal): Promise<{ highest: number }> {
    return { highest: await this.loads.highestNumber(principal) };
  }

  /** The driver's last drop, for the empty miles on Add load; `{ drop: null }` when they have none. */
  @Get('driver-last-drop')
  @RequirePermission('loads.view')
  @Header('Cache-Control', 'private, no-store')
  async driverLastDrop(
    @CurrentPrincipal() principal: Principal,
    @Query('driverId') driverId?: string,
    @Query('excludeLoadId') excludeLoadId?: string,
  ): Promise<{ drop: DriverLastDrop | null }> {
    const id = (driverId ?? '').trim();
    if (!id) throw new BadRequestException('driverId is required.');
    return { drop: await this.loads.driverLastDrop(principal, id, excludeLoadId?.trim() || null) };
  }

  @Get(':id')
  @RequirePermission('loads.view')
  @Header('Cache-Control', 'private, no-store')
  get(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<StoredLoad> {
    return this.loads.get(principal, id);
  }

  /** Booking: the screen builds the document, the server owns the write. */
  @Post()
  @RequirePermission('loads.create')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.create) body: Record<string, unknown>,
  ): Promise<LoadWriteResponse> {
    return this.loads.create(principal, body as unknown as StoredLoad);
  }

  /** Edit: the fields that changed, and nothing else. Status and assignment are refused here. */
  @Patch(':id')
  @RequirePermission('loads.edit')
  patch(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.patch) body: { expectedUpdatedAt: string; patch: Record<string, unknown>; summary?: string | null },
  ): Promise<LoadWriteResponse> {
    return this.loads.patch(principal, id, body);
  }

  /** Whether the signed-in person may cancel a load that is already dispatched. */
  @Get('me/lead')
  @RequirePermission('loads.view')
  @Header('Cache-Control', 'private, no-store')
  lead(@CurrentPrincipal() principal: Principal): { isLead: boolean } {
    return { isLead: this.loads.mayCancelAny(principal) };
  }

  @Post(':id/cancel')
  @RequirePermission('loads.edit')
  cancel(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.cancel) body: CancelLoadInput,
  ): Promise<LoadWriteResponse> {
    return this.loads.cancel(principal, id, body);
  }

  /** A status move: the load and the driver's board row change together or not at all. */
  @Post(':id/status')
  @RequirePermission('loads.edit')
  changeStatus(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ChangeStatusSchema)) body: ChangeStatusInput,
  ): Promise<LoadWriteResponse> {
    return this.loads.changeStatus(principal, id, body);
  }

  /** One stop arriving or leaving. Only the stop named moves. */
  @Post(':id/stop-event')
  @RequirePermission('loads.edit')
  stopEvent(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(StopEventSchema)) body: StopEventInput,
  ): Promise<LoadWriteResponse> {
    return this.loads.recordStopEvent(principal, id, body);
  }

  /** Driver, truck and trailer. */
  @Post(':id/assignment')
  @RequirePermission('loads.edit')
  assign(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AssignLoadSchema)) body: AssignLoadInput,
  ): Promise<LoadWriteResponse> {
    return this.loads.assign(principal, id, body);
  }

  /** File a document whose bytes are already in the store. Accounting files receipts too (owner, 2026-11-02). */
  @Post(':id/documents')
  @RequireAnyPermission('loads.edit', 'accounting.edit')
  attachDocument(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AttachLoadDocumentSchema)) body: AttachLoadDocumentInput,
  ): Promise<LoadWriteResponse> {
    return this.loads.attachDocument(principal, id, body);
  }

  @Post(':id/notes')
  @RequirePermission('loads.edit')
  addNote(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.note) body: AddLoadNoteInput,
  ): Promise<LoadWriteResponse> {
    return this.loads.addNote(principal, id, body);
  }

  @Post(':id/notes/pin')
  @RequirePermission('loads.edit')
  pinNote(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.pin) body: PinLoadNoteInput,
  ): Promise<LoadWriteResponse> {
    return this.loads.pinNote(principal, id, body);
  }

  /** Accept or drop a drafted detention, layover or other accessorial: Dispatch or Accounting (owner, 2026-11-02). */
  @Post(':id/charges/:chargeId/decide')
  @RequireAnyPermission('loads.edit', 'accounting.edit')
  decideCharge(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('chargeId') chargeId: string,
    @Body(pipe.decide) body: DecideLoadChargeInput,
  ): Promise<LoadWriteResponse> {
    return this.loads.decideCharge(principal, id, chargeId, body);
  }

  /** A file filed by mistake taken off the load (owner, 2026-11-02); a BOL or POD may take the step back. */
  @Post(':id/documents/:documentId/remove')
  @RequireAnyPermission('loads.edit', 'accounting.edit')
  removeDocument(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Body(pipe.remove) body: RemoveLoadDocumentInput,
  ): Promise<LoadWriteResponse> {
    return this.loads.removeDocument(principal, id, documentId, body);
  }

  @Post(':id/documents/:documentId/review')
  @RequirePermission('loads.edit')
  reviewDocument(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Body(pipe.review) body: ReviewDocumentInput,
  ): Promise<LoadWriteResponse> {
    return this.loads.reviewDocument(principal, id, documentId, body);
  }

  /** A check call or a new ETA (rule 1.4): the load was heard from; nothing moves. */
  @Post(':id/check-call')
  @RequirePermission('loads.edit')
  checkCall(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.checkCall) body: CheckCallInput,
  ): Promise<LoadWriteResponse> {
    return this.loads.checkCall(principal, id, body);
  }

  /**
   * Up to three roads for the load's stops from TollGuru, with tolls and fuel (owner,
   * 2026-10-27). Cached 24 h by the stop list and the fuel settings; `refresh: true` asks again.
   * TollGuru failing answers a message (not set up / no subscription / did not answer) and
   * changes nothing on the load.
   */
  @Post(':id/route-options')
  @RequirePermission('loads.edit')
  async routeOptions(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(z.object({ refresh: z.boolean().optional() }).passthrough())) body: { refresh?: boolean },
  ): Promise<RouteOptionsResult> {
    const load = await this.loads.get(principal, id);
    return this.routes.optionsFor(principal.companyId, load, { refresh: body?.refresh === true });
  }

  /** The road the dispatcher picked, by the id the options list gave it. */
  @Post(':id/route')
  @RequirePermission('loads.edit')
  async chooseRoute(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ChooseRouteSchema)) body: ChooseRouteInput,
  ): Promise<LoadWriteResponse> {
    const load = await this.loads.get(principal, id);
    const found = await this.routes.optionFor(principal.companyId, load, body.optionId);
    if (!found) {
      throw new AppError({ status: 422, title: 'That route is not on the list any more', detail: 'The stops or the fuel settings changed. Open the route options again and choose.', extensions: { code: 'unknown_option', hint: ROUTE_OPTION_ERRORS.no_routes } });
    }
    return this.loads.chooseRoute(principal, id, { expectedUpdatedAt: body.expectedUpdatedAt, option: found.option, settings: found.settings });
  }

  @Post(':id/route/clear')
  @RequirePermission('loads.edit')
  clearRoute(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ClearRouteSchema)) body: ClearRouteInput,
  ): Promise<LoadWriteResponse> {
    return this.loads.clearRoute(principal, id, body);
  }

  @Post(':id/confirm')
  @RequirePermission('loads.edit')
  confirmUpload(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.confirm) body: ConfirmUploadInput,
  ): Promise<LoadWriteResponse> {
    return this.loads.confirmUpload(principal, id, body);
  }
}
