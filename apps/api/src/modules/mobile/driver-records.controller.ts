import { Body, Controller, Get, Header, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  DriverBreakdownCreateSchema,
  DriverCareCreateSchema,
  DriverDocumentCreateSchema,
  DriverReferralCreateSchema,
  DriverReimbursementCreateSchema,
  DriverSafetyReportCreateSchema,
  DriverTruckParkedSchema,
  DriverVacationRequestSchema,
  type DriverBreakdown,
  type DriverBreakdownList,
  type DriverCareList,
  type DriverCareRequest,
  type DriverDocumentList,
  type DriverReferral,
  type DriverReferralList,
  type DriverReimbursement,
  type DriverReimbursementList,
  type DriverSafetyReport,
  type DriverSafetyReportList,
  type DriverSettlementDetail,
  type DriverSettlementList,
  type DriverVacationRequestList,
  type DriverVacationRequestView,
} from '@neway/shared';
import { z } from 'zod';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { BreakdownsService } from './breakdowns.service';
import { DriverCareService } from './driver-care.service';
import { DriverDocumentsService } from './driver-documents.service';
import { DriverMoneyService } from './driver-money.service';
import { DriverSafetyReportsService } from './driver-safety-reports.service';
import { DriverVacationsService } from './driver-vacations.service';
import { IdempotencyService } from './idempotency.service';

const pipe = <T extends z.ZodType>(schema: T) => new ZodValidationPipe(schema);
const breakdown = pipe(DriverBreakdownCreateSchema);
const receipt = pipe(DriverReimbursementCreateSchema);
const care = pipe(DriverCareCreateSchema);
const referral = pipe(DriverReferralCreateSchema);
const vacation = pipe(DriverVacationRequestSchema);
const parked = pipe(DriverTruckParkedSchema);
const document = pipe(DriverDocumentCreateSchema);
const safety = pipe(DriverSafetyReportCreateSchema);

/**
 * The driver app, phase M3 (docs/mobile/API.md §7-§14): breakdowns, receipts, pay statements,
 * Driver Care, referrals, vacations, qualification documents and safety reports.
 *
 * Every route needs `driver_app.use`; the driver is resolved on the server (DriverContextService)
 * and nothing the phone sends names the driver or the company. Every POST carries an
 * Idempotency-Key: a retry answers with the first result and writes nothing new.
 */
