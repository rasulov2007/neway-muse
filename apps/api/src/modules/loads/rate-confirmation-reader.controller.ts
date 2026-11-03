import { Body, Controller, Header, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ReadRateConfirmationSchema, type RateConfirmationReadResult, type ReadRateConfirmationInput } from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { RateConfirmationReaderService } from './rate-confirmation-reader.service';

const readPipe = new ZodValidationPipe(ReadRateConfirmationSchema);

/** Add load → upload the RC → the form fills itself. Reads only; nothing is saved here. */
@Controller('load-rate-confirmations')
@UseGuards(CompanyScopeGuard, PermissionGuard)
export class RateConfirmationReaderController {
  constructor(private readonly reader: RateConfirmationReaderService) {}

  @Post('read')
  @HttpCode(200)
  @RequirePermission('loads.create')
  @Header('Cache-Control', 'private, no-store')
  read(@CurrentPrincipal() principal: Principal, @Body(readPipe) body: ReadRateConfirmationInput): Promise<RateConfirmationReadResult> {
    return this.reader.read(principal.companyId, body);
  }
}
