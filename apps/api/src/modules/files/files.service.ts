import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { API_PREFIX, workspaceKeyPolicy } from '@neway/shared';
import { AppError } from '../../common/errors/app-error';
import { DocumentStorageService } from '../../common/storage/document-storage.service';
import { DatabaseService } from '../../database/database.service';
import { storedFiles } from '../../database/schema/files';
import { memberships } from '../../database/schema/admin';
import { restrictedAccessLog } from '../../database/schema/accidents-v2';
import type { Principal } from '../../common/auth/principal';
import { env } from '../../config/env';
import { AuditService } from '../people/audit.service';
import { LEGACY_WORKSPACE_COMPANY, clientKeyOf } from '../state/state.service';
import {
  FILES_MANAGE,
  OWNER_SOURCES,
  messageOwners,
  SIGNED_LINK_TTL_MS,
  ownersAdmit,
  signFileLink,
  verifyFileLink,
  workspaceOwner,
  type FileOwner,
  type SignedFileClaims,
} from './file-access';

export interface StoredFileInfo {
  id: string;
  /** The path the client asks for a signed link at (`GET <url>/link`), with its session token. */
  url: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: string;
}

export interface DeletedFileInfo extends StoredFileInfo {
  deletedAt: string;
  deletedBy: string | null;
  deleteReason: string | null;
}

/** Turns `data:<type>;base64,<bytes>` into its parts; null for anything else. */
export function parseDataUrl(value: string): { contentType: string; bytes: Buffer } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[2] ?? '', 'base64');
  if (bytes.byteLength === 0) return null;
  return { contentType: match[1] ?? 'application/octet-stream', bytes };
}

function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'application/pdf':
      return '.pdf';
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/heic':
      return '.heic';
    default:
      return '';
  }
}

/** `text` with `$1` (company) and `$2` (file) bound as parameters. Only the constant OWNER_SOURCES are passed here. */
function bind(text: string, companyId: string, fileId: string): SQL {
  const query = sql.empty();
  for (const part of text.split(/(\$1|\$2)/)) {
    if (part === '$1') query.append(sql`${companyId}`);
    else if (part === '$2') query.append(sql`${fileId}`);
    else if (part) query.append(sql.raw(part));
  }
  return query;
}

const forbidden = (detail: string, extensions?: Record<string, unknown>) =>
  new AppError({ status: 403, title: 'Forbidden', type: '/problems/forbidden', detail, ...(extensions ? { extensions } : {}) });

/**
 * Stored file bytes and who may reach them.
 *
 * Every file is scoped to a company: a row is only ever found through the caller's own
 * `companyId`, so a guessed id from another workspace reads as "not found". On top of that
 * (owner brief, 2026-10-25): every read resolves the records that point at the file and needs one
 * of their view codes (file-access.ts); the bytes travel only through a five-minute signed link
 * bound to the company, the file and the user; a soft-deleted file is invisible to every read
 * except the administrator's restore view; and nothing is ever removed from disk.
 */
