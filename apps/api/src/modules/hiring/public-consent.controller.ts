import { Body, Controller, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { Public } from '../../common/auth/public.decorator';
import { getPrincipal } from '../../common/auth/request-context';
import { isAppError } from '../../common/errors/app-error';
import { ConsentService, type ConsentRequestMeta } from './consent.service';

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * The driver's consent page (owner brief, 2026-10-11). Two doors and nothing else: read the form
 * for a token, and submit it. The token travels in the body (never the URL, so it is never in a
 * log). Answers are `{ ... }` or `{ error }` with a safe sentence — never a stack, a token or a
 * storage address — and a failed save never says "saved".
 */
@Controller('public/consent')
@Public()
@UseGuards(CompanyScopeGuard)
export class PublicConsentController {
  private readonly logger = new Logger(PublicConsentController.name);

  constructor(private readonly consents: ConsentService) {}

  private meta(request: FastifyRequest): ConsentRequestMeta {
    const staff = getPrincipal(request);
    return {
      ip: request.ip,
      secure: request.protocol === 'https',
      userAgent: header(request, 'user-agent'),
      device: header(request, 'x-neway-device'),
      staffCompanyId: staff?.signedIn === true ? staff.companyId : null,
    };
  }

  private async answer(reply: FastifyReply, work: () => Promise<{ status: number; body: unknown }>): Promise<void> {
    void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').header('x-robots-tag', 'noindex').header('x-content-type-options', 'nosniff');
    try {
      const result = await work();
      await reply.status(result.status).type('application/json; charset=utf-8').send(result.body);
    } catch (error) {
      if (isAppError(error) && error.status < 500) {
        const retryAfter = (error.extensions as { retryAfter?: number } | undefined)?.retryAfter;
        if (error.status === 429 && typeof retryAfter === 'number') void reply.header('retry-after', String(retryAfter));
        await reply.status(error.status).type('application/json; charset=utf-8').send({ error: error.detail ?? 'Something went wrong. Please try again.' });
        return;
      }
      if (!isAppError(error)) this.logger.error(`consent: unexpected ${(error as Error)?.name ?? 'error'}`);
      await reply
        .status(isAppError(error) ? error.status : 500)
        .type('application/json; charset=utf-8')
        .send({ error: isAppError(error) && error.detail ? error.detail : 'We could not save your consent. Nothing was submitted; please try again in a moment.' });
    }
  }

  @Post('form')
  async form(@Req() request: FastifyRequest, @Res() reply: FastifyReply, @Body() body: unknown): Promise<void> {
    const token = typeof (body as { token?: unknown })?.token === 'string' ? (body as { token: string }).token : '';
    await this.answer(reply, async () => ({ status: 200, body: await this.consents.context(token, this.meta(request)) }));
  }

  @Post('submit')
  async submit(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.answer(reply, () => this.consents.submit(request.body, header(request, 'content-type') ?? undefined, this.meta(request)));
  }
}
