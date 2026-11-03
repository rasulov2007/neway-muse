import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { REQUEST_ID_HEADER } from '@neway/shared';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Returns the request id: the incoming `x-request-id` header when it is safe to
 * echo back, otherwise a freshly generated UUID. Used as Fastify's `genReqId`
 * and by pino-http so both agree on the same id.
 */
export function resolveRequestId(req: IncomingMessage): string {
  const header = req.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && SAFE_REQUEST_ID.test(value) ? value : randomUUID();
}

/**
 * Registers an `onRequest` hook that echoes the request id on the response and
 * normalises the incoming header so downstream consumers (pino-http, filters)
 * see the exact id Fastify assigned.
 */
export function registerRequestIdHook(instance: FastifyInstance): void {
  instance.addHook('onRequest', (request, reply, done) => {
    request.raw.headers[REQUEST_ID_HEADER] = request.id;
    void reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });
}
