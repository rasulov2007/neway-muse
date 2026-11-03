import { Controller, Get, Header, Query } from '@nestjs/common';
import type { OfficeApprovals, OfficeDispatch, OfficeMe, OfficeMyWork, OfficeToday } from '@neway/shared';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import type { Principal } from '../../common/auth/principal';
import { RequireAnyPermission } from '../../common/auth/require-permission.decorator';
import { SignedInOnly } from '../../common/auth/signed-in-only.decorator';
import { DRIVER_PICKER_PERMISSIONS, UNIT_PICKER_PERMISSIONS } from '../roster/roster-access';
import { OfficeService } from './office.service';

const DISPATCH_CODES = [...new Set(['loads.view', ...UNIT_PICKER_PERMISSIONS, ...DRIVER_PICKER_PERMISSIONS])];

/**
 * The office app (mobile M4, docs/mobile/API.md §9): aggregations over the existing services.
 * Each block inside an answer is present only when the caller holds the permission of the records
 * it reads; decisions are made on the existing routes each item names.
 */
@Controller('office')
export class OfficeController {
  constructor(private readonly office: OfficeService) {}

  @Get('me')
  @SignedInOnly('the caller own account, roles and departments; office accounts only (a driver login is refused)')
  @Header('Cache-Control', 'private, no-store')
  me(@CurrentPrincipal() principal: Principal): Promise<OfficeMe> {
    return this.office.me(principal);
  }

  @Get('today')
  @SignedInOnly('each role view needs its own codes (OFFICE_ROLE_PERMISSIONS) and each block the permission of the service it reads; 403 otherwise')
  @Header('Cache-Control', 'private, no-store')
  today(
    @CurrentPrincipal() principal: Principal,
    @Query('role') role?: string,
    @Query('period') preset?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<OfficeToday> {
    return this.office.todayView(principal, role, { preset, from, to });
  }

  @Get('dispatch')
  @RequireAnyPermission(...DISPATCH_CODES)
  @Header('Cache-Control', 'private, no-store')
  dispatch(@CurrentPrincipal() principal: Principal, @Query('tab') tab?: string, @Query('q') q?: string): Promise<OfficeDispatch> {
    return this.office.dispatch(principal, tab, q);
  }

  @Get('approvals')
  @RequireAnyPermission('accounting.edit', 'pto.approve', 'accidents.fleet', 'drivers.edit', 'dispatch.manage')
  @Header('Cache-Control', 'private, no-store')
  approvals(@CurrentPrincipal() principal: Principal, @Query('kind') kind?: string): Promise<OfficeApprovals> {
    return this.office.approvals(principal, kind);
  }

  @Get('my-work')
  @SignedInOnly('own tasks, own attendance and own PTO balance only; never another person, never an amount of pay')
  @Header('Cache-Control', 'private, no-store')
  myWork(@CurrentPrincipal() principal: Principal): Promise<OfficeMyWork> {
    return this.office.myWork(principal);
  }
}
