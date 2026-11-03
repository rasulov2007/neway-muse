import { Body, Controller, Get, Header, Param, Patch, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  AiClientResultsSchema,
  CreateAiConversationSchema,
  SendAiMessageSchema,
  UpdateAiConversationSchema,
  type AiClientResultsInput,
  type CreateAiConversationInput,
  type SendAiMessageInput,
  type UpdateAiConversationInput,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { AiAssistantService } from './ai-assistant.service';
import { AiTtsService } from './ai-tts.service';
import { TTS_MAX_CHARS } from './tts';

const TtsSchema = z.object({
  text: z.string().trim().min(1, 'Required').max(TTS_MAX_CHARS, `Up to ${TTS_MAX_CHARS} characters`),
  lang: z.string().trim().max(10).optional(),
});
type TtsInput = z.infer<typeof TtsSchema>;

/** NeWay AI, Phase 1 (owner, 2026-10-20). Every route is the signed-in person's own. */
@Controller('ai')
@UseGuards(CompanyScopeGuard, PermissionGuard)
@RequirePermission('ai_assistant.use')
export class AiAssistantController {
  constructor(
    private readonly ai: AiAssistantService,
    private readonly tts: AiTtsService,
  ) {}

  /**
   * Read aloud through the company's Azure Speech account: MP3 back. 404 `tts_not_configured`
   * when there is none, so the browser falls back to its own voices.
   */
  @Post('tts')
  async speak(@CurrentPrincipal() principal: Principal, @Body(new ZodValidationPipe(TtsSchema)) body: TtsInput, @Res() reply: FastifyReply): Promise<void> {
    const { audio } = await this.tts.speak(principal, body);
    await reply.status(200).header('content-type', 'audio/mpeg').header('cache-control', 'private, no-store').send(audio);
  }

  @Get('usage')
  @Header('Cache-Control', 'private, no-store')
  usage(@CurrentPrincipal() principal: Principal) {
    return this.ai.usage(principal);
  }

  @Get('conversations')
  @Header('Cache-Control', 'private, no-store')
  conversations(@CurrentPrincipal() principal: Principal) {
    return this.ai.conversations(principal);
  }

  @Post('conversations')
  create(@CurrentPrincipal() principal: Principal, @Body(new ZodValidationPipe(CreateAiConversationSchema)) body: CreateAiConversationInput) {
    return this.ai.create(principal, body);
  }

  @Patch('conversations/:id')
  update(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(UpdateAiConversationSchema)) body: UpdateAiConversationInput) {
    return this.ai.update(principal, id, body);
  }

  @Post('conversations/:id/archive')
  archive(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.ai.archive(principal, id);
  }

  @Get('conversations/:id/messages')
  @Header('Cache-Control', 'private, no-store')
  messages(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.ai.messages(principal, id);
  }

  @Post('conversations/:id/messages')
  send(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(SendAiMessageSchema)) body: SendAiMessageInput) {
    return this.ai.send(principal, id, body);
  }

  /** The browser ran the screen tools of a paused answer; the loop carries on (or stops). */
  @Post('conversations/:id/client-results')
  clientResults(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(AiClientResultsSchema)) body: AiClientResultsInput) {
    return this.ai.clientResults(principal, id, body);
  }

  @Post('proposals/:id/confirm')
  confirm(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.ai.confirm(principal, id);
  }

  @Post('proposals/:id/cancel')
  cancel(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.ai.cancel(principal, id);
  }
}
