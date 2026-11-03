import { createHmac, timingSafeEqual } from 'node:crypto';
import { MESSAGE_DEPARTMENT_PERMISSION, canReadWorkspaceKey, workspaceCollectionOf, type MessageDepartment } from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';

/**
 * Who may open a stored file, decided from the records that point at it (owner brief, 2026-10-25,
 * finding 6), and the short-lived signed link the browser fetches the bytes through.
 *
 * `stored_files` holds bytes only; it does not know what they belong to. So the owner is resolved
 * from every place a file id is kept - the loads table, Accounting's records, work orders, fleet
 * expenses, accident evidence, company papers, recruiting documents, the workspace collections -
 * and the caller must hold the view code of at least one of those owners. A file nobody points at
 * (an upload not attached yet) opens for the person who uploaded it and for an administrator.
 *
 * Sensitive owners (candidate CDL and medical scans, consent and onboarding evidence, drug and
 * alcohol records) additionally need a Safety or HR code. A file pointed at by any business record
 * is "protected": it can never be deleted, only voided / archived together with that record.
 */
export interface FileOwner {
  /** What points at the file: `load`, `accounting:acct_invoices`, `workspace:ws2-repairorders` … */
  kind: string;
  /** The id of the pointing record (or the workspace key). */
  id: string;
  /** Any one of these opens the file through this owner. */
  read: readonly string[];
  /** Business records: the file cannot be deleted while this owner exists. */
  protected: boolean;
  /** CDL / medical / consent / drug-and-alcohol material: Safety or HR codes are required too. */
  sensitive: boolean;
  /** Only this user opens it through this owner (an AI conversation attachment). */
  userId?: string;
}

/** Safety and HR seats: what a sensitive file needs on top of its owner's view code. */
export const SENSITIVE_FILE_PERMISSIONS = ['compliance_sensitive.view', 'safety_testing.view', 'recruiting.manage'] as const;

/** The administrator's file desk: soft delete, restore, the removed-files view. */
export const FILES_MANAGE = 'files.manage';

/** Workspace collections whose rows are not business records (a note, a notification). */
const UNPROTECTED_WORKSPACE = new Set(['notifications', 'tasks', 'activity', 'aiInsights', 'truckNotes']);

/** One SQL source of owners: `select <id> as owner_id … where company_id = $1 and <matches $2>`. */
export interface OwnerSource {
  kind: string;
  /** SQL selecting `owner_id` (text) for rows of company $1 that point at file $2. */
  sql: string;
  read: readonly string[];
  protected: boolean;
  sensitive?: boolean;
}

const has = (column: string) => `strpos(${column}::text, $2) > 0`;

/**
 * Every place a stored file id is kept. A new place that keeps file ids must be added here, or its
 * files open only for the uploader and the administrator (fails closed).
 */
export const OWNER_SOURCES: OwnerSource[] = [
  { kind: 'load', sql: `select id::text as owner_id from loads where company_id = $1 and ${has('record')}`, read: ['loads.view', 'accounting.view'], protected: true },
  ...[
    'acct_invoices', 'acct_bills', 'acct_expenses', 'acct_payments', 'acct_settlements', 'acct_completions', 'acct_deliveries',
    'acct_driver_transactions', 'acct_billing_exceptions', 'acct_import_records', 'acct_payment_batches', 'acct_settlement_batches',
  ].map((table) => ({
    kind: `accounting:${table}`,
    sql: `select id::text as owner_id from ${table} where company_id = $1 and ${has('record')}`,
    read: ['accounting.view'],
    protected: true,
  })),
  { kind: 'work_order', sql: `select id::text as owner_id from work_orders where company_id = $1 and ${has('invoice_file_ids')}`, read: ['maintenance_costs.view', 'accounting.view'], protected: true },
  { kind: 'accident_estimate', sql: `select id::text as owner_id from work_order_estimates where company_id = $1 and file_id = $2`, read: ['accidents.view', 'maintenance_costs.view'], protected: true },
  { kind: 'fleet_expense_file', sql: `select expense_id::text as owner_id from fleet_expense_files where company_id = $1 and file_id = $2`, read: ['maintenance_costs.view', 'accounting.view'], protected: true },
  { kind: 'fleet_expense_receipt', sql: `select id::text as owner_id from fleet_expenses where company_id = $1 and efs_receipt_file_id = $2`, read: ['maintenance_costs.view', 'accounting.view'], protected: true },
  { kind: 'truck_assignment_photo', sql: `select id::text as owner_id from truck_assignment_photos where company_id = $1 and file_id = $2`, read: ['trucks.view', 'truck_assignment.edit', 'drivers.view'], protected: true },
  { kind: 'company_document', sql: `select id::text as owner_id from company_documents where company_id = $1 and file_id = $2`, read: ['company_profile.view'], protected: true },
  { kind: 'safety_case_document', sql: `select id::text as owner_id from safety_case_documents where company_id = $1 and file_id = $2`, read: ['accidents.view', 'safety.view'], protected: true },
  { kind: 'safety_document_version', sql: `select document_id::text as owner_id from safety_document_versions where company_id = $1 and file_id = $2`, read: ['accidents.view', 'safety.view'], protected: true },
  { kind: 'safety_claim_document', sql: `select id::text as owner_id from safety_claim_documents where company_id = $1 and file_id = $2`, read: ['accidents.view', 'safety.view'], protected: true },
  { kind: 'driver_charge', sql: `select id::text as owner_id from safety_driver_charges where company_id = $1 and (notice_file_id = $2 or authorization_file_id = $2)`, read: ['safety.view', 'accidents.view', 'accounting.view'], protected: true },
  { kind: 'violation', sql: `select id::text as owner_id from safety_violations where company_id = $1 and training_proof_file_id = $2`, read: ['safety.view', 'compliance.view'], protected: true },
  { kind: 'hiring_cost', sql: `select id::text as owner_id from hiring_cost_entries where company_id = $1 and receipt_file_id = $2`, read: ['recruiting.view', 'accounting.view'], protected: true },
  { kind: 'candidate_document', sql: `select id::text as owner_id from hiring_external_applications where company_id = $1 and ${has('file_ids')}`, read: ['recruiting.view', 'compliance.view'], protected: true, sensitive: true },
  { kind: 'onboarding_evidence', sql: `select id::text as owner_id from hiring_onboarding_tasks where company_id = $1 and evidence_file_id = $2`, read: ['recruiting.view', 'compliance.view'], protected: true, sensitive: true },
  { kind: 'travel_confirmation', sql: `select id::text as owner_id from hiring_travel_items where company_id = $1 and confirmation_file_id = $2`, read: ['recruiting.view', 'accounting.view'], protected: true },
  // The driver app's walk-around photos (0081) and the defects they back: Safety and the shop open them.
  { kind: 'pti_inspection', sql: `select id::text as owner_id from pti_inspections where company_id = $1 and ${has('source')}`, read: ['maintenance.view', 'safety.view'], protected: true },
  { kind: 'pti_defect', sql: `select id::text as owner_id from pti_defects where company_id = $1 and ${has('evidence')}`, read: ['maintenance.view', 'safety.view'], protected: true },
  // Mobile M3: a breakdown's photos and video, and the photo of a truck parked for a vacation.
  { kind: 'fleet_breakdown', sql: `select id::text as owner_id from fleet_breakdowns where company_id = $1 and ${has('files')}`, read: ['maintenance.view'], protected: true },
  { kind: 'vacation_parked_photo', sql: `select id::text as owner_id from driver_vacations where company_id = $1 and truck_parked_file_id = $2`, read: ['drivers.view', 'dispatch.view'], protected: true },
  { kind: 'driver_payment_authorization', sql: `select driver_id::text as owner_id from driver_payment_details where company_id = $1 and authorization_file_id = $2`, read: ['accounting.view', 'drivers.edit'], protected: true },
];