@Controller('driver')
export class DriverRecordsController {
  constructor(
    private readonly breakdowns: BreakdownsService,
    private readonly money: DriverMoneyService,
    private readonly care: DriverCareService,
    private readonly vacations: DriverVacationsService,
    private readonly documents: DriverDocumentsService,
    private readonly safety: DriverSafetyReportsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ------------------------------------------------------------------------- breakdowns

  @Post('breakdowns')
  @HttpCode(201)
  @RequirePermission('driver_app.use')
  reportBreakdown(@CurrentPrincipal() principal: Principal, @Body(breakdown) body: z.output<typeof DriverBreakdownCreateSchema>, @Headers('idempotency-key') key?: string): Promise<DriverBreakdown> {
    return this.idempotency.run(principal, key, 'POST /driver/breakdowns', () => this.breakdowns.create(principal, body, key));
  }

  @Get('breakdowns')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  myBreakdowns(@CurrentPrincipal() principal: Principal): Promise<DriverBreakdownList> {
    return this.breakdowns.mine(principal);
  }

  @Get('breakdowns/:id')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  myBreakdown(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<DriverBreakdown> {
    return this.breakdowns.mineOne(principal, id);
  }

  // ---------------------------------------------------------------------- receipts / money

  @Post('reimbursements')
  @HttpCode(201)
  @RequirePermission('driver_app.use')
  fileReceipt(@CurrentPrincipal() principal: Principal, @Body(receipt) body: z.output<typeof DriverReimbursementCreateSchema>, @Headers('idempotency-key') key?: string): Promise<DriverReimbursement> {
    return this.idempotency.run(principal, key, 'POST /driver/reimbursements', () => this.money.fileReceipt(principal, body, key!.trim()));
  }

  @Get('reimbursements')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  myReceipts(@CurrentPrincipal() principal: Principal): Promise<DriverReimbursementList> {
    return this.money.myReceipts(principal);
  }

  @Get('reimbursements/:id')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  myReceipt(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<DriverReimbursement> {
    return this.money.myReceipt(principal, id);
  }

  @Get('settlements')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  mySettlements(@CurrentPrincipal() principal: Principal, @Query('week') week?: string): Promise<DriverSettlementList> {
    return this.money.mySettlements(principal, week);
  }

  @Get('settlements/:id')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  mySettlement(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<DriverSettlementDetail> {
    return this.money.mySettlement(principal, id);
  }

  /** The statement's PDF, streamed to this session only (the driver's own finalized statements). */
  @Get('settlements/:id/pdf')
  @RequirePermission('driver_app.use')
  async mySettlementPdf(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Res() reply: FastifyReply) {
    const { pdf, fileName } = await this.money.mySettlementPdf(principal, id);
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${fileName.replace(/"/g, '')}"`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(pdf);
  }

  // ------------------------------------------------------------------- Driver Care / referrals

  @Post('care')
  @HttpCode(201)
  @RequirePermission('driver_app.use')
  sendCare(@CurrentPrincipal() principal: Principal, @Body(care) body: z.output<typeof DriverCareCreateSchema>, @Headers('idempotency-key') key?: string): Promise<DriverCareRequest> {
    return this.idempotency.run(principal, key, 'POST /driver/care', () => this.care.create(principal, body, key!.trim()));
  }

  @Get('care')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  myCare(@CurrentPrincipal() principal: Principal): Promise<DriverCareList> {
    return this.care.mine(principal);
  }

  @Get('care/:id')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  myCareOne(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<DriverCareRequest> {
    return this.care.mineOne(principal, id);
  }

  @Post('referrals')
  @HttpCode(201)
  @RequirePermission('driver_app.use')
  refer(@CurrentPrincipal() principal: Principal, @Body(referral) body: z.output<typeof DriverReferralCreateSchema>, @Headers('idempotency-key') key?: string): Promise<DriverReferral> {
    return this.idempotency.run(principal, key, 'POST /driver/referrals', () => this.care.refer(principal, body, key!.trim()));
  }

  @Get('referrals')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  myReferrals(@CurrentPrincipal() principal: Principal): Promise<DriverReferralList> {
    return this.care.myReferrals(principal);
  }

  // ------------------------------------------------------------------------------ vacations

  @Post('vacations')
  @HttpCode(201)
  @RequirePermission('driver_app.use')
  requestVacation(@CurrentPrincipal() principal: Principal, @Body(vacation) body: z.output<typeof DriverVacationRequestSchema>, @Headers('idempotency-key') key?: string): Promise<DriverVacationRequestView> {
    return this.idempotency.run(principal, key, 'POST /driver/vacations', () => this.vacations.request(principal, body));
  }

  @Get('vacations')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  myVacations(@CurrentPrincipal() principal: Principal): Promise<DriverVacationRequestList> {
    return this.vacations.mine(principal);
  }

  @Post('vacations/:id/parked')
  @HttpCode(200)
  @RequirePermission('driver_app.use')
  truckParked(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(parked) body: z.output<typeof DriverTruckParkedSchema>, @Headers('idempotency-key') key?: string): Promise<DriverVacationRequestView> {
    return this.idempotency.run(principal, key, `POST /driver/vacations/${id}/parked`, () => this.vacations.parked(principal, id, body));
  }

  @Post('vacations/:id/cancel')
  @HttpCode(200)
  @RequirePermission('driver_app.use')
  cancelVacation(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Headers('idempotency-key') key?: string): Promise<DriverVacationRequestView> {
    return this.idempotency.run(principal, key, `POST /driver/vacations/${id}/cancel`, () => this.vacations.cancel(principal, id));
  }

  // ------------------------------------------------------------------------------ documents

  @Get('documents')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  myDocuments(@CurrentPrincipal() principal: Principal): Promise<DriverDocumentList> {
    return this.documents.mine(principal);
  }

  @Post('documents')
  @HttpCode(201)
  @RequirePermission('driver_app.use')
  sendDocument(@CurrentPrincipal() principal: Principal, @Body(document) body: z.output<typeof DriverDocumentCreateSchema>, @Headers('idempotency-key') key?: string): Promise<DriverDocumentList> {
    return this.idempotency.run(principal, key, 'POST /driver/documents', () => this.documents.upload(principal, body));
  }

  // -------------------------------------------------------------------------- safety reports

  @Post('safety-reports')
  @HttpCode(201)
  @RequirePermission('driver_app.use')
  reportSafety(@CurrentPrincipal() principal: Principal, @Body(safety) body: z.output<typeof DriverSafetyReportCreateSchema>, @Headers('idempotency-key') key?: string): Promise<DriverSafetyReport> {
    return this.idempotency.run(principal, key, 'POST /driver/safety-reports', () => this.safety.create(principal, body, key!.trim()));
  }

  @Get('safety-reports')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  mySafetyReports(@CurrentPrincipal() principal: Principal): Promise<DriverSafetyReportList> {
    return this.safety.mine(principal);
  }

  @Get('safety-reports/:id')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  mySafetyReport(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<DriverSafetyReport> {
    return this.safety.mineOne(principal, id);
  }
}
