import { Body, Controller, Get, Header, Headers, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { accidentsV2 as A } from '@neway/shared';
import { CompanyScopeGuard } from '../../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../../common/auth/permission.guard';
import type { Principal } from '../../../common/auth/principal';
import { RequireAnyPermission, RequirePermission } from '../../../common/auth/require-permission.decorator';
import { FeatureFlagGuard } from '../../../common/flags/feature-flag.guard';
import { RequireFlag } from '../../../common/flags/require-flag.decorator';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { ClaimsV2Service } from './claims-v2.service';

const pipe = {
  list: new ZodValidationPipe(A.ClaimListQuerySchema),
  create: new ZodValidationPipe(A.CreateClaimsSchema),
  patch: new ZodValidationPipe(A.PatchClaimSchema),
  payment: new ZodValidationPipe(A.ClaimPaymentSchema),
  voidPayment: new ZodValidationPipe(A.VoidClaimPaymentSchema),
  doc: new ZodValidationPipe(A.ClaimDocumentSchema),
  log: new ZodValidationPipe(A.ClaimLogSchema),
  link: new ZodValidationPipe(A.LinkAccidentSchema),
} as const;

/**
 * Accident & Claims v2, phase P2 — claims (docs/accidents/API.md §4, adapted). Served at /safety/claims-v2 so the
 * Claims v2 endpoints at /safety/claims (driver charges, Accounting approval) keep working unchanged on the same rows.
 * Behind `accidents_v2` (404 when off). Reads: accidents.view (restricted claims redacted without accidents.restricted).
 * Writes: accidents.edit; money and payments also accidents.claim_money (Accounting holds it without accidents.edit).
 */
@Controller('safety/claims-v2')
@RequireFlag('accidents_v2')
@UseGuards(FeatureFlagGuard, CompanyScopeGuard, PermissionGuard)
export class ClaimsV2Controller {
  constructor(private readonly claims: ClaimsV2Service) {}

  @Get()
  @RequirePermission('accidents.view')
  @Header('Cache-Control', 'private, no-store')
  list(@CurrentPrincipal() p: Principal, @Query(pipe.list) q: A.ClaimListQuery) {
    return this.claims.list(p, q);
  }

  @Get('summary')
  @RequirePermission('accidents.view')
  @Header('Cache-Control', 'private, no-store')
  summary(@CurrentPrincipal() p: Principal) {
    return this.claims.summary(p);
  }

  @Get(':id')
  @RequirePermission('accidents.view')
  @Header('Cache-Control', 'private, no-store')
  detail(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.claims.detail(p, id);
  }

  @Post()
  @RequirePermission('accidents.edit')
  create(@CurrentPrincipal() p: Principal, @Body(pipe.create) body: A.CreateClaimsInput, @Headers('idempotency-key') key?: string) {
    return this.claims.create(p, body, key?.trim() ? key.trim().slice(0, 100) : undefined);
  }

  @Patch(':id')
  @RequireAnyPermission('accidents.edit', 'accidents.claim_money')
  patch(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.patch) body: A.PatchClaimInput) {
    return this.claims.patch(p, id, body);
  }

  @Post(':id/payments')
  @RequirePermission('accidents.claim_money')
  payment(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.payment) body: A.ClaimPaymentInput) {
    return this.claims.recordPayment(p, id, body);
  }

  @Post(':id/payments/:paymentId/void')
  @RequirePermission('accidents.claim_money')
  voidPayment(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('paymentId') paymentId: string, @Body(pipe.voidPayment) body: A.VoidClaimPaymentInput) {
    return this.claims.voidPayment(p, id, paymentId, body);
  }

  @Patch(':id/documents/:docId')
  @RequireAnyPermission('accidents.edit', 'accidents.claim_money')
  document(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('docId') docId: string, @Body(pipe.doc) body: A.ClaimDocumentInput) {
    return this.claims.document(p, id, docId, body);
  }

  @Post(':id/log')
  @RequireAnyPermission('accidents.edit', 'accidents.claim_money')
  log(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.log) body: A.ClaimLogInput) {
    return this.claims.addLog(p, id, body);
  }

  @Post(':id/link-accident')
  @RequirePermission('accidents.edit')
  link(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.link) body: A.LinkAccidentInput) {
    return this.claims.linkAccident(p, id, body);
  }
}
