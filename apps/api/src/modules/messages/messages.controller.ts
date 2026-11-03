import { Body, Controller, Get, Header, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  DriverStartConversationSchema,
  MESSAGE_OFFICE_PERMISSIONS,
  OfficeStartConversationSchema,
  PostMessageSchema,
  type ConversationsResponse,
  type ConversationThread,
  type MessageFileLink,
  type MessageView,
} from '@neway/shared';
import { z } from 'zod';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import type { Principal } from '../../common/auth/principal';
import { RequireAnyPermission, RequirePermission } from '../../common/auth/require-permission.decorator';
import { AppError } from '../../common/errors/app-error';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { DriverContextService } from '../mobile/driver-context.service';
import { IdempotencyService } from '../mobile/idempotency.service';
import { MessagesService, type Viewer } from './messages.service';

const driverStart = new ZodValidationPipe(DriverStartConversationSchema);
const officeStart = new ZodValidationPipe(OfficeStartConversationSchema);
const postMessage = new ZodValidationPipe(PostMessageSchema);

const SCOPES = ['mine', 'department', 'all'] as const;

/**
 * The driver's conversations (docs/mobile/API.md §8). The driver is resolved on the server; a
 * driver only ever sees conversations they take part in. Every POST carries an Idempotency-Key.
 */
@Controller('driver/conversations')
export class DriverMessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly context: DriverContextService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private async viewer(principal: Principal): Promise<Viewer> {
    const ctx = await this.context.resolve(principal);
    return { side: 'driver', principal, driverId: ctx.driverId, driverName: ctx.driverName };
  }

  @Get()
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  async list(@CurrentPrincipal() principal: Principal): Promise<ConversationsResponse> {
    return this.messages.list(await this.viewer(principal));
  }

  @Get(':id/messages')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  async thread(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<ConversationThread> {
    return this.messages.thread(await this.viewer(principal), id);
  }

  @Post()
  @HttpCode(200)
  @RequirePermission('driver_app.use')
  async start(
    @CurrentPrincipal() principal: Principal,
    @Body(driverStart) body: z.infer<typeof DriverStartConversationSchema>,
    @Headers('idempotency-key') key?: string,
  ): Promise<ConversationThread> {
    const viewer = await this.viewer(principal);
    return this.idempotency.run(principal, key, 'POST /driver/conversations', async () => {
      await this.messages.checkAttachments(viewer, body.attachmentFileIds ?? []);
      const conversation = await this.messages.start(viewer, { department: body.department, subjectType: body.subjectType ?? null, subjectId: body.subjectId ?? null });
      if (body.body || body.attachmentFileIds?.length) {
        await this.messages.post(viewer, conversation.id, { body: body.body ?? '', attachmentFileIds: body.attachmentFileIds ?? [], idempotencyKey: key ?? null });
      }
      return this.messages.thread(viewer, conversation.id);
    });
  }

  @Post(':id/messages')
  @HttpCode(201)
  @RequirePermission('driver_app.use')
  async post(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(postMessage) body: z.infer<typeof PostMessageSchema>,
    @Headers('idempotency-key') key?: string,
  ): Promise<MessageView> {
    const viewer = await this.viewer(principal);
    return this.idempotency.run(principal, key, `POST /driver/conversations/${id}/messages`, () =>
      this.messages.post(viewer, id, { body: body.body, attachmentFileIds: body.attachmentFileIds, idempotencyKey: key ?? null }),
    );
  }

  @Post(':id/read')
  @HttpCode(200)
  @RequirePermission('driver_app.use')
  async read(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<{ ok: true; readAt: string }> {
    return this.messages.markRead(await this.viewer(principal), id);
  }

  @Get(':id/files/:fileId/link')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  async fileLink(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Param('fileId') fileId: string): Promise<MessageFileLink> {
    return this.messages.fileLink(await this.viewer(principal), id, fileId);
  }
}

/**
 * The office inbox (web Inbox page and the office app). A department's conversations open for the
 * holders of its permission (MESSAGE_DEPARTMENT_PERMISSION); load conversations also need
 * loads.view. The route admits any department code; the service checks the conversation's own.
 */
@Controller('conversations')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  private viewer(principal: Principal): Viewer {
    if (principal.driverId) throw new AppError({ status: 403, title: 'Forbidden', detail: 'Drivers use the driver app inbox.' });
    return { side: 'office', principal };
  }

  @Get()
  @RequireAnyPermission(...MESSAGE_OFFICE_PERMISSIONS)
  @Header('Cache-Control', 'private, no-store')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query('scope') scope?: string,
    @Query('department') department?: string,
    @Query('subjectType') subjectType?: string,
    @Query('subjectId') subjectId?: string,
  ): Promise<ConversationsResponse> {
    if (scope && !(SCOPES as readonly string[]).includes(scope)) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: `scope must be one of ${SCOPES.join(', ')}` });
    }
    return this.messages.list(this.viewer(principal), { scope: scope as (typeof SCOPES)[number] | undefined, department, subjectType, subjectId });
  }

  @Get(':id/messages')
  @RequireAnyPermission(...MESSAGE_OFFICE_PERMISSIONS)
  @Header('Cache-Control', 'private, no-store')
  thread(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<ConversationThread> {
    return this.messages.thread(this.viewer(principal), id);
  }

  /** Find-or-create: the same (department, subject, driver) always opens the same conversation. */
  @Post()
  @HttpCode(200)
  @RequireAnyPermission(...MESSAGE_OFFICE_PERMISSIONS)
  async start(
    @CurrentPrincipal() principal: Principal,
    @Body(officeStart) body: z.infer<typeof OfficeStartConversationSchema>,
    @Headers('idempotency-key') key?: string,
  ): Promise<ConversationThread> {
    const viewer = this.viewer(principal);
    await this.messages.checkAttachments(viewer, body.attachmentFileIds ?? []);
    const conversation = await this.messages.start(viewer, {
      department: body.department,
      driverId: body.driverId ?? null,
      subjectType: body.subjectType ?? null,
      subjectId: body.subjectId ?? null,
      title: body.title,
    });
    if (body.body || body.attachmentFileIds?.length) {
      await this.messages.post(viewer, conversation.id, { body: body.body ?? '', attachmentFileIds: body.attachmentFileIds ?? [], idempotencyKey: key ?? null });
    }
    return this.messages.thread(viewer, conversation.id);
  }

  /** Idempotency-Key optional here (the web sends one per draft): a retry returns the same message. */
  @Post(':id/messages')
  @HttpCode(201)
  @RequireAnyPermission(...MESSAGE_OFFICE_PERMISSIONS)
  post(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(postMessage) body: z.infer<typeof PostMessageSchema>,
    @Headers('idempotency-key') key?: string,
  ): Promise<MessageView> {
    return this.messages.post(this.viewer(principal), id, { body: body.body, attachmentFileIds: body.attachmentFileIds, idempotencyKey: key ?? null });
  }

  @Post(':id/read')
  @HttpCode(200)
  @RequireAnyPermission(...MESSAGE_OFFICE_PERMISSIONS)
  read(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<{ ok: true; readAt: string }> {
    return this.messages.markRead(this.viewer(principal), id);
  }

  @Get(':id/files/:fileId/link')
  @RequireAnyPermission(...MESSAGE_OFFICE_PERMISSIONS)
  @Header('Cache-Control', 'private, no-store')
  fileLink(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Param('fileId') fileId: string): Promise<MessageFileLink> {
    return this.messages.fileLink(this.viewer(principal), id, fileId);
  }
}