@Injectable()
export class FilesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: DocumentStorageService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  static urlFor(id: string): string {
    return `/${API_PREFIX}/files/${encodeURIComponent(id)}`;
  }

  static signedUrlFor(token: string): string {
    return `/${API_PREFIX}/files/signed?t=${encodeURIComponent(token)}`;
  }

  async store(
    companyId: string,
    input: { fileName: string; contentType: string; bytes: Buffer; uploadedBy: string },
  ): Promise<StoredFileInfo> {
    const id = `file_${randomUUID()}`;
    const stored = await this.storage.put(
      `files/${companyId}/${id}${extensionFor(input.contentType)}`,
      input.bytes,
    );
    const [row] = await this.db
      .insert(storedFiles)
      .values({
        id,
        companyId,
        fileName: input.fileName.slice(0, 255) || 'file',
        contentType: input.contentType,
        sizeBytes: stored.sizeBytes,
        storageKey: stored.key,
        uploadedBy: input.uploadedBy,
      })
      .returning();
    if (!row) throw new Error('File row was not written');
    return this.info(row);
  }

  async describe(companyId: string, id: string): Promise<StoredFileInfo> {
    return this.info(await this.row(companyId, id));
  }

  /** The bytes, for server-side readers (invoices, RTS packets, the broker packet). Soft-deleted files are not found. */
  async read(
    companyId: string,
    id: string,
  ): Promise<{ info: StoredFileInfo; bytes: Buffer }> {
    const row = await this.row(companyId, id);
    return { info: this.info(row), bytes: await this.storage.get(row.storageKey) };
  }

  // ------------------------------------------------------------------------------------ owners

  /** Every record of this company that points at the file. */
  async owners(principal: Principal, id: string): Promise<FileOwner[]> {
    const companyId = principal.companyId;
    const union = sql.empty();
    OWNER_SOURCES.forEach((source, i) => {
      if (i > 0) union.append(sql.raw(' union all '));
      union.append(sql.raw(`select '${source.kind}' as kind, owner_id from (`));
      union.append(bind(source.sql, companyId, id));
      union.append(sql.raw(') s' + i));
    });
    const rows = (await this.db.execute(union)) as unknown as { kind: string; owner_id: string }[];
    const owners: FileOwner[] = rows.map((row) => {
      const source = OWNER_SOURCES.find((s) => s.kind === row.kind)!;
      return { kind: row.kind, id: row.owner_id, read: source.read, protected: source.protected, sensitive: source.sensitive ?? false };
    });

    // The workspace collections that still keep file references in their rows.
    const prefixMatch = companyId === LEGACY_WORKSPACE_COMPANY ? sql`key not like 't.%'` : sql`starts_with(key, ${`t.${companyId}.`})`;
    const keys = (await this.db.execute(
      sql`select key from app_state where ${prefixMatch} and strpos(value, ${id}) > 0`,
    )) as unknown as { key: string }[];
    for (const { key } of keys) {
      const clientKey = clientKeyOf(companyId, key);
      if (clientKey && workspaceKeyPolicy(clientKey)) owners.push(workspaceOwner(clientKey));
    }

    // An AI conversation attachment opens for the person whose conversation it is.
    const ai = (await this.db.execute(
      sql`select c.user_id from ai_messages m join ai_conversations c on c.id = m.conversation_id and c.company_id = m.company_id
           where m.company_id = ${companyId} and strpos(m.attachments::text, ${id}) > 0 limit 5`,
    )) as unknown as { user_id: string }[];
    for (const row of ai) owners.push({ kind: 'ai_attachment', id: row.user_id, read: [], protected: false, sensitive: false, userId: row.user_id });

    // A message attachment (mobile M4) opens for the conversation's participants and its department.
    const conversationsWithFile = (await this.db.execute(
      sql`select c.id as conversation_id, c.department,
                 (select array_agg(p.user_id) from conversation_participants p
                   where p.conversation_id = c.id and p.user_id is not null and p.left_at is null) as user_ids
            from messages m join conversations c on c.id = m.conversation_id and c.company_id = m.company_id
           where m.company_id = ${companyId} and m.voided_at is null and strpos(m.attachments::text, ${id}) > 0
           group by c.id, c.department limit 10`,
    )) as unknown as { conversation_id: string; department: string | null; user_ids: string[] | null }[];
    owners.push(...messageOwners(conversationsWithFile));
    return owners;
  }

  /**
   * Refuses (403) a caller who may not open this file: none of its owners' view codes, a sensitive
   * file without a Safety / HR code, restricted accident evidence without accidents.restricted. A
   * file nobody points at yet opens for its uploader and for the administrator.
   */
  async assertMayOpen(principal: Principal, row: typeof storedFiles.$inferSelect): Promise<FileOwner[]> {
    const owners = await this.owners(principal, row.id);
    const admin = principal.permissions.has(FILES_MANAGE);
    if (owners.length === 0) {
      const uploader = row.uploadedBy === principal.userId || (!!principal.userName && row.uploadedBy === principal.userName);
      if (!uploader && !admin) throw forbidden('This file is not attached to anything you can open.');
    } else if (!ownersAdmit(principal, owners)) {
      const sensitive = owners.some((o) => o.sensitive);
      throw forbidden(
        sensitive
          ? 'This is a restricted personnel document (licence, medical, consent or testing). Only Safety and HR can open it.'
          : 'You do not have access to the record this file belongs to.',
        { owners: [...new Set(owners.map((o) => o.kind.split(':')[0]))] },
      );
    }
    // Restricted accident / claim evidence reaches only holders of accidents.restricted (Safety Manager, owner).
    const restricted = await this.restrictedEvidence(principal.companyId, row.id);
    if (restricted) {
      if (!principal.permissions.has('accidents.restricted')) {
        throw forbidden('This file is restricted accident evidence. Only Safety Managers and the owner can open it.', { permission: 'accidents.restricted' });
      }
      await this.logRestrictedRead(principal, row.id, restricted);
    }
    if (owners.some((o) => o.sensitive)) {
      await this.audit.write(principal, {
        action: 'view',
        entityType: 'stored_file',
        entityId: row.id,
        entityLabel: row.fileName,
        summary: 'Restricted personnel document opened',
      });
    }
    return owners;
  }

  // ------------------------------------------------------------------------------ signed links

  /** A five-minute link to the bytes, bound to this company, this file and this user. */
  async signedLink(principal: Principal, id: string, options: { includeDeleted?: boolean } = {}): Promise<{ url: string; expiresAt: string }> {
    const includeDeleted = options.includeDeleted === true && principal.permissions.has(FILES_MANAGE);
    const row = await this.row(principal.companyId, id, { includeDeleted });
    await this.assertMayOpen(principal, row);
    const expires = Date.now() + SIGNED_LINK_TTL_MS;
    const claims: SignedFileClaims = { f: row.id, c: principal.companyId, u: principal.userId, e: expires, ...(includeDeleted ? { d: 1 as const } : {}) };
    return { url: FilesService.signedUrlFor(signFileLink(env.APP_SECRET, claims)), expiresAt: new Date(expires).toISOString() };
  }

  /**
   * The bytes behind a signed link. Refused when the link is malformed, tampered with or expired,
   * when the request carries a session of another user or company, and when the user it was
   * issued to is no longer an active member of the company.
   */
  async readSigned(token: string, caller: Principal | undefined): Promise<{ info: StoredFileInfo; bytes: Buffer }> {
    const verified = verifyFileLink(env.APP_SECRET, token, Date.now());
    if (!verified.ok) {
      throw verified.reason === 'expired'
        ? new AppError({ status: 410, title: 'Gone', detail: 'This file link has expired. Open the file again.' })
        : forbidden('This file link is not valid.');
    }
    const { claims } = verified;
    if (caller && caller.signedIn === true && (caller.userId !== claims.u || caller.companyId !== claims.c)) {
      throw forbidden('This file link was issued to someone else.');
    }
    const [member] = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, claims.u), eq(memberships.companyId, claims.c), eq(memberships.status, 'active')))
      .limit(1);
    if (!member) throw forbidden('This file link was issued to someone else.');
    const row = await this.row(claims.c, claims.f, { includeDeleted: claims.d === 1 });
    return { info: this.info(row), bytes: await this.storage.get(row.storageKey) };
  }

  /**
   * Is this file restricted accident / claim evidence (SPEC §7.13, go-live decision 2026-10-22)? True when a live or
   * removed evidence document — or a version of one — that points at it is restricted: the document's own flag, a
   * "(restricted)" category (medical, legal, test record; a legacy test_record kind reads as one), or a document on a
   * restricted claim. Returns where it belongs, for the restricted-access log.
   */
  async restrictedEvidence(companyId: string, id: string): Promise<{ accidentId: string | null; claimId: string | null } | null> {
    const rows = (await this.db.execute(sql`
      with docs as (
        select d.id, d.case_type, d.case_id from safety_case_documents d
         where d.company_id = ${companyId} and d.file_id = ${id}
        union
        select d.id, d.case_type, d.case_id from safety_document_versions v
          join safety_case_documents d on d.company_id = v.company_id and d.id = v.document_id
         where v.company_id = ${companyId} and v.file_id = ${id}
      )
      select x.case_type, x.case_id from docs x join safety_case_documents d on d.id = x.id
       where d.restricted
          or coalesce(d.category, '') like '%(restricted)'
          or (d.category is null and d.kind = 'test_record')
          or (d.case_type = 'claim' and exists (select 1 from safety_claims k where k.company_id = d.company_id and k.id = d.case_id and (k.restricted or k.claim_type = 'workers_comp')))
       limit 1`)) as unknown as Array<{ case_type: string; case_id: string }>;
    const hit = rows[0];
    if (!hit) return null;
    return { accidentId: hit.case_type === 'accident' ? hit.case_id : null, claimId: hit.case_type === 'claim' ? hit.case_id : null };
  }

  /** A permitted read of restricted evidence is logged, like every other restricted read (SPEC §8.3, K7). */
  async logRestrictedRead(principal: Principal, fileId: string, where: { accidentId: string | null; claimId: string | null }): Promise<void> {
    await this.db.insert(restrictedAccessLog).values({
      id: `ral_${randomUUID()}`,
      companyId: principal.companyId,
      at: new Date(),
      actorId: principal.userId,
      actorName: principal.userName ?? principal.userId,
      accidentId: where.accidentId,
      claimId: where.claimId,
      resource: `file:${fileId}`,
    });
  }

  // ------------------------------------------------------------------------------ soft delete

  /**
   * Marks an unattached file deleted (administrators only; the route checks files.manage).
   *
   * A file any business record points at - a load's RC / BOL / POD, an invoice, a work order
   * invoice, accident evidence, a company paper, a recruiting document, a workspace collection - is
   * refused (409): it is archived with its record (void the record), never on its own. The bytes are
   * never removed, and the row stays: restore clears the mark. Both are audited.
   */
  async softDelete(principal: Principal, id: string, reason: string): Promise<DeletedFileInfo> {
    const row = await this.row(principal.companyId, id);
    const owners = await this.owners(principal, row.id);
    const protectedOwners = owners.filter((o) => o.protected);
    if (protectedOwners.length > 0) {
      await this.audit.write(principal, {
        action: 'delete_refused',
        entityType: 'stored_file',
        entityId: row.id,
        entityLabel: row.fileName,
        summary: `Delete refused: the file belongs to ${[...new Set(protectedOwners.map((o) => o.kind.split(':')[0]))].join(', ')}`,
        reason,
      });
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'This file belongs to a business record and cannot be deleted. Void or archive the record it belongs to; the file stays with it.',
        extensions: { owners: protectedOwners.map((o) => ({ kind: o.kind, id: o.id })) },
      });
    }
    const at = new Date();
    const by = principal.userName ?? principal.userId;
    await this.db
      .update(storedFiles)
      .set({ deletedAt: at, deletedBy: by, deleteReason: reason })
      .where(and(eq(storedFiles.companyId, principal.companyId), eq(storedFiles.id, row.id), isNull(storedFiles.deletedAt)));
    await this.audit.write(principal, {
      action: 'delete',
      entityType: 'stored_file',
      entityId: row.id,
      entityLabel: row.fileName,
      summary: `File removed (kept on disk, restorable): ${row.fileName}`,
      changes: [{ field: 'deletedAt', old: null, new: at.toISOString() }],
      reason,
    });
    return this.deletedInfo({ ...row, deletedAt: at, deletedBy: by, deleteReason: reason });
  }

  async restore(principal: Principal, id: string, reason: string | null): Promise<StoredFileInfo> {
    const row = await this.row(principal.companyId, id, { includeDeleted: true });
    if (!row.deletedAt) throw new AppError({ status: 409, title: 'Conflict', detail: 'This file is not deleted.' });
    await this.db
      .update(storedFiles)
      .set({ deletedAt: null, deletedBy: null, deleteReason: null })
      .where(and(eq(storedFiles.companyId, principal.companyId), eq(storedFiles.id, row.id)));
    await this.audit.write(principal, {
      action: 'restore',
      entityType: 'stored_file',
      entityId: row.id,
      entityLabel: row.fileName,
      summary: `File restored: ${row.fileName}`,
      changes: [{ field: 'deletedAt', old: row.deletedAt.toISOString(), new: null }],
      reason,
    });
    return this.info({ ...row, deletedAt: null, deletedBy: null, deleteReason: null });
  }

  /** The administrator's restore view: this company's soft-deleted files, newest first. */
  async listDeleted(principal: Principal): Promise<DeletedFileInfo[]> {
    const rows = await this.db
      .select()
      .from(storedFiles)
      .where(and(eq(storedFiles.companyId, principal.companyId), isNotNull(storedFiles.deletedAt)))
      .orderBy(desc(storedFiles.deletedAt))
      .limit(500);
    return rows.map((r) => this.deletedInfo(r));
  }

  async row(companyId: string, id: string, options: { includeDeleted?: boolean } = {}) {
    const [row] = await this.db
      .select()
      .from(storedFiles)
      .where(
        and(
          eq(storedFiles.companyId, companyId),
          eq(storedFiles.id, id),
          options.includeDeleted ? undefined : isNull(storedFiles.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such file.' });
    return row;
  }

  private info(row: typeof storedFiles.$inferSelect): StoredFileInfo {
    return {
      id: row.id,
      url: FilesService.urlFor(row.id),
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      uploadedBy: row.uploadedBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private deletedInfo(row: typeof storedFiles.$inferSelect): DeletedFileInfo {
    return {
      ...this.info(row),
      deletedAt: (row.deletedAt ?? new Date(0)).toISOString(),
      deletedBy: row.deletedBy,
      deleteReason: row.deleteReason,
    };
  }
}
