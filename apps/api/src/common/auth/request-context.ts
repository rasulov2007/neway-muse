import type { IncomingMessage } from 'node:http';
import type { Principal } from './principal';

/**
 * Per-request principal storage keyed by the raw Node request, so the same principal is visible
 * from Nest middleware (which receives the raw request under Fastify) and from guards, pipes and
 * controllers (which receive the Fastify request wrapping it).
 */
const principals = new WeakMap<object, Principal>();

/** Anything that is, or wraps, the raw Node request. */
export type RequestLike = IncomingMessage | { raw: IncomingMessage };

function rawOf(request: RequestLike): IncomingMessage {
  return 'raw' in request ? request.raw : request;
}

/** Attaches the principal to the request for the rest of its lifecycle. */
export function setPrincipal(request: RequestLike, principal: Principal): void {
  principals.set(rawOf(request), principal);
}

/** The principal attached to the request, or `undefined` before authentication ran. */
export function getPrincipal(request: RequestLike): Principal | undefined {
  return principals.get(rawOf(request));
}
