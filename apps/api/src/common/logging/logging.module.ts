import type { IncomingMessage } from 'node:http';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { env } from '../../config/env';
import { resolveRequestId } from '../middleware/request-id';
import { getPrincipal } from '../auth/request-context';

/** A signed file link is a five-minute credential: its token never reaches a log line. */
export function redactSignedUrl(url: unknown): unknown {
  return typeof url === 'string' ? url.replace(/(\/files\/signed\?(?:[^#]*&)?t=)[^&#]*/, '$1[REDACTED]') : url;
}

/** Who the request ran as - user, membership, company - on every request log line (coordinator, 2026-10-25). */
export function principalProps(req: IncomingMessage): Record<string, string> {
  const principal = getPrincipal(req);
  if (!principal || principal.signedIn !== true) return {};
  return {
    userId: principal.userId,
    companyId: principal.companyId,
    ...(principal.membershipId ? { membershipId: principal.membershipId } : {}),
  };
}

/** Structured JSON logging (pino) with per-request correlation ids and header redaction. */
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: env.LOG_LEVEL,
        genReqId: resolveRequestId,
        customProps: (req) => principalProps(req),
        serializers: {
          req: (req: { url?: unknown }) => ({ ...req, url: redactSignedUrl(req.url) }),
        },
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["proxy-authorization"]',
            'res.headers["set-cookie"]',
            // A social security number never reaches a log line, whatever object carries it
            // (request bodies are not logged by pino-http; this guards any future log of one).
            'ssn',
            '*.ssn',
            '*.*.ssn',
            'req.body.ssn',
            'body.ssn',
            'input.ssn',
            // The personal driver application (2026-10-08): its link token, drawn signatures and
            // the multipart body never reach a log line either.
            'req.body',
            'body',
            'applicationToken',
            '*.applicationToken',
            'drawing',
            '*.drawing',
            '*.*.drawing',
            'authorizations',
            '*.authorizations',
            'req.headers["x-neway-signature"]',
          ],
          censor: '[REDACTED]',
        },
        transport:
          env.NODE_ENV === 'development'
            ? {
                target: 'pino-pretty',
                options: { colorize: true, singleLine: true, translateTime: 'SYS:standard' },
              }
            : undefined,
      },
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
