import { Injectable } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { API_PREFIX } from '@neway/shared';
import { policyAdmits, listRoutes, resolveRoutePolicy } from '../../common/auth/route-policy';
import { SIGNED_DOWNLOAD_KEY, SIGNED_REQUEST_TTL_MS, signRequest, withSignature } from '../../common/auth/signed-download';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { env } from '../../config/env';
import { AuditService } from '../people/audit.service';

interface SignableRoute {
  pattern: RegExp;
  path: string;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  handler: Function;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  controller: Function;
}

/**
 * Issues the five-minute signed links for driver and candidate documents (signed-download.ts).
 *
 * Only a GET route marked @SignedDownload can be signed, and only for a caller whose permissions
 * already pass that route's policy; the handler's own owner-record checks run again when the link
 * is opened, as the same user. Every issued link is audited (who, which document path).
 */
@Injectable()
export class SignedDownloadService {
  private routes: SignableRoute[] | null = null;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly audit: AuditService,
  ) {}

  private signable(): SignableRoute[] {
    if (this.routes) return this.routes;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    const controllers = this.discovery.getControllers().map((w) => w.metatype).filter((m): m is Function => typeof m === 'function');
    const out: SignableRoute[] = [];
    for (const route of listRoutes(controllers)) {
      if (route.method !== 'GET') continue;
      const controller = controllers.find((c) => c.name === route.controller)!;
      const handler = (controller.prototype as Record<string, unknown>)[route.handler] as (...a: unknown[]) => unknown;
      if (Reflect.getMetadata(SIGNED_DOWNLOAD_KEY, handler) !== true) continue;
      const source = `/${API_PREFIX}${route.path}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z0-9_]+/g, '[^/?#]+');
      out.push({ pattern: new RegExp(`^${source}$`), path: route.path, handler, controller });
    }
    this.routes = out;
    return out;
  }

  /** The paths that can be signed, for tests and the matrix. */
  signablePaths(): string[] {
    return this.signable().map((r) => r.path);
  }

  async sign(principal: Principal, target: string): Promise<{ url: string; expiresAt: string }> {
    const clean = String(target ?? '');
    const pathOnly = clean.split('?')[0] ?? '';
    if (!clean.startsWith(`/${API_PREFIX}/`) || clean.includes('#') || /[?&]sig=/.test(clean)) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'Give the API path of a document.' });
    }
    const route = this.signable().find((r) => r.pattern.test(pathOnly));
    if (!route) {
      throw new AppError({ status: 404, title: 'Not Found', type: '/problems/not-signable', detail: 'That path is not a document that opens through a signed link.' });
    }
    if (!principal.membershipId) {
      throw new AppError({ status: 403, title: 'Forbidden', detail: 'A signed link needs a signed-in account.' });
    }
    if (!policyAdmits(resolveRoutePolicy(route.handler, route.controller), principal.permissions)) {
      throw new AppError({ status: 403, title: 'Forbidden', detail: 'You may not open this document.' });
    }
    const expires = Date.now() + SIGNED_REQUEST_TTL_MS;
    const token = signRequest(env.APP_SECRET, { p: clean, c: principal.companyId, u: principal.userId, m: principal.membershipId, e: expires });
    await this.audit.write(principal, {
      action: 'link',
      entityType: 'personnel_document',
      entityId: pathOnly.slice(0, 200),
      entityLabel: route.path,
      summary: 'Signed link issued for a personnel document',
    });
    return { url: withSignature(clean, token), expiresAt: new Date(expires).toISOString() };
  }
}
