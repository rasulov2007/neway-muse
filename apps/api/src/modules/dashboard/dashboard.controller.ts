import type { DashboardVendors } from '@neway/shared';
import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import {
  DashboardPeriodQuerySchema,
  DrilldownQuerySchema,
  TruckPnlQuerySchema,
  type DashboardDataHealth,
  type DashboardDispatch,
  type DashboardDrilldown,
  type DashboardFuel,
  type DashboardOpsNet,
  type DashboardOverview,
  type DashboardPeriodQuery,
  type DashboardTrends,
  type DashboardTruckPnl,
  type DrilldownQuery,
  type TruckPnlQuery,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { DASHBOARD_PERMISSIONS, type Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { DashboardService } from './dashboard.service';

const CACHE_CONTROL = 'private, max-age=30';
const periodQuery = new ZodValidationPipe(DashboardPeriodQuerySchema);

/** Dashboard read endpoints (docs/DASHBOARD.md §2); every response is section-specific and masked. */
@Controller('dashboard')
@UseGuards(CompanyScopeGuard, PermissionGuard)
@RequirePermission(DASHBOARD_PERMISSIONS.view)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('overview')
  @Header('Cache-Control', CACHE_CONTROL)
  overview(
    @CurrentPrincipal() principal: Principal,
    @Query(periodQuery) query: DashboardPeriodQuery,
  ): Promise<DashboardOverview> {
    return this.dashboard.overview(principal, query);
  }

  @Get('trends')
  @Header('Cache-Control', CACHE_CONTROL)
  trends(
    @CurrentPrincipal() principal: Principal,
    @Query(periodQuery) query: DashboardPeriodQuery,
  ): Promise<DashboardTrends> {
    return this.dashboard.trends(principal, query);
  }

  @Get('ops-net')
  @Header('Cache-Control', CACHE_CONTROL)
  opsNet(
    @CurrentPrincipal() principal: Principal,
    @Query(periodQuery) query: DashboardPeriodQuery,
  ): Promise<DashboardOpsNet> {
    return this.dashboard.opsNet(principal, query);
  }

  /** Vendor trucks (owner, 2026-10-28): gross, company share, driver pay, costs and the vendor's net. */
  @Get('vendors')
  @Header('Cache-Control', CACHE_CONTROL)
  vendors(
    @CurrentPrincipal() principal: Principal,
    @Query(periodQuery) query: DashboardPeriodQuery,
  ): Promise<DashboardVendors> {
    return this.dashboard.vendors(principal, query);
  }

  @Get('truck-pnl')
  @Header('Cache-Control', CACHE_CONTROL)
  truckPnl(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(TruckPnlQuerySchema)) query: TruckPnlQuery,
  ): Promise<DashboardTruckPnl> {
    return this.dashboard.truckPnl(principal, query);
  }

  @Get('fuel')
  @Header('Cache-Control', CACHE_CONTROL)
  fuel(
    @CurrentPrincipal() principal: Principal,
    @Query(periodQuery) query: DashboardPeriodQuery,
  ): Promise<DashboardFuel> {
    return this.dashboard.fuel(principal, query);
  }

  @Get('dispatch-performance')
  @Header('Cache-Control', CACHE_CONTROL)
  dispatchPerformance(
    @CurrentPrincipal() principal: Principal,
    @Query(periodQuery) query: DashboardPeriodQuery,
  ): Promise<DashboardDispatch> {
    return this.dashboard.dispatchPerformance(principal, query);
  }

  @Get('data-health')
  @Header('Cache-Control', CACHE_CONTROL)
  dataHealth(
    @CurrentPrincipal() principal: Principal,
    @Query(periodQuery) query: DashboardPeriodQuery,
  ): Promise<DashboardDataHealth> {
    return this.dashboard.dataHealth(principal, query);
  }

  @Get('drilldown')
  @Header('Cache-Control', CACHE_CONTROL)
  @RequirePermission(DASHBOARD_PERMISSIONS.drilldown)
  drilldown(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(DrilldownQuerySchema)) query: DrilldownQuery,
  ): Promise<DashboardDrilldown> {
    return this.dashboard.drilldown(principal, query);
  }
}
