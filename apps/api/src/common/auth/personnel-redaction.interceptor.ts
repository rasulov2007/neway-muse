import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor, UseInterceptors } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { map, type Observable } from 'rxjs';
import { hasPermission } from './principal';
import { getPrincipal } from './request-context';
import { PERSONNEL_DOCUMENT_PERMISSIONS } from './signed-download';

/**
 * Lists that describe a driver's or candidate's documents (owner, 2026-10-25): for a reader without
 * a personnel-record code (Safety, testing, the HR / recruiting manager), every `fileName` becomes
 * "Restricted" and anything read off a document (`extracted`, `ocr`, `fields`) is dropped, at any
 * depth of the answer. The record still says a document exists; it does not say what it is called
 * or what it contains.
 */
const NAME_KEYS = new Set(['fileName', 'originalFileName']);
const CONTENT_KEYS = new Set(['extracted', 'ocr', 'extractedFields']);

export function redactPersonnelFiles(value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactPersonnelFiles(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (NAME_KEYS.has(key) && typeof v === 'string') out[key] = 'Restricted';
    else if (CONTENT_KEYS.has(key)) out[key] = null;
    else out[key] = redactPersonnelFiles(v, depth + 1);
  }
  return out;
}

@Injectable()
export class PersonnelRedactionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const principal = getPrincipal(context.switchToHttp().getRequest<FastifyRequest>());
    const sees = principal !== undefined && PERSONNEL_DOCUMENT_PERMISSIONS.some((code) => hasPermission(principal, code));
    return next.handle().pipe(map((body: unknown) => (sees ? body : redactPersonnelFiles(body))));
  }
}

export const RedactPersonnelFiles = () => UseInterceptors(PersonnelRedactionInterceptor);
