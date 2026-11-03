import { Body, Controller, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { Public } from '../../common/auth/public.decorator';
import { isAppError } from '../../common/errors/app-error';
import { DriverApplicationService, type PublicRequestMeta, type PublicResult } from './driver-application.service';

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * The personal driver application's intake (owner brief, 2026-10-08).
 *
 * `POST /public/driver-application` is what the approved page's same-origin `/api/applications`
 * reaches (nginx maps the one to the other). `POST /public/driver-application/forwarded` is the
 * server-to-server door for a separately hosted copy of the page, signed with the shared secret.
 *
 * Every answer is JSON the page understands: `{ tmsSaved: true, reference }` after commit, or
 * `{ error }` with a safe message — never a stack, a token, an SSN or a storage address.
 */
@Controller('public/driver-application')
@Public()
@UseGuards(CompanyScopeGuard)
export class PublicDriverApplicationController {
  private readonly logger = new Logger(PublicDriverApplicationController.name);

  constructor(private readonly applications: DriverApplicationService) {}

  private meta(request: FastifyRequest, via: PublicRequestMeta['via']): PublicRequestMeta {
    return { ip: request.ip, secure: request.protocol === 'https', origin: header(request, 'origin'), via, device: header(request, 'x-neway-device') };
  }

  private async answer(reply: FastifyReply, work: () => Promise<PublicResult>): Promise<void> {
    void reply
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header('x-robots-tag', 'noindex')
      .header('x-content-type-options', 'nosniff');
    try {
      const result = await work();
      await reply.status(result.status).type('application/json; charset=utf-8').send(result.body);
    } catch (error) {
      if (isAppError(error) && error.status < 500) {
        const retryAfter = (error.extensions as { retryAfter?: number } | undefined)?.retryAfter;
        if (error.status === 429 && typeof retryAfter === 'number') void reply.header('retry-after', String(retryAfter));
        await reply.status(error.status).type('application/json; charset=utf-8').send({ error: error.detail ?? 'Unable to send. Please try again.' });
        return;
      }
      if (!isAppError(error)) this.logger.error(`driver application: unexpected ${(error as Error)?.name ?? 'error'}`);
      const status = isAppError(error) ? error.status : 500;
      await reply
        .status(status)
        .type('application/json; charset=utf-8')
        .send({ error: isAppError(error) && error.detail ? error.detail : 'We could not save your application. Nothing was submitted; please try again in a moment.' });
    }
  }

  @Post()
  async submit(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.answer(reply, () =>
      this.applications.submitPublic(request.body, header(request, 'content-type') ?? undefined, this.meta(request, 'same_origin')),
    );
  }

  /**
   * What the page shows before the driver types (journey v2): whether name, phone, email and the
   * CDL front come from the signed consent. The token rides in the body, never the URL.
   */
  @Post('context')
  async context(@Req() request: FastifyRequest, @Res() reply: FastifyReply, @Body() body: unknown): Promise<void> {
    const token = typeof (body as { token?: unknown })?.token === 'string' ? (body as { token: string }).token : '';
    await this.answer(reply, async () => ({
      status: 200,
      body: (await this.applications.context(token, this.meta(request, 'same_origin'))) as unknown as PublicResult['body'],
    }));
  }

  @Post('forwarded')
  async forwarded(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.answer(reply, () =>
      this.applications.submitForwarded(
        request.body,
        header(request, 'content-type') ?? undefined,
        {
          timestamp: header(request, 'x-neway-timestamp'),
          signature: header(request, 'x-neway-signature'),
          clientIp: header(request, 'x-neway-client-ip'),
        },
        this.meta(request, 'forwarder'),
      ),
    );
  }
}
