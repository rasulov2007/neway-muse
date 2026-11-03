import { Body, Controller, Get, Header, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  ArchiveTruckSchema,
  AssignDriverTruckSchema,
  CreateDriverSchema,
  CreateTrailerSchema,
  CreateTruckSchema,
  ROSTER_DRIVER_STATUSES,
  ROSTER_TRAILER_STATUSES,
  RestoreDriverSchema,
  RestoreTruckSchema,
  SETTABLE_TRUCK_STATUSES,
  RosterQuerySchema,
  UpdateDriverSchema,
  UpdateTrailerSchema,
  UpdateTruckSchema,
  type ArchiveTruckRequest,
  type CreateDriverRequest,
  type CreateTrailerRequest,
  type CreateTruckRequest,
  type DriverRecord,
  type RestoreDriverRequest,
  type RestoreTruckRequest,
  type RosterPage,
  type RosterQuery,
  type TrailerRecord,
  type TruckRecord,
  type UpdateDriverRequest,
  type UpdateTrailerRequest,
  type UpdateTruckRequest,
  type DriverVacationList,
  type VacationRequestList,
  DecideVacationRequestSchema,
  type DecideVacationRequestInput,
  ConfirmTruckParkedSchema,
  type ConfirmTruckParkedInput,
  type DriverVacationView,
  StartVacationSchema,
  UpdateVacationSchema,
  RecordVacationReturnSchema,
  CancelVacationSchema,
  type StartVacationInput,
  type UpdateVacationInput,
  type RecordVacationReturnInput,
  type CancelVacationInput,
  PairDriversSchema,
  UnpairDriversSchema,
  type DriverTeamList,
  type DriverTeamStanding,
  type PairDriversInput,
  type UnpairDriversInput,
} from '@neway/shared';
import { z } from 'zod';
import {
  ChangeTruckVendorPercentSchema,
  type ChangeTruckVendorPercentRequest,
  EndTruckVendorSchema,
  MoveTruckToVendorSchema,
  type EndTruckVendorRequest,
  type MoveTruckToVendorRequest,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import {
  AssignDriverSchema,
  UploadAssignmentPhotoSchema,
  type AssignmentPhotoUpload,
  type UploadAssignmentPhotoInput,
  EndAssignmentSchema,
  VoidAssignmentSchema,
  SaveDriverPaymentSchema,
  type DriverPaymentDetails,
  type SaveDriverPaymentInput,
  UpdateAssignmentSchema,
  type AssignDriverInput,
  type EndAssignmentInput,
  type VoidAssignmentInput,
  type TruckAssignmentView,
  type UpdateAssignmentInput,
} from '@neway/shared';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { RequireAnyPermission, RequirePermission } from '../../common/auth/require-permission.decorator';
import { AssignmentsService } from './assignments.service';
import { DriverPaymentService } from './payment.service';
import { DriversService } from './drivers.service';
import { TrailersService } from './trailers.service';
import { TrucksService } from './trucks.service';
import { VacationsService } from './vacations.service';
import { TeamsService } from './teams.service';
import { StolenUnitsService } from '../state/stolen-units.service';
import { DRIVER_PICKER_PERMISSIONS, UNIT_PICKER_PERMISSIONS } from './roster-access';
import { maskDriver, maskDriverPage, maskVacationPhone, withoutHiddenDriverFields } from './driver-pii';

const rosterQueryPipe = new ZodValidationPipe(RosterQuerySchema);
const createTruckPipe = new ZodValidationPipe(CreateTruckSchema);
const updateTruckPipe = new ZodValidationPipe(UpdateTruckSchema);
const createTrailerPipe = new ZodValidationPipe(CreateTrailerSchema);
const updateTrailerPipe = new ZodValidationPipe(UpdateTrailerSchema);
const createDriverPipe = new ZodValidationPipe(CreateDriverSchema);
const updateDriverPipe = new ZodValidationPipe(UpdateDriverSchema);
const assignTruckPipe = new ZodValidationPipe(AssignDriverTruckSchema);
/** A status move carries nothing but the status, and each entity has its own set of legal ones. */
const statusPipe = {
  // `archived` is not here: archiving has its own route, with a reason and an audit line.
  truck: new ZodValidationPipe(z.object({ status: z.enum(SETTABLE_TRUCK_STATUSES) })),
  driver: new ZodValidationPipe(z.object({ status: z.enum(ROSTER_DRIVER_STATUSES), reason: z.string().trim().max(500).nullish() })),
  trailer: new ZodValidationPipe(z.object({ status: z.enum(ROSTER_TRAILER_STATUSES) })),
};

/**
 * Trucks and drivers.
 *
 * Both lists are company-scoped by the principal and never by anything the client sends; the
 * `CompanyScopeGuard` rejects a request that tries to choose its own company through the query
 * string. Nothing here deletes: a unit is sold and a driver is terminated, and both keep every
 * record that ever referenced them.
 */
@Controller()
// Permissions enforced here since 2026-10-17: the decorators below were not checked before.
@UseGuards(CompanyScopeGuard, PermissionGuard)
export class RosterController {
  constructor(
    private readonly trucks: TrucksService,
    private readonly vacations: VacationsService,
    private readonly teams: TeamsService,
    private readonly trailers: TrailersService,
    private readonly drivers: DriversService,
    private readonly assignments: AssignmentsService,
    private readonly payment: DriverPaymentService,
    private readonly stolen: StolenUnitsService,
  ) {}

  /**
   * A stolen truck's position reaches the administrator role only (owner decision): everyone else
   * gets the record with no location. Trailer records carry no location or free text.
   */
  private async hideStolenLocation(principal: Principal, records: TruckRecord[]): Promise<TruckRecord[]> {
    const hidden = await this.stolen.hiddenUnits(principal);
    if (hidden.size === 0) return records;
    return records.map((truck) => (hidden.has(truck.id) ? { ...truck, location: null } : truck));
  }

  // ---- how a driver is paid (2026-09-21): served masked, never revealed

  @Get('drivers/:idOrNumber/payment')
  @RequireAnyPermission('drivers.view', 'accounting.view')
  driverPayment(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrNumber') idOrNumber: string,
  ): Promise<DriverPaymentDetails | null> {
    return this.payment.get(principal, idOrNumber);
  }

  /**
   * Retired 2026-09-27: bank details are written once, sealed, through Accounting
   * (`PUT /accounting/payees`, permission accounting.bank). This stays so an old client gets a
   * clear answer instead of a silent plaintext write.
   */
  @Put('drivers/:idOrNumber/payment')
  @RequirePermission('drivers.edit')
  saveDriverPayment(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrNumber') idOrNumber: string,
    @Body(new ZodValidationPipe(SaveDriverPaymentSchema)) body: SaveDriverPaymentInput,
  ): Promise<DriverPaymentDetails> {
    void principal;
    void idOrNumber;
    void body;
    throw new AppError({ status: 410, title: 'Gone', detail: 'Bank details moved to Accounting > Settlements > Payee (sealed storage). This route no longer writes.' });
  }

  // ---- who is in the truck, since when, and what went with it (2026-09-21)

  @Get('trucks/:idOrUnit/assignment')
  @RequireAnyPermission('trucks.view', 'drivers.view', 'truck_assignment.edit')
  truckAssignment(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrUnit') idOrUnit: string,
  ): Promise<TruckAssignmentView> {
    return this.assignments.view(principal, idOrUnit);
  }

  @Post('trucks/:idOrUnit/assignment')
  @RequireAnyPermission('trucks.edit', 'truck_assignment.edit')
  assignDriver(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrUnit') idOrUnit: string,
    @Body(new ZodValidationPipe(AssignDriverSchema)) body: AssignDriverInput,
  ): Promise<TruckAssignmentView> {
    return this.assignments.assign(principal, idOrUnit, body);
  }

  /** One pickup or drop photo, stored before the assign/unassign/edit that links it (0047). */
  @Post('trucks/:idOrUnit/assignment/photos')
  @RequireAnyPermission('trucks.edit', 'truck_assignment.edit')
  uploadAssignmentPhoto(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrUnit') idOrUnit: string,
    @Body(new ZodValidationPipe(UploadAssignmentPhotoSchema)) body: UploadAssignmentPhotoInput,
  ): Promise<AssignmentPhotoUpload> {
    return this.assignments.uploadPhoto(principal, idOrUnit, body);
  }

  @Patch('trucks/:idOrUnit/assignment/:id')
  @RequireAnyPermission('trucks.edit', 'truck_assignment.edit')
  updateAssignment(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrUnit') idOrUnit: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateAssignmentSchema)) body: UpdateAssignmentInput,
  ): Promise<TruckAssignmentView> {
    return this.assignments.update(principal, idOrUnit, id, body);
  }

  @Post('trucks/:idOrUnit/assignment/:id/end')
  @RequireAnyPermission('trucks.edit', 'truck_assignment.edit')
  endAssignment(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrUnit') idOrUnit: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(EndAssignmentSchema)) body: EndAssignmentInput,
  ): Promise<TruckAssignmentView> {
    return this.assignments.end(principal, idOrUnit, id, body);
  }

  @Post('trucks/:idOrUnit/assignment/:id/void')
  @RequireAnyPermission('trucks.edit', 'truck_assignment.edit')
  voidAssignment(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrUnit') idOrUnit: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(VoidAssignmentSchema)) body: VoidAssignmentInput,
  ): Promise<TruckAssignmentView> {
    return this.assignments.void(principal, idOrUnit, id, body);
  }

  // ---- trailers: the same table the work orders, inspections and the Ditat import all use

  @RequireAnyPermission(...UNIT_PICKER_PERMISSIONS)
  @Get('trailers')
  listTrailers(
    @CurrentPrincipal() principal: Principal,
    @Query(rosterQueryPipe) query: RosterQuery,
  ): Promise<RosterPage<TrailerRecord>> {
    return this.trailers.list(principal, query);
  }

  @RequireAnyPermission(...UNIT_PICKER_PERMISSIONS)
  @Get('trailers/:idOrUnit')
  getTrailer(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrUnit') idOrUnit: string,
  ): Promise<TrailerRecord> {
    return this.trailers.get(principal, idOrUnit);
  }

  @Post('trailers')
  @RequirePermission('trailers.edit')
  createTrailer(
    @CurrentPrincipal() principal: Principal,
    @Body(createTrailerPipe) body: CreateTrailerRequest,
  ): Promise<TrailerRecord> {
    return this.trailers.create(principal, body);
  }

  @Patch('trailers/:idOrUnit')
  @RequirePermission('trailers.edit')
  updateTrailer(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrUnit') idOrUnit: string,
    @Body(updateTrailerPipe) body: UpdateTrailerRequest,
  ): Promise<TrailerRecord> {
    return this.trailers.update(principal, idOrUnit, body);
  }

  @Post('trailers/:idOrUnit/status')
  @RequirePermission('trailers.edit')
  setTrailerStatus(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrUnit') idOrUnit: string,
    @Body(statusPipe.trailer) body: { status: TrailerRecord['status'] },
  ): Promise<TrailerRecord> {
    return this.trailers.update(principal, idOrUnit, { status: body.status });
  }

  @RequireAnyPermission(...UNIT_PICKER_PERMISSIONS)
  @Get('trucks')
  async listTrucks(
    @CurrentPrincipal() principal: Principal,
    @Query(rosterQueryPipe) query: RosterQuery,
  ): Promise<RosterPage<TruckRecord>> {
    const page = await this.trucks.list(principal, query);
    return { ...page, data: await this.hideStolenLocation(principal, page.data) };
  }

  @RequireAnyPermission(...UNIT_PICKER_PERMISSIONS)
  @Get('trucks/:idOrUnit')
  async getTruck(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrUnit') idOrUnit: string,
  ): Promise<TruckRecord> {
    const [truck] = await this.hideStolenLocation(principal, [await this.trucks.get(principal, idOrUnit)]);
    return truck as TruckRecord;
  }

  @Post('trucks')
  @RequireAnyPermission('trucks.create', 'trucks.edit')
  createTruck(
    @CurrentPrincipal() principal: Principal,
    @Body(createTruckPipe) body: CreateTruckRequest,
  ): Promise<TruckRecord> {
    return this.trucks.create(principal, body);
  }

  @Patch('trucks/:idOrUnit')
  @RequirePermission('trucks.edit')
  updateTruck(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrUnit') idOrUnit: string,
    @Body(updateTruckPipe) body: UpdateTruckRequest,
  ): Promise<TruckRecord> {
    return this.trucks.update(principal, idOrUnit, body);
  }

  @Post('trucks/:idOrUnit/status')
  @RequirePermission('trucks.edit')
  setTruckStatus(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrUnit') idOrUnit: string,
    @Body(statusPipe.truck) body: { status: TruckRecord['status'] },
  ): Promise<TruckRecord> {
    return this.trucks.setStatus(principal, idOrUnit, body.status);
  }

  /**
   * Archives a truck (owner, 2026-10-05): hidden from every list, picker and count of the current
   * fleet, kept, reversible, audited. Body: { reason, expectedUpdatedAt } - the truck's updatedAt
   * as read; a stale one is a 409.
   */
  @Post('trucks/:idOrUnit/archive')
  @RequirePermission('trucks.edit')
  archiveTruck(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrUnit') idOrUnit: string,
    @Body(new ZodValidationPipe(ArchiveTruckSchema)) body: ArchiveTruckRequest,
  ): Promise<TruckRecord> {
    return this.trucks.archive(principal, idOrUnit, body.reason, body.expectedUpdatedAt);
  }

  /** Vendor truck owners on file, for Move to vendor (owner, 2026-10-28). */
  @Get('truck-vendors')
  @RequirePermission('trucks.edit')
  truckVendors(@CurrentPrincipal() principal: Principal): Promise<Array<{ id: string; name: string }>> {
    return this.trucks.vendorOwners(principal);
  }

  /** A truck owner's name corrected (owner, 2026-10-30). Body: { name, expectedName }. */
  @Post('truck-vendors/:vendorId/rename')
  @RequirePermission('trucks.edit')
  renameTruckVendor(
    @CurrentPrincipal() principal: Principal,
    @Param('vendorId') vendorId: string,
    @Body(new ZodValidationPipe(z.object({ name: z.string().min(1).max(120), expectedName: z.string() }))) body: { name: string; expectedName: string },
  ): Promise<{ id: string; name: string }> {
    return this.trucks.renameVendorOwner(principal, vendorId, body);
  }

  /** Move to vendor: whose truck it is from a day on, and what the company keeps of its gross. */
  @Post('trucks/:idOrUnit/vendor')
  @RequirePermission('trucks.edit')
  moveTruckToVendor(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrUnit') idOrUnit: string,
    @Body(new ZodValidationPipe(MoveTruckToVendorSchema)) body: MoveTruckToVendorRequest,
  ): Promise<TruckRecord> {
    return this.trucks.moveToVendor(principal, idOrUnit, body);
  }

  /** Edit percentage: what the company keeps of a vendor truck's gross, from a day on. */
  @Post('trucks/:idOrUnit/vendor/percent')
  @RequirePermission('trucks.edit')
  changeTruckVendorPercent(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrUnit') idOrUnit: string,
    @Body(new ZodValidationPipe(ChangeTruckVendorPercentSchema)) body: ChangeTruckVendorPercentRequest,
  ): Promise<TruckRecord> {
    return this.trucks.changeVendorPercent(principal, idOrUnit, body);
  }

  /** Move back to the company: the vendor arrangement ends on the day given. */
  @Post('trucks/:idOrUnit/vendor/end')
  @RequirePermission('trucks.edit')
  endTruckVendor(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrUnit') idOrUnit: string,
    @Body(new ZodValidationPipe(EndTruckVendorSchema)) body: EndTruckVendorRequest,
  ): Promise<TruckRecord> {
    return this.trucks.endVendor(principal, idOrUnit, body);
  }

  /** Brings an archived truck back as `available`. Body: { expectedUpdatedAt, reason? }. */
  @Post('trucks/:idOrUnit/restore')
  @RequirePermission('trucks.edit')
  restoreTruck(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrUnit') idOrUnit: string,
    @Body(new ZodValidationPipe(RestoreTruckSchema)) body: RestoreTruckRequest,
  ): Promise<TruckRecord> {
    return this.trucks.restore(principal, idOrUnit, body.reason ?? null, body.expectedUpdatedAt);
  }

  @RequireAnyPermission(...DRIVER_PICKER_PERMISSIONS)
  @Get('drivers')
  listDrivers(
    @CurrentPrincipal() principal: Principal,
    @Query(rosterQueryPipe) query: RosterQuery,
  ): Promise<RosterPage<DriverRecord>> {
    return this.drivers.list(principal, query).then((page) => maskDriverPage(principal, page));
  }

  /** Drivers on vacation, with the days away and the return drug-test flag (owner, 2026-10-16). */
  @Get('drivers/vacations')
  @RequireAnyPermission('drivers.view', 'dispatch.view', 'safety.view')
  driverVacations(@CurrentPrincipal() principal: Principal): Promise<DriverVacationList> {
    return this.vacations.list(principal).then((list) => ({
      ...list,
      away: list.away.map((v) => maskVacationPhone(principal, v)),
      returned: list.returned.map((v) => maskVacationPhone(principal, v)),
    }));
  }

  /**
   * Vacation requests drivers sent from the app (mobile M3), with the decision and the parked-truck
   * confirmation. Approving starts nothing: the vacation starts through Start vacation (or VACATION
   * on the Daily board), which takes the approved request over.
   */
  @Get('drivers/vacation-requests')
  @RequireAnyPermission('drivers.view', 'dispatch.view', 'safety.view')
  @Header('Cache-Control', 'private, no-store')
  vacationRequests(@CurrentPrincipal() principal: Principal): Promise<VacationRequestList> {
    return this.vacations.requests(principal);
  }

  @Post('drivers/vacation-requests/:id/decision')
  @RequireAnyPermission('drivers.edit', 'dispatch.manage')
  async decideVacationRequest(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(DecideVacationRequestSchema)) body: DecideVacationRequestInput): Promise<VacationRequestList> {
    await this.vacations.decide(principal, id, body);
    return this.vacations.requests(principal);
  }

  /** The office confirms the truck is parked (and the keys handed over); the driver may do it in the app. */
  @Post('drivers/vacation-requests/:id/parked')
  @RequireAnyPermission('drivers.edit', 'dispatch.manage')
  async confirmTruckParked(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(ConfirmTruckParkedSchema)) body: ConfirmTruckParkedInput): Promise<VacationRequestList> {
    await this.vacations.confirmParked(principal, id, body, { kind: 'office', name: principal.userName ?? principal.userId });
    return this.vacations.requests(principal);
  }

  /** One driver's vacations, cancelled ones included (owner, 2026-10-17). */
  @Get('drivers/:idOrNumber/vacations')
  @RequireAnyPermission('drivers.view', 'dispatch.view', 'safety.view')
  driverVacationHistory(@CurrentPrincipal() principal: Principal, @Param('idOrNumber') idOrNumber: string): Promise<DriverVacationView[]> {
    return this.vacations.history(principal, idOrNumber).then((rows) => rows.map((v) => maskVacationPhone(principal, v)));
  }

  @Post('drivers/:idOrNumber/vacations')
  @RequireAnyPermission('drivers.edit', 'dispatch.manage')
  startVacation(@CurrentPrincipal() principal: Principal, @Param('idOrNumber') idOrNumber: string, @Body(new ZodValidationPipe(StartVacationSchema)) body: StartVacationInput): Promise<DriverVacationView> {
    return this.vacations.start(principal, idOrNumber, body).then((v) => maskVacationPhone(principal, v));
  }

  @Patch('drivers/:idOrNumber/vacations/:vacationId')
  @RequireAnyPermission('drivers.edit', 'dispatch.manage')
  updateVacation(@CurrentPrincipal() principal: Principal, @Param('idOrNumber') idOrNumber: string, @Param('vacationId') vacationId: string, @Body(new ZodValidationPipe(UpdateVacationSchema)) body: UpdateVacationInput): Promise<DriverVacationView> {
    return this.vacations.update(principal, idOrNumber, vacationId, body).then((v) => maskVacationPhone(principal, v));
  }

  @Post('drivers/:idOrNumber/vacations/:vacationId/return')
  @RequireAnyPermission('drivers.edit', 'dispatch.manage')
  recordVacationReturn(@CurrentPrincipal() principal: Principal, @Param('idOrNumber') idOrNumber: string, @Param('vacationId') vacationId: string, @Body(new ZodValidationPipe(RecordVacationReturnSchema)) body: RecordVacationReturnInput): Promise<DriverVacationView> {
    return this.vacations.recordReturn(principal, idOrNumber, vacationId, body).then((v) => maskVacationPhone(principal, v));
  }

  @Post('drivers/:idOrNumber/vacations/:vacationId/cancel')
  @RequireAnyPermission('drivers.edit', 'dispatch.manage')
  cancelVacation(@CurrentPrincipal() principal: Principal, @Param('idOrNumber') idOrNumber: string, @Param('vacationId') vacationId: string, @Body(new ZodValidationPipe(CancelVacationSchema)) body: CancelVacationInput): Promise<DriverVacationView> {
    return this.vacations.cancel(principal, idOrNumber, vacationId, body).then((v) => maskVacationPhone(principal, v));
  }

  /** Every team in force, one entry per driver (owner, 2026-10-25): the Drivers list's Team / Solo. */
  @Get('drivers/teams')
  @RequireAnyPermission('drivers.view', 'dispatch.view', 'safety.view')
  driverTeams(@CurrentPrincipal() principal: Principal): Promise<DriverTeamList> {
    return this.teams.list(principal);
  }

  /** One driver's team in force (null = Solo) and every past pairing. */
  @Get('drivers/:idOrNumber/team')
  @RequireAnyPermission('drivers.view', 'dispatch.view', 'safety.view')
  driverTeam(@CurrentPrincipal() principal: Principal, @Param('idOrNumber') idOrNumber: string): Promise<DriverTeamStanding> {
    return this.teams.standing(principal, idOrNumber);
  }

  /** Pair: both drivers become a team with each other; 409 when either already has a partner. */
  @Post('drivers/:idOrNumber/team')
  @RequireAnyPermission('drivers.edit', 'dispatch.manage')
  pairDriver(@CurrentPrincipal() principal: Principal, @Param('idOrNumber') idOrNumber: string, @Body(new ZodValidationPipe(PairDriversSchema)) body: PairDriversInput): Promise<DriverTeamStanding> {
    return this.teams.pair(principal, idOrNumber, body);
  }

  /** Unpair, with a reason and the version read: both drivers are Solo again from the split day. */
  @Post('drivers/:idOrNumber/team/:pairId/end')
  @RequireAnyPermission('drivers.edit', 'dispatch.manage')
  unpairDriver(@CurrentPrincipal() principal: Principal, @Param('idOrNumber') idOrNumber: string, @Param('pairId') pairId: string, @Body(new ZodValidationPipe(UnpairDriversSchema)) body: UnpairDriversInput): Promise<DriverTeamStanding> {
    return this.teams.unpair(principal, idOrNumber, pairId, body);
  }

  @RequireAnyPermission(...DRIVER_PICKER_PERMISSIONS)
  @Get('drivers/:idOrNumber')
  getDriver(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrNumber') idOrNumber: string,
  ): Promise<DriverRecord> {
    return this.drivers.get(principal, idOrNumber).then((d) => maskDriver(principal, d));
  }

  @Post('drivers')
  @RequirePermission('drivers.edit')
  createDriver(
    @CurrentPrincipal() principal: Principal,
    @Body(createDriverPipe) body: CreateDriverRequest,
  ): Promise<DriverRecord> {
    return this.drivers.create(principal, body).then((d) => maskDriver(principal, d));
  }

  @Patch('drivers/:idOrNumber')
  @RequirePermission('drivers.edit')
  updateDriver(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrNumber') idOrNumber: string,
    @Body(updateDriverPipe) body: UpdateDriverRequest,
  ): Promise<DriverRecord> {
    // A form filled from a masked copy must not write the mask back (driver-pii.ts).
    return this.drivers.update(principal, idOrNumber, withoutHiddenDriverFields(principal, body)).then((d) => maskDriver(principal, d));
  }

  @Post('drivers/:idOrNumber/truck')
  @RequireAnyPermission('drivers.edit', 'trucks.edit', 'truck_assignment.edit')
  assignDriverTruck(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrNumber') idOrNumber: string,
    @Body(assignTruckPipe) body: { truckId: string | null },
  ): Promise<DriverRecord> {
    return this.drivers.assignTruck(principal, idOrNumber, body.truckId).then((d) => maskDriver(principal, d));
  }

  /** Brings an archived driver back (owner, 2026-10-02); archiving itself is the owner's script. */
  @Post('drivers/:idOrNumber/restore')
  @RequirePermission('drivers.edit')
  restoreDriver(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrNumber') idOrNumber: string,
    @Body(new ZodValidationPipe(RestoreDriverSchema)) body: RestoreDriverRequest,
  ): Promise<DriverRecord> {
    return this.drivers.restoreArchived(principal, idOrNumber, body.expectedArchivedAt).then((d) => maskDriver(principal, d));
  }

  @Post('drivers/:idOrNumber/status')
  @RequireAnyPermission('drivers.edit', 'dispatch.manage')
  setDriverStatus(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrNumber') idOrNumber: string,
    @Body(statusPipe.driver) body: { status: DriverRecord['status']; reason?: string | null },
  ): Promise<DriverRecord> {
    return this.drivers.setStatus(principal, idOrNumber, body.status, body.reason ?? null).then((d) => maskDriver(principal, d));
  }
}
