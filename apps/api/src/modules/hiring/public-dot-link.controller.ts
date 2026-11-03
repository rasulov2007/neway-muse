import { Body, Controller, Get, HttpCode, Options, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { Public } from '../../common/auth/public.decorator';
import { DotLinksService, type DotLinkRequestMeta } from './dot-links.service';

function headers(reply: FastifyReply): void {
  reply.header('Access-Control-Allow-Origin', '*');
  // The answers carry a person's application: never cached, never sent on as a referrer.
  reply.header('Cache-Control', 'no-store');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Robots-Tag', 'noindex');
}

function metaOf(request: FastifyRequest): DotLinkRequestMeta {
  // Fastify reads X-Forwarded-Proto only from proxies trusted by TRUST_PROXY_*; anything else is
  // the socket's own scheme, so a client cannot claim HTTPS by sending the header itself.
  return { ip: request.ip, secure: request.protocol === 'https' };
}

/**
 * The DOT application the driver fills in from the link a recruiter sent (/dot/<token>).
 *
 * The token is the only key: it names one hiring case in one company, and nothing else is reachable
 * from here. An unknown, expired or turned-off token gets the same 404. `CompanyScopeGuard`
 * refuses a company in the query string; there is no company to send.
 */
@Controller('public/dot-application')
@Public()
@UseGuards(CompanyScopeGuard)
export class PublicDotLinkController {
  constructor(private readonly links: DotLinksService) {}

  @Options([':token', ':token/submit', ':token/documents'])
  @HttpCode(204)
  preflight(@Res({ passthrough: true }) reply: FastifyReply): void {
    headers(reply);
    reply.header('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'content-type, accept');
    reply.header('Access-Control-Max-Age', '86400');
  }

  @Get(':token')
  read(@Param('token') token: string, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    headers(reply);
    return this.links.publicGet(token, metaOf(request));
  }

  @Put(':token')
  save(
    @Param('token') token: string,
    // Validated inside the service, after the per-address limit has counted it.
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    headers(reply);
    return this.links.publicSave(token, body, metaOf(request));
  }

  @Post(':token/submit')
  @HttpCode(200)
  submit(@Param('token') token: string, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    headers(reply);
    return this.links.publicSubmit(token, metaOf(request));
  }

  @Post(':token/documents')
  @HttpCode(201)
  upload(
    @Param('token') token: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    headers(reply);
    return this.links.publicUpload(token, body, metaOf(request));
  }
}
