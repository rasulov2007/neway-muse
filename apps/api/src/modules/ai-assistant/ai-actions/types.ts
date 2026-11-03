import type Anthropic from '@anthropic-ai/sdk';
import type { AiCard } from '@neway/shared';
import type { Principal } from '../../../common/auth/principal';

/**
 * Actions NeWay AI can carry out itself (owner, 2026-10-20: "do it like Claude in Chrome does").
 *
 * Every action goes through the same services the screens use, as the signed-in person: their
 * company, their permissions, the services' own version checks and audit entries. An action is
 * split in two so nothing is written on a guess:
 *
 *   plan - read only: checks the input and the record as it stands, and says exactly what will
 *          happen (the confirmation card). A refusal comes back in the app's own words.
 *   run  - re-reads the record, refuses if it changed since the plan (a stale plan never
 *          overwrites), then writes through the service.
 *
 * `risk` says who presses the button:
 *   'safe'    - everyday operational writes (assign a driver, record a stop event, a check call,
 *               a note, a flag). The AI runs them straight away when Dry run is off.
 *   'confirm' - money, invoices, statements, payments, repairs: the person presses Confirm on
 *               the card first.
 * With Dry run on, nothing runs at all - safe actions included.
 */

/** Services are looked up by class from the running app, so an action file needs no module wiring. */
export interface ActionContext {
  get<T>(type: abstract new (...args: never[]) => T): T;
}

export interface ActionPlan<P> {
  ok: true;
  /** Card title: "Assign L-100005 to John Smith · Unit 2702". */
  title: string;
  /** What will change, one fact per line, in the app's words. */
  lines: string[];
  /** Everything run() needs, including the version / updatedAt seen now. */
  params: P;
  /** Same fingerprint = same action on the same record; a second identical proposal is refused. */
  fingerprint: string;
  totalCents?: number | null;
  destination?: string | null;
  /** Problems that do not stop the action but the person should see. */
  warnings?: string[];
}

export interface ActionRefusal {
  ok: false;
  /** Why it cannot be done, and what to do instead (the app's own refusal text where there is one). */
  reason: string;
}

export interface ActionResult {
  /** "L-100005 assigned to John Smith." */
  text: string;
  /** Links to the record, a PDF to download, ... */
  cards?: AiCard[];
}

export interface ActionDef<P = Record<string, unknown>> {
  /** Tool name the model calls, snake_case, e.g. "load_assign_driver". */
  name: string;
  /** For the model: what it does, when to use it, what it needs. */
  description: string;
  input_schema: Anthropic.Tool['input_schema'];
  /** Permission code checked at plan time and again at run time. */
  permission: string;
  risk: 'safe' | 'confirm';
  plan(ctx: ActionContext, principal: Principal, input: Record<string, unknown>): Promise<ActionPlan<P> | ActionRefusal>;
  /** Throws an AppError (or returns a refusal text via `stale`) when the record moved on. */
  run(ctx: ActionContext, principal: Principal, params: P): Promise<ActionResult>;
}

/** Thrown by run() when the record is no longer what the plan saw. */
export class StaleActionError extends Error {}

export const refusal = (reason: string): ActionRefusal => ({ ok: false, reason });
export const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