/** Builds the owners of the workspace rows that mention the file. */
export function workspaceOwner(key: string): FileOwner {
  const collection = workspaceCollectionOf(key);
  return {
    kind: `workspace:${key}`,
    id: key,
    // The key's own read policy decides (workspace/access.ts); a sentinel code carries it.
    read: [`workspace-key:${key}`],
    protected: !(collection && UNPROTECTED_WORKSPACE.has(collection)),
    sensitive: false,
  };
}

/**
 * A message attachment (mobile M4): opens for each participant of the conversation, and through the
 * conversation's department for the holders of its permission (MESSAGE_DEPARTMENT_PERMISSION).
 * Drivers open their conversations' files through `/driver/conversations/:id/files/:fileId/link`.
 */
export function messageOwners(rows: ReadonlyArray<{ conversation_id: string; department: string | null; user_ids: string[] | null }>): FileOwner[] {
  const owners: FileOwner[] = [];
  for (const row of rows) {
    const code = row.department ? MESSAGE_DEPARTMENT_PERMISSION[row.department as MessageDepartment] : undefined;
    if (code) owners.push({ kind: 'message', id: row.conversation_id, read: [code], protected: true, sensitive: false });
    for (const userId of row.user_ids ?? []) owners.push({ kind: 'message', id: row.conversation_id, read: [], protected: true, sensitive: false, userId });
  }
  return owners;
}

/** True when the principal may open a file with these owners (empty owners = handled by the caller). */
export function ownersAdmit(principal: Principal, owners: readonly FileOwner[]): boolean {
  const reachable = owners.some((owner) => {
    if (owner.userId !== undefined) return owner.userId === principal.userId;
    return owner.read.some((code) =>
      code.startsWith('workspace-key:') ? canReadWorkspaceKey(principal.permissions, code.slice('workspace-key:'.length)) : hasPermission(principal, code),
    );
  });
  if (!reachable) return false;
  if (owners.some((o) => o.sensitive)) return SENSITIVE_FILE_PERMISSIONS.some((code) => hasPermission(principal, code));
  return true;
}

// ------------------------------------------------------------------------------- signed links

/** Five minutes (owner brief): long enough to start a download on a slow link, short enough to be useless when shared. */
export const SIGNED_LINK_TTL_MS = 5 * 60 * 1000;

export interface SignedFileClaims {
  /** File id. */
  f: string;
  /** Company. */
  c: string;
  /** User the link was issued to. */
  u: string;
  /** Expiry, epoch ms. */
  e: number;
  /** Issued for the administrator's removed-files view: may open a soft-deleted file. */
  d?: 1;
}

const b64 = (buf: Buffer) => buf.toString('base64url');

function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', `neway-file-link:${secret}`).update(payload).digest();
}

export function signFileLink(secret: string, claims: SignedFileClaims): string {
  const payload = b64(Buffer.from(JSON.stringify(claims), 'utf8'));
  return `${payload}.${b64(mac(secret, payload))}`;
}

export type VerifyResult = { ok: true; claims: SignedFileClaims } | { ok: false; reason: 'malformed' | 'signature' | 'expired' };

export function verifyFileLink(secret: string, token: string, now: number): VerifyResult {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return { ok: false, reason: 'malformed' };
  const expected = mac(secret, payload);
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature' };
  let claims: SignedFileClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SignedFileClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims.f !== 'string' || typeof claims.c !== 'string' || typeof claims.u !== 'string' || typeof claims.e !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.e <= now) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}
