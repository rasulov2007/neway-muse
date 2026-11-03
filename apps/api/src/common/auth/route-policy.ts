import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PUBLIC_ROUTE_KEY } from './public.decorator';
import { REQUIRED_ANY_PERMISSION_KEY, REQUIRED_PERMISSIONS_KEY } from './require-permission.decorator';
import { SIGNED_IN_ONLY_KEY } from './signed-in-only.decorator';

/**
 * What a route declares about who may call it (owner brief, 2026-10-25: deny by default).
 *
 *   - `public`      — `@Public()`: reachable without a session. Reviewed list, see public.decorator.
 *   - `permission`  — `@RequirePermission` (all of) and/or `@RequireAnyPermission` (one of).
 *   - `signed-in`   — `@SignedInOnly(reason)`: any signed-in member of the company; the reason
 *                     says what narrows it further (self-scoped data, a service-level check).
 *   - `none`        — nothing declared. The global AuthorizationGuard answers 403, and the boot
 *                     check refuses to start the API at all.
 */
export type RoutePolicyKind = 'public' | 'permission' | 'signed-in' | 'none';

export interface RoutePolicy {
  kind: RoutePolicyKind;
  /** Every one of these is required. */
  all: string[];
  /** At least one of these is required (empty = no any-of clause). */
  any: string[];
  /** For `signed-in`: why the route is open to every signed-in member. */
  reason?: string;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type Target = Function | object;

function meta<T>(key: string, target: Target): T | undefined {
  return Reflect.getMetadata(key, target) as T | undefined;
}

/** Resolves a route's policy from the handler and its controller class (the same merge the guard uses). */
export function resolveRoutePolicy(handler: Target, controller: Target): RoutePolicy {
  const isPublic = meta<boolean>(PUBLIC_ROUTE_KEY, handler) ?? meta<boolean>(PUBLIC_ROUTE_KEY, controller) ?? false;
  const all = [
    ...(meta<string[]>(REQUIRED_PERMISSIONS_KEY, controller) ?? []),
    ...(meta<string[]>(REQUIRED_PERMISSIONS_KEY, handler) ?? []),
  ];
  const any = [
    ...(meta<string[]>(REQUIRED_ANY_PERMISSION_KEY, controller) ?? []),
    ...(meta<string[]>(REQUIRED_ANY_PERMISSION_KEY, handler) ?? []),
  ];
  const reason = meta<string>(SIGNED_IN_ONLY_KEY, handler) ?? meta<string>(SIGNED_IN_ONLY_KEY, controller);
  if (isPublic) return { kind: 'public', all: [], any: [] };
  if (all.length > 0 || any.length > 0) return { kind: 'permission', all: [...new Set(all)], any: [...new Set(any)] };
  if (reason !== undefined) return { kind: 'signed-in', all: [], any: [], reason };
  return { kind: 'none', all: [], any: [] };
}

/** True when a principal holding `permissions` passes the policy (signed in assumed). */
export function policyAdmits(policy: RoutePolicy, permissions: ReadonlySet<string>): boolean {
  if (policy.kind === 'none') return false;
  if (policy.kind === 'public' || policy.kind === 'signed-in') return true;
  if (!policy.all.every((code) => permissions.has(code))) return false;
  if (policy.any.length > 0 && !policy.any.some((code) => permissions.has(code))) return false;
  return true;
}

export interface RouteEntry {
  method: string;
  /** Path below the API prefix, e.g. `/state/:key`. */
  path: string;
  controller: string;
  handler: string;
  policy: RoutePolicy;
  /** Guard class names declared on the controller or the handler (`@UseGuards`). */
  guards: string[];
}

function joinPath(base: string | undefined, sub: string | undefined): string {
  const parts = [base ?? '', sub ?? ''].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return `/${parts.join('/')}`;
}

function guardNames(target: Target): string[] {
  const guards = meta<unknown[]>(GUARDS_METADATA, target) ?? [];
  return guards.map((g) => (typeof g === 'function' ? g.name : (g as object)?.constructor?.name ?? 'guard'));
}

/** Every HTTP route a set of controller classes declares, with the policy each resolves to. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export function listRoutes(controllers: readonly Function[]): RouteEntry[] {
  const routes: RouteEntry[] = [];
  for (const controller of controllers) {
    const basePaths = meta<string | string[]>(PATH_METADATA, controller);
    const bases = Array.isArray(basePaths) ? basePaths : [basePaths ?? ''];
    const proto = (controller as { prototype: Record<string, unknown> }).prototype;
    const seen = new Set<string>();
    let cursor: object | null = proto;
    while (cursor && cursor !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(cursor)) {
        if (name === 'constructor' || seen.has(name)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
        const handler = descriptor?.value as Target | undefined;
        if (typeof handler !== 'function') continue;
        const method = meta<RequestMethod>(METHOD_METADATA, handler);
        const subPaths = meta<string | string[]>(PATH_METADATA, handler);
        if (method === undefined || subPaths === undefined) continue;
        seen.add(name);
        const subs = Array.isArray(subPaths) ? subPaths : [subPaths];
        for (const base of bases) {
          for (const sub of subs) {
            routes.push({
              method: RequestMethod[method] ?? String(method),
              path: joinPath(base, sub),
              controller: controller.name,
              handler: name,
              policy: resolveRoutePolicy(handler, controller),
              guards: [...guardNames(controller), ...guardNames(handler)],
            });
          }
        }
      }
      cursor = Object.getPrototypeOf(cursor) as object | null;
    }
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** Routes with no declared policy — what the boot check and CI refuse. */
export function routesWithoutPolicy(routes: readonly RouteEntry[]): RouteEntry[] {
  return routes.filter((route) => route.policy.kind === 'none');
}
