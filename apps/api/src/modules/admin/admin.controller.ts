import { z } from 'zod';
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  AccountQuerySchema,
  CreateAccountSchema,
  CreateDepartmentSchema,
  CreateRoleSchema,
  INVITATION_DELIVERY,
  RoleQuerySchema,
  SetAccountEmployeeSchema,
  SetAccountRolesSchema,
  SetAccountStatusSchema,
  SetPasswordRequestSchema,
  UpdateDepartmentSchema,
  UpdateRoleSchema,
  type AccountQuery,
  type Department,
  type Role,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import {
  RequireAnyPermission,
  RequirePermission,
} from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { AuditLogService } from './audit-log.service';
import { DepartmentsService } from './departments.service';
import { RolesService } from './roles.service';
import { UsersService, type AccountRecord, type CreatedAccount } from './users.service';

/** One pipe per request shape, built once at module load. */
const pipe = {
  accountQuery: new ZodValidationPipe(AccountQuerySchema),
  createAccount: new ZodValidationPipe(CreateAccountSchema),
  accountStatus: new ZodValidationPipe(SetAccountStatusSchema),
  accountRoles: new ZodValidationPipe(SetAccountRolesSchema),
  accountEmployee: new ZodValidationPipe(SetAccountEmployeeSchema),
  roleQuery: new ZodValidationPipe(RoleQuerySchema),
  createRole: new ZodValidationPipe(CreateRoleSchema),
  updateRole: new ZodValidationPipe(UpdateRoleSchema),
  setPassword: new ZodValidationPipe(SetPasswordRequestSchema),
  createDepartment: new ZodValidationPipe(CreateDepartmentSchema),
  updateDepartment: new ZodValidationPipe(UpdateDepartmentSchema),
} as const;

/**
 * Accounts, roles and departments.
 *
 * Every route carries `@RequirePermission`, enforced by `PermissionGuard` before the handler runs.
 * The web app hides buttons the principal cannot use, but that is a courtesy — the permission is
 * checked here, on the request, with no way around it. A hidden button is not a permission system.
 *
 * `CompanyScopeGuard` rejects any attempt to pick a company through the query string; the company
 * comes from the principal and nowhere else, and every service query filters on it.
 */
@Controller('admin')
@UseGuards(CompanyScopeGuard, PermissionGuard)
export class AdminController {
  constructor(
    private readonly users: UsersService,
    private readonly roles: RolesService,
    private readonly departments: DepartmentsService,
    private readonly auditLog: AuditLogService,
  ) {}

  // ===================================================================================== users

  @Get('users')
  @RequirePermission('users.view')
  listUsers(
    @CurrentPrincipal() principal: Principal,
    @Query(pipe.accountQuery) query: AccountQuery,
  ) {
    return this.users.list(principal, query);
  }

  @Get('users/summary')
  @RequirePermission('users.view')
  userSummary(@CurrentPrincipal() principal: Principal) {
    return this.users.summary(principal);
  }

  /** Employees who could be given an account. Drives the link picker on the create form. */
  @Get('users/linkable-employees')
  @RequireAnyPermission('users.create', 'users.edit')
  linkableEmployees(@CurrentPrincipal() principal: Principal) {
    return this.users.linkableEmployees(principal);
  }

  /**
   * Whether an invitation actually goes anywhere.
   *
   * Returned as its own fact so the create form can say "no email will be sent" instead of
   * implying one will. There is no mail transport in this deployment.
   */
  @Get('users/invitation-delivery')
  @RequirePermission('users.view')
  invitationDelivery() {
    return INVITATION_DELIVERY;
  }

  @Get('users/:membershipId')
  @RequirePermission('users.view')
  getUser(
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
  ): Promise<AccountRecord> {
    return this.users.get(principal, membershipId);
  }

  /** Everything this account can actually do, resolved from every role it holds. */
  @Get('users/:membershipId/permissions')
  @RequirePermission('users.view')
  effectivePermissions(
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
  ) {
    return this.users.effectivePermissions(principal, membershipId);
  }

  @Get('users/:membershipId/activity')
  @RequirePermission('users.view', 'audit.view')
  userActivity(
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
  ) {
    return this.auditLog.forEntity(principal, 'user', membershipId);
  }

