import { Controller, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../common/auth/public.decorator';
import { EmailService } from './email.service';

/**
 * Resend's delivery events (delivered / bounced / complained / failed). Public because Resend calls
 * it, but believed only with a valid signature over the raw body (RESEND_WEBHOOK_SECRET). The raw
 * body comes from Nest's rawBody option (app.factory). Answers carry no body.
 */
@Controller('public/email/resend')
@Public()
export class ResendWebhookController {
  constructor(private readonly email: EmailService) {}

  @Post('webhook')
  async webhook(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const raw = (request as FastifyRequest & { rawBody?: Buffer | string }).rawBody?.toString() ?? '';
    const result = await this.email.webhook(raw, request.headers);
    await reply.status(result.status).header('cache-control', 'no-store').send();
  }
}
