import { Body, Controller, Get, HttpCode, Options, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { Public } from '../../common/auth/public.decorator';
import { ExternalApplicationService, type ExternalRequestMeta } from './external-application.service';

function metaOf(request: FastifyRequest): ExternalRequestMeta {
  const origin = request.headers.origin;
  const secret = request.headers['x-intake-secret'];
  return {
    ip: request.ip,
    secure: request.protocol === 'https',
    origin: typeof origin === 'string' && origin.length > 0 ? origin : null,
    secret: typeof secret === 'string' ? secret : null,
  };
}

/**
 * The external driver application's intake (owner, 2026-10-08): `/public/external-application/<token>`.
 *
 * The token is the candidate's private link token and the only key; it resolves on the server to
 * one company and one candidate. CORS answers only allowlisted origins, never with credentials.
 * See ExternalApplicationService and docs/hiring/recruiting-redesign.md for the contract.
 */
@Controller('public/external-application')
@Public()
@UseGuards(CompanyScopeGuard)
export class PublicExternalApplicationController {
  constructor(private readonly intake: ExternalApplicationService) {}

  private headers(request: FastifyRequest, reply: FastifyReply): void {
    const origin = this.intake.allowedOrigin(metaOf(request).origin);
    if (origin) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
    }
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Robots-Tag', 'noindex');
  }

  @Options(':token')
  @HttpCode(204)
  preflight(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): void {
    this.headers(request, reply);
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'content-type, accept');
    reply.header('Access-Control-Max-Age', '600');
  }

  @Get(':token')
  prefill(@Param('token') token: string, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    this.headers(request, reply);
    return this.intake.prefill(token, metaOf(request));
  }

  @Post(':token')
  @HttpCode(200)
  submit(
    @Param('token') token: string,
    // Validated inside the service, after the caller and the token are checked.
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.headers(request, reply);
    return this.intake.submit(token, body, metaOf(request));
  }
}
