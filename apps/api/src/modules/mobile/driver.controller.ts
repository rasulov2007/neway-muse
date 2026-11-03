import { Body, Controller, Get, Header, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  DRIVER_LOAD_SCOPES,
  DriverAckSchema,
  DriverPtiSubmitSchema,
  DriverStopEventSchema,
  type DriverDocumentUploadResponse,
  type DriverFileLink,
  type DriverFileUploadResponse,
  type DriverLoadDetail,
  type DriverLoadScope,
  type DriverLoadsResponse,
  type DriverMe,
  type DriverPtiCurrent,
  type DriverPtiSubmitInput,
  type DriverStopEventRequest,
} from '@neway/shared';
import { z } from 'zod';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { AppError } from '../../common/errors/app-error';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { DriverLoadsService } from './driver-loads.service';
import { DriverPtiService } from './driver-pti.service';
import { IdempotencyService } from './idempotency.service';

const ack = new ZodValidationPipe(DriverAckSchema);
const stopEvent = new ZodValidationPipe(DriverStopEventSchema);
const ptiSubmit = new ZodValidationPipe(DriverPtiSubmitSchema);

/**
 * The driver app (docs/mobile/API.md). Every route needs `driver_app.use`, and the driver is
 * resolved on the server from the session's membership (DriverContextService) - a driver id or
 * company id from the phone is never read. Every POST carries an Idempotency-Key.
 */
@Controller('driver')
export class DriverController {
  constructor(
    private readonly loads: DriverLoadsService,
    private readonly pti: DriverPtiService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('me')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  me(@CurrentPrincipal() principal: Principal): Promise<DriverMe> {
    return this.loads.me(principal);
  }

  @Get('loads')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  list(@CurrentPrincipal() principal: Principal, @Query('scope') scope?: string): Promise<DriverLoadsResponse> {
    const s = (scope ?? 'active') as DriverLoadScope;
    if (!(DRIVER_LOAD_SCOPES as readonly string[]).includes(s)) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: `scope must be one of ${DRIVER_LOAD_SCOPES.join(', ')}` });
    }
    return this.loads.list(principal, s);
  }

  @Get('loads/:id')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  detail(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<DriverLoadDetail> {
    return this.loads.detail(principal, id);
  }

  @Post('loads/:id/ack')
  @HttpCode(200)
  @RequirePermission('driver_app.use')
  acknowledge(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(ack) body: z.infer<typeof DriverAckSchema>,
    @Headers('idempotency-key') key?: string,
  ): Promise<DriverLoadDetail> {
    return this.idempotency.run(principal, key, `POST /driver/loads/${id}/ack`, () => this.loads.acknowledge(principal, id, body?.expectedUpdatedAt));
  }

  @Post('loads/:id/stop-event')
  @HttpCode(200)
  @RequirePermission('driver_app.use')
  stopEvent(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(stopEvent) body: DriverStopEventRequest,
    @Headers('idempotency-key') key?: string,
  ): Promise<DriverLoadDetail> {
    return this.idempotency.run(principal, key, `POST /driver/loads/${id}/stop-event`, () => this.loads.stopEvent(principal, id, body));
  }

  /** The file itself as application/octet-stream; type, stop and name in headers (DRIVER_UPLOAD_HEADERS). */
  @Post('loads/:id/documents')
  @HttpCode(201)
  @RequirePermission('driver_app.use')
  uploadDocument(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Headers('idempotency-key') key?: string,
    @Headers('x-file-name') fileName?: string,
    @Headers('x-doc-type') docType?: string,
    @Headers('x-stop-id') stopId?: string,
    @Headers('x-page-count') pageCount?: string,
    @Headers('x-replaces-id') replacesId?: string,
  ): Promise<DriverDocumentUploadResponse> {
    const bytes = Buffer.isBuffer(request.body) ? request.body : null;
    return this.idempotency.run(principal, key, `POST /driver/loads/${id}/documents`, () =>
      this.loads.uploadDocument(principal, id, bytes, { fileName, docType, stopId, pageCount, replacesId, idempotencyKey: key }),
    );
  }

  /** A photo for a PTI item (octet-stream); attached by the write that names its id. */
  @Post('files')
  @HttpCode(201)
  @RequirePermission('driver_app.use')
  uploadFile(
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Headers('idempotency-key') key?: string,
    @Headers('x-file-name') fileName?: string,
  ): Promise<DriverFileUploadResponse> {
    const bytes = Buffer.isBuffer(request.body) ? request.body : null;
    return this.idempotency.run(principal, key, 'POST /driver/files', () => this.loads.uploadFile(principal, bytes, fileName));
  }

  @Get('files/:id/link')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  fileLink(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<DriverFileLink> {
    return this.loads.fileLink(principal, id);
  }

  @Get('pti/current')
  @RequirePermission('driver_app.use')
  @Header('Cache-Control', 'private, no-store')
  ptiCurrent(@CurrentPrincipal() principal: Principal): Promise<DriverPtiCurrent> {
    return this.pti.current(principal);
  }

  @Post('pti')
  @HttpCode(200)
  @RequirePermission('driver_app.use')
  ptiSubmit(
    @CurrentPrincipal() principal: Principal,
    @Body(ptiSubmit) body: DriverPtiSubmitInput,
    @Headers('idempotency-key') key?: string,
  ): Promise<DriverPtiCurrent> {
    return this.idempotency.run(principal, key, 'POST /driver/pti', () => this.pti.submit(principal, body));
  }
}
