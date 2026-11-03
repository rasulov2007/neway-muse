import { Body, Controller, Get, Header, Param, Patch, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  AddCompanyDocumentSchema,
  UpdateCompanyProfileSchema,
  VoidCompanyDocumentSchema,
  type AddCompanyDocumentInput,
  type UpdateCompanyProfileInput,
} from '@neway/shared';
import { z } from 'zod';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CompanyProfileService } from './company-profile.service';

/** Company info (owner, 2026-10-19): profile, documents, broker packet. */
@Controller('company')
@UseGuards(CompanyScopeGuard, PermissionGuard)
export class CompanyProfileController {
  constructor(private readonly company: CompanyProfileService) {}

  @Get('profile')
  @RequirePermission('company_profile.view')
  @Header('Cache-Control', 'private, no-store')
  view(@CurrentPrincipal() principal: Principal) {
    return this.company.view(principal);
  }

  @Patch('profile')
  @RequirePermission('company_profile.edit')
  update(@CurrentPrincipal() principal: Principal, @Body(new ZodValidationPipe(UpdateCompanyProfileSchema)) body: UpdateCompanyProfileInput) {
    return this.company.update(principal, body);
  }

  @Post('documents')
  @RequirePermission('company_profile.edit')
  addDocument(@CurrentPrincipal() principal: Principal, @Body(new ZodValidationPipe(AddCompanyDocumentSchema)) body: AddCompanyDocumentInput) {
    return this.company.addDocument(principal, body);
  }

  @Post('documents/:id/void')
  @RequirePermission('company_profile.edit')
  voidDocument(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(VoidCompanyDocumentSchema)) body: z.infer<typeof VoidCompanyDocumentSchema>) {
    return this.company.voidDocument(principal, id, body.reason);
  }

  /** The broker setup packet as a ZIP. POST, because downloading it is recorded. */
  @Post('packet')
  @RequirePermission('company_profile.view')
  async packet(@CurrentPrincipal() principal: Principal, @Res() reply: FastifyReply) {
    const { fileName, data } = await this.company.packet(principal);
    await reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="${fileName}"`).header('cache-control', 'private, no-store').send(data);
  }
}
