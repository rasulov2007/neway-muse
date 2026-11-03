import { Body, Controller, Get, Header, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { FleetExpenseListQuerySchema, InvestigationQuerySchema, type FleetExpenseListQuery, type InvestigationQuery } from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequireAnyPermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { DatabaseService } from '../../database/database.service';
import { companies } from '../../database/schema';
import { renderExpensePdf, renderReportPdf } from './fleet-expenses-pdf';
import { FleetExpensesService } from './fleet-expenses.service';

const ReasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const FileSchema = z.object({ fileId: z.string().min(1), kind: z.enum(['receipt', 'invoice', 'efs_receipt', 'other']).default('receipt') });
const RemoveFileSchema = z.object({ reason: z.string().trim().max(500).default('') });
const DuplicateQuerySchema = z.object({
  truckId: z.string().optional(),
  category: z.string().optional(),
  amountCents: z.coerce.number().int().optional(),
  expenseDate: z.string().optional(),
  invoiceNumber: z.string().optional(),
});

/**
 * Fleet Expenses. Reads are open to whoever may see maintenance money or the books; recording is
 * Fleet's (or Accounting's); posting and deductions are checked again inside the service, so the
 * route is never the only gate.
 */
@Controller('fleet/expenses')
@UseGuards(CompanyScopeGuard, PermissionGuard)
export class FleetExpensesController {
  constructor(
    private readonly expenses: FleetExpensesService,
    private readonly database: DatabaseService,
  ) {}

  private async company(principal: Principal): Promise<string> {
    const [row] = await this.database.db.select({ name: companies.name }).from(companies).where(eq(companies.id, principal.companyId)).limit(1);
    return row?.name ?? 'Company';
  }

  private pdf(reply: FastifyReply, bytes: Uint8Array, name: string) {
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${name}"`).header('cache-control', 'private, no-store').send(Buffer.from(bytes));
  }

  @RequireAnyPermission('maintenance_costs.view', 'accounting.view')
  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(FleetExpenseListQuerySchema)) q: FleetExpenseListQuery) {
    return this.expenses.list(principal, q);
  }

  /** Money nobody has decided who bears yet: Costs, the unit and the driver read it (owner, 2026-10-13). */
  @RequireAnyPermission('maintenance_costs.view', 'accounting.view', 'compliance.manage')
  @Get('investigations')
  @Header('Cache-Control', 'private, no-store')
  investigations(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(InvestigationQuerySchema)) q: InvestigationQuery) {
    return this.expenses.investigations(principal, q);
  }

  @RequireAnyPermission('maintenance.edit', 'compliance.manage')
  @Post(':id/resolve-investigation')
  resolveInvestigation(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.expenses.resolveInvestigation(principal, id, body);
  }

  @RequireAnyPermission('maintenance_costs.view', 'accounting.view')
  @Get('dashboard')
  @Header('Cache-Control', 'private, no-store')
  dashboard(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(FleetExpenseListQuerySchema)) q: FleetExpenseListQuery) {
    return this.expenses.dashboard(principal, q);
  }

  @RequireAnyPermission('maintenance_costs.view', 'accounting.view')
  @Get('options')
  @Header('Cache-Control', 'private, no-store')
  options(@CurrentPrincipal() principal: Principal) {
    return this.expenses.options(principal);
  }

  @RequireAnyPermission('maintenance_costs.view', 'accounting.view')
  @Get('duplicate-check')
  @Header('Cache-Control', 'private, no-store')
  duplicates(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(DuplicateQuerySchema)) q: z.infer<typeof DuplicateQuerySchema>) {
    return this.expenses.duplicates(principal, q);
  }

  /** The filtered list as a PDF: the same filters, the same permissions as the screen. */
  @RequireAnyPermission('maintenance_costs.view', 'accounting.view')
  @Get('report.pdf')
  async report(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(FleetExpenseListQuerySchema)) q: FleetExpenseListQuery, @Res() reply: FastifyReply) {
    const list = await this.expenses.list(principal, { ...q, page: 1, pageSize: 100_000 });
    const filters = [q.from || q.to ? `${q.from ?? 'start'} to ${q.to ?? 'today'}` : 'All dates', q.truckId ? `truck filter` : null, q.category ?? null, q.paidBy ? `paid by ${q.paidBy}` : null, q.chargeTo ? `charge to ${q.chargeTo}` : null, q.search ? `"${q.search}"` : null].filter(Boolean).join(' · ');
    const bytes = await renderReportPdf(list, filters, await this.company(principal), this.expenses.clock());
    return this.pdf(reply, bytes, `fleet-expenses-${q.from ?? 'all'}-${q.to ?? 'today'}.pdf`);
  }

  @RequireAnyPermission('maintenance_costs.view', 'accounting.view')
  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  detail(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.expenses.detail(principal, id);
  }

  @RequireAnyPermission('maintenance_costs.view', 'accounting.view')
  @Get(':id/pdf')
  async expensePdf(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Res() reply: FastifyReply) {
    const detail = await this.expenses.detail(principal, id);
    const bytes = await renderExpensePdf(detail, await this.company(principal), this.expenses.clock());
    return this.pdf(reply, bytes, `${detail.reference}.pdf`);
  }

  @Post()
  @RequireAnyPermission('maintenance.edit', 'accounting.edit')
  create(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    return this.expenses.create(principal, body);
  }

  @Patch(':id')
  @RequireAnyPermission('maintenance.edit', 'accounting.edit')
  update(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.expenses.update(principal, id, body);
  }

  @Post(':id/void')
  @RequireAnyPermission('maintenance.edit', 'accounting.edit')
  void(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(ReasonSchema)) body: z.infer<typeof ReasonSchema>) {
    return this.expenses.void(principal, id, body.reason);
  }

  @Post(':id/post')
  @RequireAnyPermission('accounting.edit')
  post(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.expenses.post(principal, id);
  }

  @Post(':id/recovery')
  @RequireAnyPermission('accounting.edit')
  recovery(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.expenses.recovery(principal, id, body);
  }

  @Post(':id/files')
  @RequireAnyPermission('maintenance.edit', 'accounting.edit')
  addFile(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(FileSchema)) body: z.infer<typeof FileSchema>) {
    return this.expenses.addFile(principal, id, body);
  }

  @Post(':id/files/:fileRowId/remove')
  @RequireAnyPermission('maintenance.edit', 'accounting.edit')
  removeFile(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Param('fileRowId') fileRowId: string, @Body(new ZodValidationPipe(RemoveFileSchema)) body: z.infer<typeof RemoveFileSchema>) {
    return this.expenses.removeFile(principal, id, fileRowId, body.reason);
  }
}
