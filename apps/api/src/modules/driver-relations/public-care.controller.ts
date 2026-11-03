import { Body, Controller, Get, HttpCode, Options, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { Public } from '../../common/auth/public.decorator';
import { CareIntakeService, type CareRequestMeta } from './care-intake.service';

function allowAnyOrigin(reply: FastifyReply): void {
  reply.header('Access-Control-Allow-Origin', '*');
}

function metaOf(request: FastifyRequest): CareRequestMeta {
  const agent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof agent === 'string' ? agent : null };
}

/**
 * The NORTHWIND FREIGHT Driver Care page: the only Driver Relations routes reachable without a session.
 *
 * Drawing the page needs the company's name; submitting is the point. Neither returns anything
 * about any request but the reference number of the one just sent: there is no read of a request,
 * its history or another driver's records from here, by id or otherwise. The company comes from
 * the link's slug on the server; `CompanyScopeGuard` refuses a company in the query string. Any
 * origin may call these two routes (a hosted copy of the page), never with credentials.
 */
@Controller('public/driver-care')
@Public()
@UseGuards(CompanyScopeGuard)
export class PublicCareController {
  constructor(private readonly intake: CareIntakeService) {}

  @Options(':slug')
  @HttpCode(204)
  preflight(@Res({ passthrough: true }) reply: FastifyReply): void {
    allowAnyOrigin(reply);
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'content-type, accept');
    reply.header('Access-Control-Max-Age', '86400');
  }

  @Get(':slug')
  config(@Param('slug') slug: string, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    allowAnyOrigin(reply);
    return this.intake.publicConfig(slug.toLowerCase(), metaOf(request));
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
    return this.intake.submit(slug.toLowerCase(), body, metaOf(request));
  }
}
