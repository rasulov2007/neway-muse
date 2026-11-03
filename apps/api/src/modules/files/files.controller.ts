import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import type { Principal } from '../../common/auth/principal';
import { Public } from '../../common/auth/public.decorator';
import { getPrincipal } from '../../common/auth/request-context';
import { RequireAnyPermission, RequirePermission } from '../../common/auth/require-permission.decorator';
import { SignedInOnly } from '../../common/auth/signed-in-only.decorator';
import { AppError } from '../../common/errors/app-error';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { FILES_MANAGE } from './file-access';
import { FilesService, parseDataUrl, type DeletedFileInfo, type StoredFileInfo } from './files.service';
import { SignedDownloadService } from './signed-download.service';

/** Uploads are small enough to ride as base64 JSON, like compliance documents do. */
interface UploadBody {
  fileName?: string;
  contentType?: string;
  /** Base64 of the bytes, or a whole `data:` URL. */
  content?: string;
}

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Who may put bytes into company storage: any role with an Attach control (owner brief,
 * 2026-10-25, audit row 19). The record the file is then attached to decides who may open it.
 */
export const FILE_UPLOAD_PERMISSIONS = [
  'documents.create',
  'loads.create', 'loads.edit', 'dispatch.edit',
  'maintenance.edit', 'trucks.create', 'trucks.edit', 'trailers.edit', 'truck_assignment.edit',
  'drivers.edit', 'accounting.edit', 'company_profile.edit',
  'safety.manage', 'compliance.manage',
  'accidents.edit', 'accidents.fleet', 'accidents.edit_units', 'accidents.edit_cargo', 'accidents.claim_money', 'accidents.bills',
  'recruiting.manage', 'employees.edit', 'driver_relations.contact', 'ai_assistant.use',
  // Admin → Document templates: the source PDF of a new template version (2026-10-27).
  'application_templates.manage',
] as const;

const reasonPipe = new ZodValidationPipe(z.object({ reason: z.string().trim().min(3, 'Say why the file is removed').max(500) }));

const OPEN = 'the file opens only through the records that point at it (files/file-access.ts owner check)';

