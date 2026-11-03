import { Body, Controller, Get, HttpCode, Param, Post, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DotAppDecisionSchema,
  DotAppEmployerFormsSchema,
  DotAppHireSchema,
  DotAppIssueSchema,
  DotAppOnboardingSchema,
  DotAppRejectSchema,
  DotAppRequestChangesSchema,
  DotAppSignSchema,
  DotAppTemplateCreateSchema,
  type DotAppHireInput,
  type DotAppIssueInput,
  type DotAppSignInput,
} from '@neway/shared';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { SignedDownload } from '../../common/auth/signed-download';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { DotApplicationSafetyService, SAFETY_REVIEW_PERMISSION, SSN_PERMISSION } from './dot-application-safety.service';
import { DotApplicationService } from './dot-application.service';
import { DotAppTemplatesService, TEMPLATES_PERMISSION } from './templates.service';

async function sendFile(reply: FastifyReply, file: { fileName: string; contentType: string; bytes: Buffer }): Promise<void> {
  const name = file.fileName.replace(/[^\w.-]+/g, '_');
  await reply
    .header('content-type', file.contentType)
    .header('content-disposition', `inline; filename="${name}"`)
    .header('cache-control', 'private, no-store')
    .header('x-content-type-options', 'nosniff')
    .send(file.bytes);
}

/** Recruiting → candidate → "Send application" (step 5), for the candidate's own company. */
@Controller('hiring/recruiting/candidates/:key/dot-application')
export class RecruiterDotApplicationController {
  constructor(private readonly apps: DotApplicationService) {}

  @Get()
  @RequirePermission('recruiting.view')
  view(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.apps.recruiterView(principal, key);
  }

  /** Create (or reuse) the application and send a fresh link: email (Resend) and/or Copy link. */
  @Post('link')
  @HttpCode(201)
  @RequirePermission('recruiting.manage')
  issue(@CurrentPrincipal() principal: Principal, @Param('key') key: string, @Body(new ZodValidationPipe(DotAppIssueSchema)) body: DotAppIssueInput) {
    return this.apps.issue(principal, key, body);
  }

  @Post('link/copied')
  @HttpCode(200)
  @RequirePermission('recruiting.manage')
  copied(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.apps.markCopied(principal, key);
  }

  @Post('link/revoke')
  @HttpCode(200)
  @RequirePermission('recruiting.manage')
  revoke(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.apps.revoke(principal, key);
  }
}

const SaveNoteSchema = z.object({ note: z.string().trim().max(4000) });

/** Safety → Applications review: the company's queue and one application (internal only). */
@Controller('safety/dot-applications')
@RequirePermission(SAFETY_REVIEW_PERMISSION)
export class SafetyDotApplicationController {
  constructor(private readonly safety: DotApplicationSafetyService) {}

  @Get()
  queue(@CurrentPrincipal() principal: Principal) {
    return this.safety.queue(principal);
  }

  @Get(':id')
  detail(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.safety.detail(principal, id);
  }

  @Put(':id/employer-forms')
  employerForms(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(DotAppEmployerFormsSchema)) body: { version: number; employerForms: Record<string, unknown> }) {
    return this.safety.saveEmployerForms(principal, id, body.version, body.employerForms, 'employerForms');
  }

  @Put(':id/onboarding')
  onboarding(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(DotAppOnboardingSchema)) body: { version: number; onboarding: Record<string, unknown> }) {
    return this.safety.saveEmployerForms(principal, id, body.version, body.onboarding, 'onboarding');
  }

  @Post(':id/signatures')
  @HttpCode(201)
  sign(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(DotAppSignSchema)) body: DotAppSignInput, @Req() request: FastifyRequest) {
    const ua = request.headers['user-agent'];
    return this.safety.employerSign(principal, id, body, { ip: request.ip, userAgent: typeof ua === 'string' ? ua : null });
  }

  @Post(':id/request-changes')
  @HttpCode(200)
  requestChanges(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(DotAppRequestChangesSchema)) body: { sections: string[]; message: string }) {
    return this.safety.requestChanges(principal, id, body.sections, body.message);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(DotAppDecisionSchema)) body: { note?: string }) {
    return this.safety.approve(principal, id, body.note);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(DotAppRejectSchema)) body: { reason: string }) {
    return this.safety.reject(principal, id, body.reason);
  }

  @Post(':id/hire')
  @HttpCode(200)
  hire(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(DotAppHireSchema)) body: DotAppHireInput) {
    return this.safety.hire(principal, id, body);
  }

  @Post(':id/note')
  @HttpCode(200)
  note(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(SaveNoteSchema)) body: { note: string }) {
    return this.safety.saveNote(principal, id, body.note);
  }

  @Post(':id/ssn')
  @HttpCode(200)
  @RequirePermission(SSN_PERMISSION)
  ssn(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.safety.revealSsn(principal, id);
  }

  @Post(':id/bank')
  @HttpCode(200)
  @RequirePermission(SSN_PERMISSION)
  bank(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.safety.revealBank(principal, id);
  }

  @SignedDownload()
  @Get(':id/files/:fileId')
  async file(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Param('fileId') fileId: string, @Res() reply: FastifyReply) {
    await sendFile(reply, await this.safety.fileBytes(principal, id, fileId));
  }

  @SignedDownload()
  @Get(':id/signatures/:key/image')
  async signature(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Param('key') key: string, @Res() reply: FastifyReply) {
    await sendFile(reply, await this.safety.signatureImage(principal, id, key));
  }

  @SignedDownload()
  @Get(':id/pdf')
  async pdf(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Res() reply: FastifyReply) {
    await sendFile(reply, await this.safety.pdf(principal, id));
  }
}

const RetireSchema = z.object({ reason: z.string().trim().min(3, 'Say why.').max(500) });
const ImportSchema = z.object({ setId: z.string().min(1).max(80) });

/** Admin → Document templates: each company's driver-application legal documents. */
@Controller('admin/application-templates')
@RequirePermission(TEMPLATES_PERMISSION)
export class ApplicationTemplatesController {
  constructor(private readonly templates: DotAppTemplatesService) {}

  @Get()
  overview(@CurrentPrincipal() principal: Principal) {
    return this.templates.overview(principal);
  }

  @Get(':id')
  one(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.templates.one(principal, id);
  }

  @Post()
  @HttpCode(201)
  create(@CurrentPrincipal() principal: Principal, @Body(new ZodValidationPipe(DotAppTemplateCreateSchema)) body: z.infer<typeof DotAppTemplateCreateSchema>) {
    return this.templates.create(principal, body);
  }

  @Post('import')
  @HttpCode(200)
  importSet(@CurrentPrincipal() principal: Principal, @Body(new ZodValidationPipe(ImportSchema)) body: { setId: string }) {
    return this.templates.importSet(principal, body.setId);
  }

  @Post('approve-drafts')
  @HttpCode(200)
  approveAll(@CurrentPrincipal() principal: Principal) {
    return this.templates.approveAllDrafts(principal);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.templates.approve(principal, id);
  }

  @Post(':id/retire')
  @HttpCode(200)
  retire(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(RetireSchema)) body: { reason: string }) {
    return this.templates.retire(principal, id, body.reason);
  }
}

