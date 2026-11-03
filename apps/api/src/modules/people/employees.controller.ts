import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  ChangeEmployeeStatusSchema,
  CreateStaffEmployeeSchema,
  EmployeeQuerySchema,
  ReassignEmployeeSchema,
  SetCompensationSchema,
  UpdateEmployeeSchema,
  type ChangeEmployeeStatusRequest,
  type CompensationHistoryEntry,
  type CreateEmployeeRequest,
  type Dispatcher,
  type EmployeePage,
  type EmployeeQuery,
  type EmployeeRecord,
  type PositionHistoryEntry,
  type ReassignEmployeeRequest,
  type SetCompensationRequest,
  type UpdateEmployeeRequest,
  type WorkforceSummary,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import type { Principal } from '../../common/auth/principal';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { AuditService } from './audit.service';
import { EmployeesService } from './employees.service';
import { maskActivity, maskEmployee, maskEmployeePage } from './employee-masking';
import { RequireAnyPermission, RequirePermission } from '../../common/auth/require-permission.decorator';

const queryPipe = new ZodValidationPipe(EmployeeQuerySchema);
const createPipe = new ZodValidationPipe(CreateStaffEmployeeSchema);
const updatePipe = new ZodValidationPipe(UpdateEmployeeSchema);
const reassignPipe = new ZodValidationPipe(ReassignEmployeeSchema);
const statusPipe = new ZodValidationPipe(ChangeEmployeeStatusSchema);
const compensationPipe = new ZodValidationPipe(SetCompensationSchema);

/**
 * Employees.
 *
 * Paging, filtering, sorting and the summary counts are all done by the database over the same
 * filtered set, because this list is expected to reach thousands of rows and because a count
 * computed separately from the list it opens is a count that will eventually disagree with it.
 */
@Controller('employees')
@UseGuards(CompanyScopeGuard)
export class EmployeesController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermission('employees.view')
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query(queryPipe) query: EmployeeQuery,
  ): Promise<EmployeePage> {
    return this.employees.list(principal, query).then((page) => maskEmployeePage(principal, page));
  }

  /** Everybody in a dispatching position, for every dispatcher picker in the product. */
  @RequireAnyPermission('employees.view', 'dispatch.view', 'loads.view', 'loads.create', 'dispatch_pay.view', 'board_weekly.view', 'board_daily.view')
  @Get('dispatchers')
  dispatchers(@CurrentPrincipal() principal: Principal): Promise<Dispatcher[]> {
    return this.employees.dispatchers(principal);
  }

  @RequirePermission('employees.view')
  @Get('summary')
  summary(
    @CurrentPrincipal() principal: Principal,
    @Query(queryPipe) query: EmployeeQuery,
  ): Promise<WorkforceSummary> {
    return this.employees.summary(principal, query);
  }

  /**
   * HR and administrators only (employees.create). Owner decision 2026-10-25: dispatchers and
   * dispatch leads do not add employees, dispatchers included; the Create dispatcher dialog is
   * hidden for them in the browser.
   */
  @RequirePermission('employees.create')
  @Post()
  create(
    @CurrentPrincipal() principal: Principal,
    @Body(createPipe) body: CreateEmployeeRequest,
  ): Promise<EmployeeRecord> {
    return this.employees.create(principal, body).then((r) => maskEmployee(principal, r));
  }

  @RequirePermission('employees.view')
  @Get(':id')
  get(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<EmployeeRecord> {
    return this.employees.get(principal, id).then((r) => maskEmployee(principal, r));
  }

  @RequirePermission('employees.edit')
  @Patch(':id')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(updatePipe) body: UpdateEmployeeRequest,
  ): Promise<EmployeeRecord> {
    return this.employees.update(principal, id, body).then((r) => maskEmployee(principal, r));
  }

  @RequirePermission('employees.manage')
  @Post(':id/reassign')
  reassign(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(reassignPipe) body: ReassignEmployeeRequest,
  ): Promise<EmployeeRecord> {
    return this.employees.reassign(principal, id, body).then((r) => maskEmployee(principal, r));
  }

  @RequirePermission('employees.manage')
  @Post(':id/status')
  changeStatus(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(statusPipe) body: ChangeEmployeeStatusRequest,
  ): Promise<EmployeeRecord> {
    return this.employees.changeStatus(principal, id, body).then((r) => maskEmployee(principal, r));
  }

  @RequirePermission('employees.view_financial')
  @RequireAnyPermission('employees.manage', 'accounting.edit')
  @Post(':id/compensation')
  setCompensation(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(compensationPipe) body: SetCompensationRequest,
  ): Promise<EmployeeRecord> {
    return this.employees.setCompensation(principal, id, body).then((r) => maskEmployee(principal, r));
  }

  @RequirePermission('employees.view')
  @Get(':id/employment')
  employment(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<PositionHistoryEntry[]> {
    return this.employees.positionHistory(principal, id);
  }

  @RequirePermission('employees.view_financial')
  @Get(':id/compensation')
  compensation(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<CompensationHistoryEntry[]> {
    return this.employees.compensationHistory(principal, id);
  }

  @RequirePermission('employees.view')
  @Get(':id/reports')
  reports(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<EmployeeRecord[]> {
    return this.employees.directReports(principal, id).then((rows) => rows.map((r) => maskEmployee(principal, r)));
  }

  /** The activity timeline, read from the one audit log rather than a People-specific one. */
  @RequirePermission('employees.view')
  @Get(':id/activity')
  async activity(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    const employee = await this.employees.get(principal, id);
    const rows = await this.audit.forEntity(principal, 'employee', employee.id);
    return rows.map((row) => maskActivity(principal, {
      id: row.id,
      at: row.at.toISOString(),
      actorName: row.actorName,
      actorType: row.actorType,
      action: row.action,
      summary: row.summary,
      changes: row.changes as { field: string; old: string | null; new: string | null }[],
      reason: row.reason,
    }));
  }
}
