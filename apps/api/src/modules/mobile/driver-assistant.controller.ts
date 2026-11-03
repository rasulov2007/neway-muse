import { Body, Controller, Header, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { DriverAssistantAskSchema, type DriverAssistantAnswer, type DriverAssistantAskInput, type DriverAssistantTranscript, type DriverAssistantVoiceAnswer } from '@neway/shared';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { DriverAssistantService } from './driver-assistant.service';

const ask = new ZodValidationPipe(DriverAssistantAskSchema);

/**
 * Ask NeWay in the driver app (mobile M6). Reads only: nothing here writes a record, so no
 * Idempotency-Key. The driver is the session's (DriverContextService), never one the phone names.
 */
@Controller('driver/assistant')
export class DriverAssistantController {
  constructor(private readonly assistant: DriverAssistantService) {}

  @Post('ask')
  @HttpCode(200)
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  askQuestion(@CurrentPrincipal() principal: Principal, @Body(ask) body: DriverAssistantAskInput): Promise<DriverAssistantAnswer> {
    return this.assistant.ask(principal, body);
  }

  /** A short recording (octet-stream, its type in x-file-type) → its words. */
  @Post('transcribe')
  @HttpCode(200)
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  transcribe(
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Headers('x-file-name') fileName?: string,
    @Headers('x-file-type') fileType?: string,
  ): Promise<DriverAssistantTranscript> {
    const bytes = Buffer.isBuffer(request.body) ? request.body : null;
    return this.assistant.transcribe(principal, bytes, fileName ? decodeURIComponent(fileName) : undefined, fileType);
  }

  /**
   * Ask by voice in one round trip (Meta Muse): a short WAV recording (octet-stream) → the words
   * heard and the answer, in the language the driver spoke. The last few turns may ride in
   * `x-assistant-history` (URI-encoded JSON, the same shape as /ask's `history`).
   */
  @Post('voice')
  @HttpCode(200)
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  voice(
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Headers('x-file-name') fileName?: string,
    @Headers('x-file-type') fileType?: string,
    @Headers('x-assistant-history') history?: string,
  ): Promise<DriverAssistantVoiceAnswer> {
    const bytes = Buffer.isBuffer(request.body) ? request.body : null;
    return this.assistant.voice(principal, bytes, fileName ? decodeURIComponent(fileName) : undefined, fileType, historyFrom(history));
  }
}

/** The optional history header; anything that does not parse is ignored (the question still counts). */
export function historyFrom(header: string | undefined): DriverAssistantAskInput['history'] {
  if (!header) return undefined;
  try {
    const parsed = DriverAssistantAskSchema.shape.history.safeParse(JSON.parse(decodeURIComponent(header)));
    return parsed.success ? parsed.data?.slice(-6) : undefined;
  } catch {
    return undefined;
  }
}
