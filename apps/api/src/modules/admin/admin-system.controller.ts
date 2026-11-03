import { Body, Controller, Get, Header, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  ArchiveIntegrationSchema,
  AuditQuerySchema,
  ConnectIntegrationSchema,
  CreateWorkflowSchema,
  RenameIntegrationSchema,
  ReplaceCredentialSchema,
  SetIntegrationStatusSchema,
  SyncRequestSchema,
  UpdateSettingsSchema,
  UpdateWorkflowSchema,
  type AuditQuery,
  type SyncRequest,
  type WorkflowAction,
  type WorkflowCondition,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { AuditLogService } from './audit-log.service';
import { SamsaraSyncService } from './connectors/samsara-sync.service';
import { RelaySyncService } from './connectors/relay-sync.service';
import { MotiveSyncService } from './connectors/motive-sync.service';
import { FiveEldSyncService } from './connectors/fiveeld-sync.service';
import { TwilioService } from './connectors/twilio.service';
import { RtsFtpService } from './connectors/rts-ftp.service';
import { AzureSpeechService } from './connectors/azure-speech.service';
import { IntegrationsService } from './integrations.service';
import { NotificationsService } from './notifications.service';
import { SettingsService } from './settings.service';
import { WorkflowsService } from './workflows.service';
import { SignedInOnly } from '../../common/auth/signed-in-only.decorator';

/** One pipe per request shape, built once at module load. */
const pipe = {
  auditQuery: new ZodValidationPipe(AuditQuerySchema),
  connect: new ZodValidationPipe(ConnectIntegrationSchema),
  replaceCredential: new ZodValidationPipe(ReplaceCredentialSchema),
  renameIntegration: new ZodValidationPipe(RenameIntegrationSchema),
  integrationStatus: new ZodValidationPipe(SetIntegrationStatusSchema),
  archiveIntegration: new ZodValidationPipe(ArchiveIntegrationSchema),
  sync: new ZodValidationPipe(SyncRequestSchema),
  createWorkflow: new ZodValidationPipe(CreateWorkflowSchema),
  updateWorkflow: new ZodValidationPipe(UpdateWorkflowSchema),
  settings: new ZodValidationPipe(UpdateSettingsSchema),
} as const;

/**
 * Integrations, workflows, the audit trail, settings and notifications.
 *
 * The audit routes are read-only, and that is the whole design: there is no PATCH and no DELETE
 * here, and `AuditLogService` has no write method for one to call. An audit an administrator can
 * edit is not an audit.
 */
@Controller('admin')
@UseGuards(CompanyScopeGuard, PermissionGuard)
export class AdminSystemController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly samsara: SamsaraSyncService,
    private readonly relay: RelaySyncService,
    private readonly motive: MotiveSyncService,
    private readonly fiveEld: FiveEldSyncService,
    private readonly twilio: TwilioService,
    private readonly rts: RtsFtpService,
    private readonly azureSpeech: AzureSpeechService,
    private readonly workflows: WorkflowsService,
    private readonly auditLog: AuditLogService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ============================================================================== integrations
  //
  // Keyed on the account, never on the provider: a company may hold two Samsara organisations,
  // and "the Samsara credential" would name neither of them.

  @Get('integrations')
  @RequirePermission('integrations.view')
  listIntegrations(@CurrentPrincipal() principal: Principal) {
    return this.integrations.list(principal);
  }

  @Get('integrations/accounts/:id')
  @RequirePermission('integrations.view')
  getIntegration(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.integrations.get(principal, id);
  }

  @Get('integrations/accounts/:id/runs')
  @RequirePermission('integrations.view')
  syncRuns(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.integrations.syncRuns(principal, id);
  }

  /**
   * Adds an account with its credential. Always a new row.
   *
   * The request body is the only place a secret ever appears. It is encrypted before it reaches
   * the database, and no endpoint on this controller can read it back — the response carries a
   * four-character hint and nothing else.
   */
  @Post('integrations/connect')
  @RequirePermission('integrations.manage')
  connect(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.connect) body: { provider: string; name?: string; credentials: Record<string, string> },
  ) {
    return this.integrations.connect(principal, body);
  }

  @Post('integrations/accounts/:id/credentials')
  @RequirePermission('integrations.manage')
  replaceCredential(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.replaceCredential) body: { credentials: Record<string, string> },
  ) {
    return this.integrations.replaceCredential(principal, id, body.credentials);
  }

  @Patch('integrations/accounts/:id')
  @RequirePermission('integrations.manage')
  renameIntegration(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.renameIntegration) body: { name: string },
  ) {
    return this.integrations.rename(principal, id, body.name);
  }

  @Patch('integrations/accounts/:id/status')
  @RequirePermission('integrations.manage')
  setIntegrationStatus(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.integrationStatus) body: { status: 'credentials_stored' | 'disabled' },
  ) {
    return this.integrations.setStatus(principal, id, body.status);
  }

  @Post('integrations/accounts/:id/disconnect')
  @RequirePermission('integrations.manage')
  disconnect(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.integrations.disconnect(principal, id);
  }

  /** Hides an account that holds no credential. Kept on record, reversible, audited. 409 while a credential is stored. */
  @Post('integrations/accounts/:id/archive')
  @RequirePermission('integrations.manage')
  archiveIntegration(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.archiveIntegration) body: { reason?: string },
  ) {
    return this.integrations.archive(principal, id, body?.reason);
  }

  @Post('integrations/accounts/:id/unarchive')
  @RequirePermission('integrations.manage')
  unarchiveIntegration(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.integrations.unarchive(principal, id);
  }

  /** Asks the provider who the token belongs to. The only way an account earns `connected`. */
  @Post('integrations/accounts/:id/test')
  @RequirePermission('integrations.manage')
  async testIntegration(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return (await this.connectorFor(principal, id)).test(principal, id);
  }

  /**
   * Syncs one account into the roster, or previews what a sync would do.
   *
   * `dryRun: true` changes nothing and returns the full report; the screen shows that before
   * anyone applies. Read-only against the provider in both cases.
   */
  @Post('integrations/accounts/:id/sync')
  @RequirePermission('integrations.manage')
  async syncIntegration(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.sync) body: SyncRequest,
  ) {
    return (await this.connectorFor(principal, id)).sync(principal, id, body);
  }

  /**
   * The connector that speaks this account's provider. Each one re-checks the provider itself, so
   * a wrong route here would fail loudly rather than read Relay with a Samsara token.
   */
  private async connectorFor(principal: Principal, id: string): Promise<SamsaraSyncService | MotiveSyncService | FiveEldSyncService | RelaySyncService | TwilioService | RtsFtpService | AzureSpeechService> {
    const { account } = await this.integrations.get(principal, id);
    if (account.provider === 'rts') return this.rts;
    if (account.provider === 'azure_speech') return this.azureSpeech;
    if (account.provider === 'motive') return this.motive;
    if (account.provider === 'fiveeld') return this.fiveEld;
    return account.provider === 'relay' ? this.relay : account.provider === 'twilio' ? this.twilio : this.samsara;
  }

  // ================================================================================= workflows

  /** Triggers and actions that actually exist, including which actions are not implemented. */
  @Get('workflows/catalog')
  @RequirePermission('workflows.view')
  workflowCatalog() {
    return this.workflows.catalog();
  }

  @Get('workflows')
  @RequirePermission('workflows.view')
  listWorkflows(@CurrentPrincipal() principal: Principal) {
    return this.workflows.list(principal);
  }

  @Get('workflows/summary')
  @RequirePermission('workflows.view')
  workflowSummary(@CurrentPrincipal() principal: Principal) {
    return this.workflows.summary(principal);
  }

  @Get('workflows/runs')
  @RequirePermission('workflows.view')
  allRuns(@CurrentPrincipal() principal: Principal, @Query('ruleId') ruleId?: string) {
    return this.workflows.runs(principal, ruleId);
  }

  @Get('workflows/:id')
  @RequirePermission('workflows.view')
  getWorkflow(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.workflows.get(principal, id);
  }

  @Post('workflows')
  @RequirePermission('workflows.create')
  createWorkflow(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.createWorkflow) body: {
      name: string;
      description: string | null;
      trigger: string;
      conditions: WorkflowCondition[];
      actions: WorkflowAction[];
      status: string;
    },
  ) {
    return this.workflows.create(principal, body);
  }

  @Patch('workflows/:id')
  @RequirePermission('workflows.edit')
  updateWorkflow(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.updateWorkflow) body: {
      name?: string;
      description?: string | null;
      conditions?: WorkflowCondition[];
      actions?: WorkflowAction[];
      status?: string;
    },
  ) {
    return this.workflows.update(principal, id, body);
  }

  // ================================================================================ audit logs

  @Get('audit')
  @RequirePermission('audit.view')
  listAudit(
    @CurrentPrincipal() principal: Principal,
    @Query(pipe.auditQuery) query: AuditQuery,
  ) {
    return this.auditLog.list(principal, query);
  }

  @Get('audit/facets')
  @RequirePermission('audit.view')
  auditFacets(@CurrentPrincipal() principal: Principal) {
    return this.auditLog.facets(principal);
  }

  @Get('audit/export')
  @RequirePermission('audit.export')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="audit-log.csv"')
  exportAudit(
    @CurrentPrincipal() principal: Principal,
    @Query(pipe.auditQuery) query: AuditQuery,
  ): Promise<string> {
    return this.auditLog.exportCsv(principal, query);
  }

  @Get('audit/:id')
  @RequirePermission('audit.view')
  getAudit(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.auditLog.get(principal, id);
  }

  // ================================================================================== settings

  @Get('settings')
  @RequirePermission('settings.view')
  async listSettings(@CurrentPrincipal() principal: Principal) {
    return {
      settings: await this.settings.all(principal),
      notEnforced: this.settings.notEnforced(),
    };
  }

  @Patch('settings')
  @RequirePermission('settings.edit')
  updateSettings(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.settings) body: { values: Record<string, unknown> },
  ) {
    return this.settings.update(principal, body.values);
  }

  // ====================================================================== the acting principal

  /**
   * Who the request is running as, and what they may do.
   *
   * No permission is required to ask about yourself. The web app uses this to decide which
   * controls to draw — the answer is only ever a courtesy, since every protected route checks the
   * same permission again on the server before doing anything.
   */
  @SignedInOnly('own account and permissions only')
  @Get('me')
  me(@CurrentPrincipal() principal: Principal) {
    return {
      userId: principal.userId,
      name: principal.userName ?? principal.userId,
      companyId: principal.companyId,
      timezone: principal.companyTimezone,
      roles: principal.roles,
      permissions: [...principal.permissions].sort(),
    };
  }

  // ============================================================================= notifications

  @SignedInOnly('own notifications only')
  @Get('notifications')
  notificationList(@CurrentPrincipal() principal: Principal) {
    return this.notifications.list(principal);
  }

  @SignedInOnly('own notifications only')
  @Get('notifications/unread-count')
  unreadCount(@CurrentPrincipal() principal: Principal) {
    return this.notifications.unreadCount(principal);
  }

  @SignedInOnly('own notifications only')
  @Post('notifications/:id/read')
  markRead(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.notifications.markRead(principal, id);
  }

  @SignedInOnly('own notifications only')
  @Post('notifications/read-all')
  markAllRead(@CurrentPrincipal() principal: Principal) {
    return this.notifications.markAllRead(principal);
  }
}
