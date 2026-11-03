import { Body, Controller, Get, HttpCode, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DotAppSignSchema, DotAppSubmitSchema, DotAppVerifyCodeSchema, SaveDotAppSchema, type DotAppSignInput, type SaveDotAppInput } from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { Public } from '../../common/auth/public.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { DotApplicationService, type PublicMeta } from './dot-application.service';

function headers(reply: FastifyReply): void {
  // A person's application: never cached, never sent on as a referrer, never indexed.
  reply.header('Cache-Control', 'no-store');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Robots-Tag', 'noindex');
  reply.header('X-Content-Type-Options', 'nosniff');
}

function meta(request: FastifyRequest): PublicMeta {
  const s = request.headers['x-dot-app-session'];
  const ua = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof ua === 'string' ? ua : null, session: typeof s === 'string' ? s : null };
}

/**
 * The driver's application (owner brief 2026-10-27), reached only with the link's token. The
 * company is the token's row's company — never a parameter. After the 6-digit code every route
 * also needs the session (x-dot-app-session). Unknown / expired / revoked → one identical 404.
 */
@Controller('public/driver-application-v2')
@Public()
@UseGuards(CompanyScopeGuard)
export class PublicDotApplicationController {
  constructor(private readonly apps: DotApplicationService) {}

  @Get(':token')
  gate(@Param('token') token: string, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    headers(reply);
    return this.apps.gate(token, meta(request));
  }

  @Post(':token/code')
  @HttpCode(200)
  code(@Param('token') token: string, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    headers(reply);
    return this.apps.sendCode(token, meta(request));
  }

  @Post(':token/verify')
  @HttpCode(200)
  verify(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(DotAppVerifyCodeSchema)) body: { code: string },
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    headers(reply);
    return this.apps.verify(token, body.code, meta(request));
  }

  @Get(':token/application')
  state(@Param('token') token: string, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    headers(reply);
    return this.apps.driverState(token, meta(request));
  }

  @Put(':token/application')
  save(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(SaveDotAppSchema)) body: SaveDotAppInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    headers(reply);
    return this.apps.save(token, body, meta(request));
  }

  /** The file as raw bytes (application/octet-stream); its name in x-file-name (URI-encoded). */
  @Post(':token/uploads/:slot')
  @HttpCode(201)
  upload(@Param('token') token: string, @Param('slot') slot: string, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    headers(reply);
    const name = request.headers['x-file-name'];
    let fileName = '';
    try {
      fileName = typeof name === 'string' ? decodeURIComponent(name) : '';
    } catch {
      fileName = '';
    }
    return this.apps.upload(token, slot, request.body as Buffer, fileName, meta(request));
  }

  @Get(':token/uploads/:fileId')
  async file(@Param('token') token: string, @Param('fileId') fileId: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const f = await this.apps.driverFile(token, fileId, meta(request));
    headers(reply);
    await reply.header('content-type', f.contentType).header('content-disposition', 'inline').send(f.bytes);
  }

  /** Remove (POST: the reviewed public list allows no DELETE). The row is kept with removed_at. */
  @Post(':token/uploads/:fileId/remove')
  @HttpCode(200)
  remove(@Param('token') token: string, @Param('fileId') fileId: string, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    headers(reply);
    return this.apps.removeUpload(token, fileId, meta(request));
  }

  @Post(':token/signatures')
  @HttpCode(201)
  sign(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(DotAppSignSchema)) body: DotAppSignInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    headers(reply);
    return this.apps.sign(token, body, meta(request));
  }

  /** The driver's own current signature image (session required), shown again after a reload. */
  @Get(':token/signatures/:key/image')
  async signatureImage(@Param('token') token: string, @Param('key') key: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const f = await this.apps.driverSignatureImage(token, key, meta(request));
    headers(reply);
    await reply.header('content-type', f.contentType).header('content-disposition', 'inline').send(f.bytes);
  }

  @Post(':token/submit')
  @HttpCode(200)
  submit(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(DotAppSubmitSchema)) body: { version: number },
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    headers(reply);
    return this.apps.submit(token, body.version, meta(request));
  }
}
