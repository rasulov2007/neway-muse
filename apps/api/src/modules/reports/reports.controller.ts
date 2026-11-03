import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  REPORTS,
  RunReportSchema,
  SaveReportSchema,
  type ReportResult,
  type RunReportRequest,
  type SaveReportRequest,
  type SavedReportRecord,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import type { Principal } from '../../common/auth/principal';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { AuditService } from '../people/audit.service';
import { parseRankingQuery } from './analytics-ranking';
import { AnalyticsService } from './analytics.service';
import { ReportRunnerService } from './report-runner.service';
import { SavedReportsService } from './saved-reports.service';

const runPipe = new ZodValidationPipe(RunReportSchema);
const savePipe = new ZodValidationPipe(SaveReportSchema);

/**
 * Reports and analytics.
 *
 * Every route is company-scoped by the principal, and the library only returns reports whose
 * declared permission the caller holds — so a financial report is not merely hidden in the UI, it
 * is absent from the response.
 *
 * Access is enforced here, not only in the navigation (owner, 2026-10-25): every `reports/*`
 * route needs `reports.view` and every `analytics/*` route needs `analytics.view`, so a
 * signed-in worker without the grant gets 403 rather than the company's numbers. Running a
 * financial, workforce or safety report still also needs that report's own code (the runner).
 */
@Controller()
@UseGuards(CompanyScopeGuard, PermissionGuard)
export class ReportsController {
  constructor(
    private readonly runner: ReportRunnerService,
    private readonly saved: SavedReportsService,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
  ) {}

  @Get('reports/catalog')
  @RequirePermission('reports.view')
  catalog(@CurrentPrincipal() principal: Principal) {
    return REPORTS.filter((report) => principal.permissions.has(report.permission));
  }

  @Post('reports/run')
  @RequirePermission('reports.view')
  async run(
    @CurrentPrincipal() principal: Principal,
    @Body(runPipe) body: RunReportRequest,
  ): Promise<ReportResult> {
    const result = await this.runner.run(principal, body);
    // Running a report is audited: who asked for what, over which period.
    await this.audit.write(principal, {
      action: 'export',
      entityType: 'report',
      entityId: result.reportKey,
      entityLabel: result.name,
      summary: `${result.name} run for ${result.range.from} – ${result.range.to} (${result.total} rows)`,
    });
    await this.saved.touch(principal, result.reportKey);
    return result;
  }

  @Get('reports/saved')
  @RequirePermission('reports.view')
  listSaved(@CurrentPrincipal() principal: Principal): Promise<SavedReportRecord[]> {
    return this.saved.list(principal);
  }

  @Post('reports/saved')
  @RequirePermission('reports.view')
  save(
    @CurrentPrincipal() principal: Principal,
    @Body(savePipe) body: SaveReportRequest,
  ): Promise<SavedReportRecord[]> {
    return this.saved.save(principal, body);
  }

  @Delete('reports/saved/:id')
  @RequirePermission('reports.view')
  remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<SavedReportRecord[]> {
    return this.saved.remove(principal, id);
  }

  // -------------------------------------------------------------------------------- analytics

  @Get('analytics/executive')
  @RequirePermission('analytics.view')
  executive(
    @CurrentPrincipal() principal: Principal,
    @Query('preset') preset = 'this_month',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.executive(principal, preset, from, to);
  }

  @Get('analytics/cost-drivers')
  @RequirePermission('analytics.view')
  costDrivers(
    @CurrentPrincipal() principal: Principal,
    @Query('preset') preset = 'this_month',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.costDrivers(principal, preset, from, to);
  }

  /** Accessorials - who gets what: billed, to driver, to dispatcher, company keeps, per type. */
  @Get('analytics/accessorials')
  @RequirePermission('analytics.view')
  accessorials(
    @CurrentPrincipal() principal: Principal,
    @Query('preset') preset = 'this_month',
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const int = (v: string | undefined) => {
      const n = Number(v);
      return v !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
    };
    return this.analytics.accessorials(principal, preset, from, to, { page: int(page), pageSize: int(pageSize) });
  }

  /** Vendor trucks (owner, 2026-10-28): what the company keeps and the vendor's side, per truck. */
  @Get('analytics/vendors')
  @RequirePermission('analytics.view')
  vendors(
    @CurrentPrincipal() principal: Principal,
    @Query('preset') preset = 'this_month',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.vendors(principal, preset, from, to);
  }

  @Get('analytics/trucks')
  @RequirePermission('analytics.view')
  trucks(
    @CurrentPrincipal() principal: Principal,
    @Query('preset') preset = 'this_month',
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query() query: Record<string, string | string[] | undefined> = {},
  ) {
    const paging = parseRankingQuery(query, { sort: 'profit', dir: 'desc' });
    return this.analytics.truckRanking(principal, preset, from, to, paging);
  }

  @Get('analytics/drivers')
  @RequirePermission('analytics.view')
  drivers(
    @CurrentPrincipal() principal: Principal,
    @Query('preset') preset = 'this_month',
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query() query: Record<string, string | string[] | undefined> = {},
  ) {
    const paging = parseRankingQuery(query, { sort: 'gross', dir: 'desc' });
    return this.analytics.driverRanking(principal, preset, from, to, paging);
  }

  @Get('analytics/operations')
  @RequirePermission('analytics.view')
  operations(
    @CurrentPrincipal() principal: Principal,
    @Query('preset') preset = 'this_month',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.operations(principal, preset, from, to);
  }

  @Get('analytics/fuel')
  @RequirePermission('analytics.view')
  fuel(
    @CurrentPrincipal() principal: Principal,
    @Query('preset') preset = 'this_month',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.fuel(principal, preset, from, to);
  }

  @Get('analytics/workforce')
  @RequirePermission('analytics.view')
  workforce(@CurrentPrincipal() principal: Principal) {
    return this.analytics.workforce(principal);
  }
}