  @Post('users')
  @RequirePermission('users.create')
  createUser(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.createAccount)
    body: {
      firstName: string;
      lastName: string;
      email: string;
      phone: string | null;
      employeeId: string | null;
      roleIds: string[];
      invite: boolean;
    },
  ): Promise<CreatedAccount> {
    return this.users.create(principal, body);
  }

  /**
   * A fresh temporary password for an existing account.
   *
   * Shown to the administrator once. Used for an account seeded without a credential and for the
   * ordinary "they forgot it" case.
   */
  @Post('users/:membershipId/temporary-password')
  @RequirePermission('users.edit')
  issueTemporaryPassword(
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
  ): Promise<CreatedAccount> {
    return this.users.issueTemporaryPassword(principal, membershipId);
  }

  @Post('users/:membershipId/password')
  @RequirePermission('users.edit')
  setUserPassword(
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
    @Body(pipe.setPassword) body: { password: string },
  ): Promise<AccountRecord> {
    return this.users.setPassword(principal, membershipId, body.password);
  }

  @Patch('users/:membershipId/email')
  @RequirePermission('users.edit')
  changeUserEmail(
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
    @Body(new ZodValidationPipe(z.object({ email: z.email('That is not a valid email address').max(200) }))) body: { email: string },
  ): Promise<AccountRecord> {
    return this.users.changeEmail(principal, membershipId, body.email);
  }

  @Patch('users/:membershipId/status')
  @RequirePermission('users.edit')
  setUserStatus(
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
    @Body(pipe.accountStatus) body: { status: string; reason: string | null },
  ): Promise<AccountRecord> {
    return this.users.setStatus(principal, membershipId, body.status, body.reason);
  }

  /** Links the account to its employee record (or unlinks it with null). */
  @Patch('users/:membershipId/employee')
  @RequirePermission('users.edit')
  setUserEmployee(
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
    @Body(pipe.accountEmployee) body: { employeeId: string | null },
  ): Promise<AccountRecord> {
    return this.users.setEmployee(principal, membershipId, body.employeeId);
  }

  @Patch('users/:membershipId/roles')
  @RequirePermission('users.assign')
  setUserRoles(
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
    @Body(pipe.accountRoles) body: { roleIds: string[] },
  ): Promise<AccountRecord> {
    return this.users.setRoles(principal, membershipId, body.roleIds);
  }

  // ===================================================================================== roles

  /** The permission matrix, so the UI never invents a permission list of its own. */
  @Get('permissions')
  @RequirePermission('roles.view')
  permissionMatrix() {
    return this.roles.matrix();
  }

  @Get('roles')
  @RequirePermission('roles.view')
  listRoles(
    @CurrentPrincipal() principal: Principal,
    @Query(pipe.roleQuery) query: { search?: string; includeArchived: boolean },
  ): Promise<Role[]> {
    return this.roles.list(principal, query);
  }

  @Get('roles/:id')
  @RequirePermission('roles.view')
  getRole(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<Role> {
    return this.roles.get(principal, id);
  }

  @Post('roles')
  @RequirePermission('roles.create')
  createRole(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.createRole)
    body: {
      name: string;
      description: string | null;
      permissions: string[];
      copyFromRoleId: string | null;
    },
  ): Promise<Role> {
    return this.roles.create(principal, body);
  }

  @Patch('roles/:id')
  @RequirePermission('roles.edit')
  updateRole(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.updateRole)
    body: { name?: string; description?: string | null; permissions?: string[] },
  ): Promise<Role> {
    return this.roles.update(principal, id, body);
  }

  @Post('roles/:id/archive')
  @RequirePermission('roles.archive')
  archiveRole(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<Role> {
    return this.roles.archive(principal, id);
  }

  // =============================================================================== departments

  @Get('departments')
  @RequirePermission('departments.view')
  listDepartments(@CurrentPrincipal() principal: Principal): Promise<Department[]> {
    return this.departments.list(principal);
  }

  @Get('departments/tree')
  @RequirePermission('departments.view')
  departmentTree(@CurrentPrincipal() principal: Principal) {
    return this.departments.tree(principal);
  }

  @Post('departments')
  @RequirePermission('departments.create')
  createDepartment(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.createDepartment)
    body: {
      code: string;
      name: string;
      description: string | null;
      parentDepartmentId: string | null;
      managerEmployeeId: string | null;
    },
  ): Promise<Department> {
    return this.departments.create(principal, body);
  }

  @Patch('departments/:id')
  @RequirePermission('departments.edit')
  updateDepartment(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.updateDepartment)
    body: {
      name?: string;
      description?: string | null;
      parentDepartmentId?: string | null;
      managerEmployeeId?: string | null;
      status?: string;
    },
  ): Promise<Department> {
    return this.departments.update(principal, id, body);
  }
}
