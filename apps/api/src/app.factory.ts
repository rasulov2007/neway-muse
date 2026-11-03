import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { API_PREFIX, DRIVER_APPLICATION_MAX_REQUEST_BYTES } from '@neway/shared';
import type { FastifyInstance } from 'fastify';
import { AppModule } from './app.module';
import { env } from './config/env';
import { HttpExceptionFilter } from './common/errors/http-exception.filter';
import { registerRequestIdHook, resolveRequestId } from './common/middleware/request-id';

/**
 * Builds the fully configured (but not yet listening) application. Shared by
 * main.ts and the e2e tests so both exercise the same wiring.
 */
export async function createApp(): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    genReqId: resolveRequestId,
    requestIdHeader: false,
    // A number of hops, never `true`: trusting every X-Forwarded-For entry would let any client
    // choose the address it is rate-limited by. See TRUST_PROXY_HOPS in config/env.ts.
    trustProxy: env.TRUST_PROXY_ADDRESSES
      ? env.TRUST_PROXY_ADDRESSES.split(',').map((a) => a.trim()).filter(Boolean)
      : env.TRUST_PROXY_HOPS > 0
        ? env.TRUST_PROXY_HOPS
        : false,
    // The state store carries the client dataset (documents included) as one
    // JSON blob; the 1 MB Fastify default would reject it.
    bodyLimit: 30 * 1024 * 1024,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
    // JSON bodies keep their raw bytes too (request.rawBody): the Resend webhook's signature is
    // over the exact bytes, and a re-serialised object would not match.
    rawBody: true,
  });

  const logger = app.get(Logger);
  app.useLogger(logger);
  app.flushLogs();
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new HttpExceptionFilter(logger));
  app.enableShutdownHooks();

  registerRequestIdHook(app.getHttpAdapter().getInstance());
  registerDriverApplicationParser(app.getHttpAdapter().getInstance());
  registerRawFileParser(app.getHttpAdapter().getInstance());

  return app;
}

/**
 * Raw file bytes (application/octet-stream) on `POST /files/raw` only (owner, 2026-10-15): a 4 MB
 * BOL sent as base64 JSON travelled as 6 MB and took 40 s on a slow uplink. Every other route
 * answers 415 for octet-stream, as before.
 */
function registerRawFileParser(instance: FastifyInstance): void {
  const route = `/${API_PREFIX}/files/raw`;
  // The driver application's uploads (owner brief 2026-10-27): a phone sends the file as it is, with
  // progress, to /public/driver-application-v2/<token>/uploads/<slot>.
  const dotUpload = new RegExp(`^/${API_PREFIX}/public/driver-application-v2/[^/]+/uploads/[a-z_]+$`);
  // The driver app (0081): a BOL / POD / lumper scan onto the driver's own load, and PTI photos.
  const driverUpload = new RegExp(`^/${API_PREFIX}/driver/(loads/[^/]+/documents|files|assistant/transcribe|assistant/voice)$`);
  instance.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 26 * 1024 * 1024 }, (request, body, done) => {
    const path = request.url.split('?')[0] ?? '';
    if (path !== route && !dotUpload.test(path) && !driverUpload.test(path)) {
      done(Object.assign(new Error('Unsupported Media Type'), { statusCode: 415 }), undefined);
      return;
    }
    done(null, body);
  });
}

/**
 * multipart/form-data is accepted on two routes only: the personal driver application, whose page
 * posts the form (three documents, two signature images) as the browser builds it. The body is
 * read whole up to DRIVER_APPLICATION_MAX_REQUEST_BYTES and parsed by the route itself
 * (common/http/multipart.ts); every other route answers 415 for multipart, as before.
 */
function registerDriverApplicationParser(instance: FastifyInstance): void {
  const route = `/${API_PREFIX}/public/driver-application`;
  instance.addContentTypeParser(
    'multipart/form-data',
    { parseAs: 'buffer', bodyLimit: DRIVER_APPLICATION_MAX_REQUEST_BYTES },
    (request, body, done) => {
      const path = request.url.split('?')[0] ?? '';
      // The candidate consent page (owner brief, 2026-10-11) posts its form the same way.
      if (path !== route && path !== `${route}/forwarded` && path !== `/${API_PREFIX}/public/consent/submit`) {
        done(Object.assign(new Error('Unsupported Media Type'), { statusCode: 415 }), undefined);
        return;
      }
      done(null, body);
    },
  );
}

