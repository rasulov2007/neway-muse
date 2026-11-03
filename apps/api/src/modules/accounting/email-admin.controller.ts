import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { AuditService } from '../people/audit.service';
import { EmailTransport } from './email.transport';

/**
 * Email in Settings › Integrations: which transport the server uses (never its secrets) and a test
 * message. "Accepted" is the mail server's word, not delivery; a refusal shows the provider's reason.
 */
@Controller('admin/email')
@UseGuards(CompanyScopeGuard, PermissionGuard)
@RequirePermission('integrations.manage')
export class EmailAdminController {
  constructor(
    private readonly mail: EmailTransport,
    private readonly audit: AuditService,
  ) {}

  @Get()
  status() {
    const t = this.mail.describe();
    return { kind: t.kind, from: t.from, detail: t.detail, ready: t.kind === 'smtp' || t.kind === 'graph' || t.kind === 'file' };
  }

  @Post('test')
  @HttpCode(200)
  async test(@CurrentPrincipal() principal: Principal, @Body(new ZodValidationPipe(z.object({ to: z.string().trim().email().max(160) }))) body: { to: string }) {
    const t = this.mail.describe();
    if (t.kind === 'none') return { ok: false, detail: `Not sent: ${t.detail}.` };
    let result: { ok: boolean; detail: string };
    try {
      const sent = await this.mail.send({
        to: body.to,
        subject: 'NeWay TMS test email',
        text: `This is a test from NeWay TMS (${t.detail}). If you can read it, recruiting emails can be sent.`,
        attachments: [],
      });
      result = { ok: true, detail: `${sent.info}. Accepted is not delivered: check the inbox (and spam).` };
    } catch (error) {
      result = { ok: false, detail: `Not sent: ${error instanceof Error ? error.message : String(error)}` };
    }
    await this.audit.write(principal, {
      action: result.ok ? 'email_test_sent' : 'email_test_failed',
      entityType: 'integration',
      entityId: 'email',
      entityLabel: 'Email',
      summary: `Test email to ${body.to}: ${result.detail}`,
    });
    return result;
  }
}
