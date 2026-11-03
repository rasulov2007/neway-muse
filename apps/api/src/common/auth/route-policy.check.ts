import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { listRoutes, routesWithoutPolicy } from './route-policy';

/**
 * The boot-time half of deny by default: the API does not start while any controller route lacks
 * a declared policy, or declares `@SignedInOnly` without saying why. The CI half is
 * `test/authz/route-policy.spec.ts`, which reaches the same verdict without a database.
 */
@Injectable()
export class RoutePolicyCheck implements OnApplicationBootstrap {
  constructor(private readonly discovery: DiscoveryService) {}

  onApplicationBootstrap(): void {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    const controllers = this.discovery.getControllers().map((w) => w.metatype).filter((m): m is Function => typeof m === 'function');
    const routes = listRoutes(controllers);
    const problems = [
      ...routesWithoutPolicy(routes).map((r) => `${r.method} ${r.path} (${r.controller}.${r.handler}) has no access policy`),
      ...routes
        .filter((r) => r.policy.kind === 'signed-in' && !(r.policy.reason ?? '').trim())
        .map((r) => `${r.method} ${r.path} (${r.controller}.${r.handler}) is @SignedInOnly without a reason`),
    ];
    if (problems.length > 0) {
      throw new Error(`Deny by default: refusing to start.\n  ${problems.join('\n  ')}`);
    }
  }
}