@Controller('files')
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly signedDownloads: SignedDownloadService,
  ) {}

  /**
   * A five-minute signed link for a driver or candidate document route (`?path=/api/v1/…`): consent
   * forms, signatures, applications, CDL / medical / testing / W-9 files. Those routes refuse a
   * session and answer only the link, which runs as the same user (signed-download.ts).
   */
  @Get('sign')
  @SignedInOnly('signs only @SignedDownload routes whose policy the caller already passes; the handler re-checks on open')
  sign(@CurrentPrincipal() principal: Principal, @Query('path') path?: string): Promise<{ url: string; expiresAt: string }> {
    return this.signedDownloads.sign(principal, String(path ?? ''));
  }

  /**
   * Stores one file and answers at once. Nothing is derived from the bytes here: a later step
   * that wants text out of a PDF runs on its own, never inside the upload.
   */
  @Post()
  @RequireAnyPermission(...FILE_UPLOAD_PERMISSIONS)
  async upload(
    @CurrentPrincipal() principal: Principal,
    @Body() body: UploadBody,
  ): Promise<StoredFileInfo> {
    const raw = String(body?.content ?? '');
    const parsed = raw.startsWith('data:')
      ? parseDataUrl(raw)
      : raw
        ? { contentType: String(body.contentType ?? ''), bytes: Buffer.from(raw, 'base64') }
        : null;
    if (!parsed || parsed.bytes.byteLength === 0) {
      throw new AppError({ status: 422, title: 'Unprocessable', detail: 'The file is empty.' });
    }
    if (parsed.bytes.byteLength > MAX_BYTES) {
      throw new AppError({ status: 413, title: 'Too Large', detail: 'Files are limited to 25 MB.' });
    }
    const contentType = parsed.contentType || 'application/octet-stream';
    return this.files.store(principal.companyId, {
      fileName: String(body.fileName ?? 'file'),
      contentType,
      bytes: parsed.bytes,
      uploadedBy: principal.userName ?? principal.userId,
    });
  }

  /**
   * The same store, the bytes sent as they are (application/octet-stream) - a third smaller than
   * base64 on the wire. Name and type ride in headers (the name URI-encoded).
   */
  @Post('raw')
  @RequireAnyPermission(...FILE_UPLOAD_PERMISSIONS)
  async uploadRaw(
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Headers('x-file-name') fileName?: string,
    @Headers('x-file-type') fileType?: string,
  ): Promise<StoredFileInfo> {
    const bytes = Buffer.isBuffer(request.body) ? request.body : null;
    if (!bytes || bytes.byteLength === 0) {
      throw new AppError({ status: 422, title: 'Unprocessable', detail: 'The file is empty.' });
    }
    if (bytes.byteLength > MAX_BYTES) {
      throw new AppError({ status: 413, title: 'Too Large', detail: 'Files are limited to 25 MB.' });
    }
    let name = 'file';
    try {
      name = decodeURIComponent(fileName ?? '') || 'file';
    } catch {
      name = fileName || 'file';
    }
    return this.files.store(principal.companyId, {
      fileName: name.slice(0, 255),
      contentType: (fileType || 'application/octet-stream').slice(0, 120),
      bytes,
      uploadedBy: principal.userName ?? principal.userId,
    });
  }

  /** The administrator's restore view: this company's removed files. */
  @Get('deleted')
  @RequirePermission(FILES_MANAGE)
  listDeleted(@CurrentPrincipal() principal: Principal): Promise<DeletedFileInfo[]> {
    return this.files.listDeleted(principal);
  }

  /**
   * The bytes, through a link from `GET /files/:id/link`. Public because the link is the
   * credential: HMAC-signed, five minutes, bound to the company, the file and the user it was
   * issued to (who must still be an active member). A request that also carries a session must be
   * that same user in that same company.
   */
  @Public()
  @Get('signed')
  async readSigned(@Query('t') token: string | undefined, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    // In the query, not the path: the token is longer than a route parameter may be.
    const { info, bytes } = await this.files.readSigned(String(token ?? ''), getPrincipal(request));
    const name = info.fileName.replace(/[^\w.-]+/g, '_');
    await reply
      .header('content-type', info.contentType)
      .header('content-disposition', `inline; filename="${name}"`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(bytes);
  }

  /** A five-minute signed link to the bytes, after the owner check. `?deleted=1`: an administrator opening a removed file. */
  @Get(':id/link')
  @SignedInOnly(OPEN)
  link(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Query('deleted') deleted?: string,
  ): Promise<{ url: string; expiresAt: string }> {
    return this.files.signedLink(principal, id, { includeDeleted: deleted === '1' || deleted === 'true' });
  }

  /**
   * The old address of the bytes, kept for links already saved on records. It runs the same owner
   * check and answers with a redirect to a fresh signed link; it never serves bytes itself.
   */
  @Get(':id')
  @SignedInOnly(OPEN)
  async read(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { url } = await this.files.signedLink(principal, id);
    await reply.header('cache-control', 'no-store').redirect(url, 302);
  }

  /**
   * Soft delete (administrators). The hard delete that used to live at `DELETE /files/:id` is gone:
   * nothing in the product called it, and it removed bytes from disk. Files that belong to a
   * business record are refused (409); see FilesService.softDelete.
   */
  @Post(':id/delete')
  @RequirePermission(FILES_MANAGE)
  softDelete(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(reasonPipe) body: { reason: string },
  ): Promise<DeletedFileInfo> {
    return this.files.softDelete(principal, id, body.reason);
  }

  @Post(':id/restore')
  @RequirePermission(FILES_MANAGE)
  restore(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(z.object({ reason: z.string().trim().max(500).nullish() }))) body: { reason?: string | null },
  ): Promise<StoredFileInfo> {
    return this.files.restore(principal, id, body.reason ?? null);
  }
}
