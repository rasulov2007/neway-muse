import { Controller, Get, Header, Post, UseGuards } from '@nestjs/common';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { AiBriefService } from './ai-brief.service';

/**
 * The Morning brief (hackathon A2, 2026-11-03): the person's own, read with their own access.
 * Running it writes nothing but the brief itself (and the AI usage row the model call costs).
 */
@Controller('ai/brief')
@UseGuards(CompanyScopeGuard, PermissionGuard)
@RequirePermission('ai_assistant.use')
export class AiBriefController {
  constructor(private readonly briefs: AiBriefService) {}

  /** Runs every check now and has NeWay AI write the brief up. */
  @Post()
  run(@CurrentPrincipal() principal: Principal) {
    return this.briefs.run(principal, 'manual');
  }

  /** The person's latest brief; `{ brief: null }` when they never ran one. */
  @Get('latest')
  @Header('Cache-Control', 'private, no-store')
  async latest(@CurrentPrincipal() principal: Principal) {
    return { brief: await this.briefs.latest(principal) };
  }
}
