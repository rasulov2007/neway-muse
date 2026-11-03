import { Body, Controller, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  AddNoteSchema,
  AssignRequestSchema,
  CreateCareLinkSchema,
  DriverMessageSchema,
  DriverRelationListQuerySchema,
  LinkRecordsSchema,
  RecordAttemptSchema,
  RecordContactSchema,
  ReopenRequestSchema,
  ResolveRequestSchema,
  UpdateCareLinkSchema,
} from '@neway/shared';
import { z } from 'zod';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { DriverRelationsService } from './driver-relations.service';

const pipe = {
  list: new ZodValidationPipe(DriverRelationListQuerySchema),
  assign: new ZodValidationPipe(AssignRequestSchema),
  attempt: new ZodValidationPipe(RecordAttemptSchema),
  contact: new ZodValidationPipe(RecordContactSchema),
  note: new ZodValidationPipe(AddNoteSchema),
  resolve: new ZodValidationPipe(ResolveRequestSchema),
  reopen: new ZodValidationPipe(ReopenRequestSchema),
  message: new ZodValidationPipe(DriverMessageSchema),
  link: new ZodValidationPipe(LinkRecordsSchema),
  roster: new ZodValidationPipe(z.object({ q: z.string().trim().max(80).optional() })),
  createLink: new ZodValidationPipe(CreateCareLinkSchema),
  updateLink: new ZodValidationPipe(UpdateCareLinkSchema),
} as const;

/**
 * Driver Relations, for staff. Reading takes `driver_relations.view` (the read-only path); every
 * action on a request takes `driver_relations.contact`; the public Driver Care links take
 * `driver_relations.manage`. Every route reads and writes only the principal's company.
 */
@Controller('driver-relations')
@UseGuards(CompanyScopeGuard, PermissionGuard)
export class DriverRelationsController {
  constructor(private readonly service: DriverRelationsService) {}

  /** The badge and the cards: requests needing contact, per topic and in total. */
  @Get('counts')
  @RequirePermission('driver_relations.view')
  counts(@CurrentPrincipal() principal: Principal) {
    return this.service.counts(principal);
  }

  @Get('requests')
  @RequirePermission('driver_relations.view')
  list(@CurrentPrincipal() principal: Principal, @Query(pipe.list) query: z.output<typeof DriverRelationListQuerySchema>) {
    return this.service.list(principal, query);
  }

  @Get('requests/:id')
  @RequirePermission('driver_relations.view')
  detail(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.service.detail(principal, id);
  }

  /**
   * A receipt's bytes, only through here: signed in, driver_relations.view, the principal's
   * company, and confidential requests only with driver_relations.confidential. Guessed ids 404.
   */
  @Get('requests/:id/attachments/:attachmentId')
  @RequirePermission('driver_relations.view')
  async attachment(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { file, bytes } = await this.service.attachment(principal, id, attachmentId);
    const name = file.originalFileName.replace(/[^\w.-]+/g, '_');
    await reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(bytes);
  }

  @Patch('requests/:id/assignment')
  @RequirePermission('driver_relations.contact')
  assign(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.assign) body: z.output<typeof AssignRequestSchema>,
  ) {
    return this.service.assign(principal, id, body);
  }

  @Post('requests/:id/attempts')
  @RequirePermission('driver_relations.contact')
  attempt(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.attempt) body: z.output<typeof RecordAttemptSchema>,
  ) {
    return this.service.attempt(principal, id, body);
  }

  @Post('requests/:id/contact')
  @RequirePermission('driver_relations.contact')
  contact(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.contact) body: z.output<typeof RecordContactSchema>,
  ) {
    return this.service.contact(principal, id, body);
  }

  @Post('requests/:id/notes')
  @RequirePermission('driver_relations.contact')
  note(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.note) body: z.output<typeof AddNoteSchema>,
  ) {
    return this.service.addNote(principal, id, body);
  }

  @Post('requests/:id/resolve')
  @RequirePermission('driver_relations.contact')
  resolve(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.resolve) body: z.output<typeof ResolveRequestSchema>,
  ) {
    return this.service.resolve(principal, id, body);
  }

  @Post('requests/:id/reopen')
  @RequirePermission('driver_relations.contact')
  reopen(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.reopen) body: z.output<typeof ReopenRequestSchema>,
  ) {
    return this.service.reopen(principal, id, body);
  }

  @Post('requests/:id/driver-messages')
  @RequirePermission('driver_relations.contact')
  driverMessage(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.message) body: z.output<typeof DriverMessageSchema>,
  ) {
    return this.service.driverMessage(principal, id, body);
  }

  @Patch('requests/:id/links')
  @RequirePermission('driver_relations.contact')
  link(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.link) body: z.output<typeof LinkRecordsSchema>,
  ) {
    return this.service.link(principal, id, body);
  }

  @Get('assignees')
  @RequirePermission('driver_relations.view')
  assignees(@CurrentPrincipal() principal: Principal) {
    return this.service.assignees(principal);
  }

  @Get('roster-options')
  @RequirePermission('driver_relations.contact')
  rosterOptions(@CurrentPrincipal() principal: Principal, @Query(pipe.roster) query: { q?: string }) {
    return this.service.rosterOptions(principal, query.q);
  }

  /** "Telegram: Not connected" until the owner configures and enables it. Never the token. */
  @Get('integration')
  @RequirePermission('driver_relations.view')
  integration() {
    return this.service.integrationStatus();
  }

  @Get('care-links')
  @RequirePermission('driver_relations.view')
  careLinks(@CurrentPrincipal() principal: Principal) {
    return this.service.listCareLinks(principal);
  }

  @Post('care-links')
  @RequirePermission('driver_relations.manage')
  createCareLink(@CurrentPrincipal() principal: Principal, @Body(pipe.createLink) body: z.output<typeof CreateCareLinkSchema>) {
    return this.service.createCareLink(principal, body);
  }

  @Patch('care-links/:id')
  @RequirePermission('driver_relations.manage')
  updateCareLink(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.updateLink) body: z.output<typeof UpdateCareLinkSchema>,
  ) {
    return this.service.updateCareLink(principal, id, body);
  }
}
