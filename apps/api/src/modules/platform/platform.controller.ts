import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  CreatePlatformCompanySchema,
  DeactivatePlatformCompanySchema,
  PlatformCompanyVersionSchema,
  RenamePlatformCompanySchema,
  type CreatePlatformCompany,
  type DeactivatePlatformCompany,
  type PlatformCompanyVersion,
  type RenamePlatformCompany,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import type { Principal } from '../../common/auth/principal';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformService } from './platform.service';
import { SignedInOnly } from '../../common/auth/signed-in-only.decorator';

const pipe = {
  create: new ZodValidationPipe(CreatePlatformCompanySchema),
  rename: new ZodValidationPipe(RenamePlatformCompanySchema),
  version: new ZodValidationPipe(PlatformCompanyVersionSchema),
  deactivate: new ZodValidationPipe(DeactivatePlatformCompanySchema),
} as const;

/**
 * The Companies page (platform administrator only). The company being acted on is named in the
 * path because acting across companies is the point here; everywhere else the session decides it.
 */
@SignedInOnly('PlatformAdminGuard: platform administrators only (users.is_platform_admin)')
@Controller('platform/companies')
@UseGuards(CompanyScopeGuard, PlatformAdminGuard)
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get()
  list() {
    return this.platform.list();
  }

  @Post()
  create(@CurrentPrincipal() principal: Principal, @Body(pipe.create) body: CreatePlatformCompany) {
    return this.platform.create(principal, body);
  }

  @Patch(':id')
  rename(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.rename) body: RenamePlatformCompany,
  ) {
    return this.platform.rename(principal, id, body);
  }

  @Post(':id/deactivate')
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.deactivate) body: DeactivatePlatformCompany,
  ) {
    return this.platform.deactivate(principal, id, body);
  }

  @Post(':id/reactivate')
  reactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.version) body: PlatformCompanyVersion,
  ) {
    return this.platform.reactivate(principal, id, body.version);
  }

  @Post(':id/admin-password')
  issueAdminPassword(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.platform.issueAdminPassword(principal, id);
  }
}
