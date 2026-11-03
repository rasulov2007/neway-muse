import { STATUS_CODES } from 'node:http';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Logger } from 'nestjs-pino';
import { PROBLEM_JSON_CONTENT_TYPE, type ProblemDetails } from '@neway/shared';
import { isAppError } from './app-error';

/** Renders every unhandled error as an RFC 7807 application/problem+json body. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const problem = toProblemDetails(exception, request);

    if (problem.status >= 500) {
      this.logger.error(
        { err: exception, requestId: problem.requestId, status: problem.status },
        `Unhandled error while handling ${request.method} ${request.url}`,
      );
    }

    // A 429 says when to come back, in the header clients and proxies actually read.
    const retryAfter = (problem as { retryAfter?: unknown }).retryAfter;
    if (problem.status === 429 && typeof retryAfter === 'number') {
      void reply.header('retry-after', String(retryAfter));
    }

    // The personal driver application page reads `error` (owner brief, 2026-10-08): a request the
    // route never saw (too large, not multipart) still gets a message the page can show.
    if (request.url.startsWith('/api/v1/public/driver-application')) {
      const error =
        problem.status === 413
          ? 'Your files are too large to send together. Each file must be 8 MB or smaller.'
          : problem.status >= 500
            ? 'We could not save your application. Nothing was submitted; please try again in a moment.'
            : (problem.detail ?? 'Unable to send. Please try again.');
      void reply.status(problem.status).header('cache-control', 'no-store').header('content-type', 'application/json; charset=utf-8').send({ error });
      return;
    }

    void reply
      .status(problem.status)
      .header('content-type', `${PROBLEM_JSON_CONTENT_TYPE}; charset=utf-8`)
      .send(problem);
  }
}

function toProblemDetails(exception: unknown, request: FastifyRequest): ProblemDetails {
  const base = { instance: request.url, requestId: request.id };

  if (isAppError(exception)) {
    return {
      type: exception.type,
      title: exception.title,
      status: exception.status,
      ...(exception.detail !== undefined ? { detail: exception.detail } : {}),
      ...base,
      ...(exception.extensions ?? {}),
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return {
      type: 'about:blank',
      title: STATUS_CODES[status] ?? 'Error',
      status,
      detail: extractDetail(exception.getResponse()),
      ...base,
    };
  }

  // Errors Fastify raises before a route runs (an oversized body, a content type the server does
  // not read) carry their own 4xx status; they are the client's, not a server failure.
  const fastifyStatus = (exception as { statusCode?: unknown } | null)?.statusCode;
  if (typeof fastifyStatus === 'number' && fastifyStatus >= 400 && fastifyStatus < 500) {
    return {
      type: 'about:blank',
      title: STATUS_CODES[fastifyStatus] ?? 'Error',
      status: fastifyStatus,
      detail: fastifyStatus === 413 ? 'The request is too large.' : fastifyStatus === 415 ? 'This content type is not accepted here.' : 'Request failed.',
      ...base,
    };
  }

  return {
    type: 'about:blank',
    title: STATUS_CODES[500] ?? 'Internal Server Error',
    status: 500,
    detail: 'An unexpected error occurred.',
    ...base,
  };
}

function extractDetail(response: string | object): string {
  if (typeof response === 'string') return response;
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) return message.map(String).join('; ');
  if (typeof message === 'string') return message;
  return 'Request failed.';
}
