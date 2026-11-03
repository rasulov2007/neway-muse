import {
  Body,
  Controller,
  Get,
  HttpCode,
  Options,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { Public } from '../../common/auth/public.decorator';
import { ApplyService, type RequestMeta } from './apply.service';

function allowAnyOrigin(reply: FastifyReply): void {
  reply.header('Access-Control-Allow-Origin', '*');
}

function metaOf(request: FastifyRequest): RequestMeta {
  const agent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof agent === 'string' ? agent : null };
}

/**
 * The public driver application: the only hiring routes reachable without a session.
 *
 * Each is justifiable on its own: drawing the form needs the company's name and its consent
 * wording, and submitting it is the point. Neither route returns anything about any candidate —
 * the submission answers `{ status: 'received' }` whether the driver is new, already a lead, or a
 * bot caught by the honeypot. The company comes from the link's slug on the server; there is no
 * company field to send, and `CompanyScopeGuard` refuses one in the query string.
 */
@Controller('public/apply')
@Public()
@UseGuards(CompanyScopeGuard)
export class PublicApplyController {
  constructor(private readonly apply: ApplyService) {}

  /**
   * A copy of the page hosted on another site (owner, 2026-10-05) reads and submits from there.
   * Any origin may, but never with credentials: these two routes take no session and return
   * nothing about any candidate, and every other API route stays same-origin. The headers go on
   * the reply first so an error answer (a 422 on a field, a 429) reaches the page too.
   */
  @Options(':slug')
  @HttpCode(204)
  preflight(@Res({ passthrough: true }) reply: FastifyReply): void {
    allowAnyOrigin(reply);
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'content-type, accept');
    reply.header('Access-Control-Max-Age', '86400');
  }

  @Get(':slug')
  config(
    @Param('slug') slug: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    allowAnyOrigin(reply);
    return this.apply.publicConfig(slug.toLowerCase(), metaOf(request));
  }

  @Post(':slug')
  @HttpCode(201)
  submit(
    @Param('slug') slug: string,
    // Validated inside the service, after the per-address limit has counted it.
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    allowAnyOrigin(reply);
    return this.apply.submit(slug.toLowerCase(), body, metaOf(request));
  }
}
