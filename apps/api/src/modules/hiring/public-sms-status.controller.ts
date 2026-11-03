import { Controller, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { Public } from '../../common/auth/public.decorator';
import { LinkDeliveryService } from './link-delivery.service';
import { SmsPreferencesService } from './sms-preferences.service';

/**
 * Twilio's delivery receipts for the recruiting links (owner brief, 2026-10-11). Public because
 * Twilio calls it, but believed only with Twilio's signature from the sending account (see
 * LinkDeliveryService.callback). The body is form-encoded (the Fastify adapter parses it).
 * Answers carry no body.
 */
@Controller('public/sms/twilio')
@Public()
@UseGuards(CompanyScopeGuard)
export class PublicSmsStatusController {
  constructor(
    private readonly deliveries: LinkDeliveryService,
    private readonly sms: SmsPreferencesService,
  ) {}

  private params(request: FastifyRequest): Record<string, string> {
    const params: Record<string, string> = {};
    const raw = request.body;
    if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') params[k] = v;
    return params;
  }

  @Post('status/:deliveryId')
  async status(@Param('deliveryId') deliveryId: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const params = this.params(request);
    const signature = request.headers['x-twilio-signature'];
    const result = await this.deliveries.callback(deliveryId, params, Array.isArray(signature) ? signature[0] : signature);
    await reply.status(result.status).header('cache-control', 'no-store').send();
  }

  /**
   * Replies to the company's number (set as the number's messaging webhook in Twilio): STOP opts the
   * person out of texts, START back in. Answered with an empty TwiML response; Twilio sends its own
   * STOP/START confirmations.
   */
  @Post('inbound/:accountId')
  async inbound(@Param('accountId') accountId: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const signature = request.headers['x-twilio-signature'];
    const result = await this.sms.inbound(accountId, this.params(request), Array.isArray(signature) ? signature[0] : signature);
    if (result.status !== 200) {
      await reply.status(result.status).send();
      return;
    }
    await reply.status(200).header('content-type', 'text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
}
