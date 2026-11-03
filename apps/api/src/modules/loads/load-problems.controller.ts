import { Body, Controller, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  CloseLoadProblemSchema,
  FlagLoadSchema,
  type CloseLoadProblemInput,
  type FlagLoadInput,
  type LoadProblem,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { LoadProblemsService } from './load-problems.service';

const pipe = {
  flag: new ZodValidationPipe(FlagLoadSchema),
  close: new ZodValidationPipe(CloseLoadProblemSchema),
} as const;

/**
 * Flags on loads (rule 1.10). The list lives under its own path so it never collides with
 * `GET /loads/:id`; the writes hang off the load they belong to.
 */
@Controller()
@UseGuards(CompanyScopeGuard, PermissionGuard)
export class LoadProblemsController {
  constructor(private readonly problems: LoadProblemsService) {}

  /** Every flag; `open=true` (the default) keeps it to the ones still needing a person. */
  @Get('load-problems')
  @RequirePermission('loads.view')
  @Header('Cache-Control', 'private, no-store')
  list(@CurrentPrincipal() principal: Principal, @Query('open') open?: string): Promise<LoadProblem[]> {
    return this.problems.list(principal, { open: open !== 'false' });
  }

  @Get('loads/:id/problems')
  @RequirePermission('loads.view')
  @Header('Cache-Control', 'private, no-store')
  forLoad(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<LoadProblem[]> {
    return this.problems.forLoad(principal, id);
  }

  @Post('loads/:id/problems')
  @RequirePermission('loads.edit')
  flag(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.flag) body: FlagLoadInput,
  ): Promise<LoadProblem> {
    return this.problems.flag(principal, id, body);
  }

  @Post('loads/:id/problems/:problemId/close')
  @RequirePermission('loads.edit')
  close(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('problemId') problemId: string,
    @Body(pipe.close) body: CloseLoadProblemInput,
  ): Promise<LoadProblem> {
    return this.problems.close(principal, id, problemId, body);
  }
}
