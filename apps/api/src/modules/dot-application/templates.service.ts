import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  DOT_APP_DOCUMENTS,
  dotAppDocument,
  type DotAppTemplate,
  type DotAppTemplateOverview,
  type DotAppTemplateRow,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { companyProfiles } from '../../database/schema/company-profile';
import { applicationDocumentTemplates, type ApplicationDocumentTemplateRow } from '../../database/schema/dot-application';
import { storedFiles } from '../../database/schema/files';
import { companies } from '../../database/schema/roster';
import { AuditService } from '../people/audit.service';

export const TEMPLATES_PERMISSION = 'application_templates.manage';

/** Stable JSON (sorted keys) so the same content always has the same digest. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/**
 * A bundled source set: the legal documents of ONE company, transcribed verbatim from that company's
 * approved PDFs. It can be imported only into the company it belongs to, matched on the company's
 * own name / legal name in the database — a set is never offered to, or copied into, another company.
 */
interface SourceSet {
  id: string;
  title: string;
  belongsTo: RegExp;
  documents: readonly { key: string; title: string; version: string; source: string; content: unknown }[];
}
// Company-specific document sets (a carrier's own signed PDFs, transcribed) are kept out of the
// public snapshot; a deployment registers its own here.
const SOURCE_SETS: SourceSet[] = [];

function toRow(r: ApplicationDocumentTemplateRow): DotAppTemplateRow {
  return {
    id: r.id,
    docKey: r.docKey,
    title: r.title,
    version: r.version,
    status: r.status as DotAppTemplateRow['status'],
    sourceFileName: r.sourceFileName,
    sourceSha256: r.sourceSha256,
    contentSha256: r.contentSha256,
    createdAt: r.createdAt.toISOString(),
    createdByName: r.createdByName,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    approvedByName: r.approvedByName,
    note: r.note,
  };
}

export function toTemplate(r: ApplicationDocumentTemplateRow): DotAppTemplate {
  const content = (r.content ?? {}) as Record<string, unknown>;
  return {
    key: r.docKey,
    version: r.version,
    title: r.title,
    source: typeof content.src === 'string' ? content.src : r.sourceFileName,
    content,
    contentSha256: r.contentSha256,
  };
}

/**
 * Admin → Document templates (owner brief 2026-10-27 §0.1). Each company's driver-application
 * legal documents, versioned: a draft is uploaded or imported, an administrator approves it, the
 * previously approved version is retired (kept). An application freezes the versions it opened
 * with; a driver signs only an approved version of their own company's document.
 */
@Injectable()
export class DotAppTemplatesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private assertManage(principal: Principal): void {
    if (!principal.permissions.has(TEMPLATES_PERMISSION)) {
      throw new AppError({ status: 403, title: 'Forbidden', detail: 'Managing document templates needs the Document templates permission.' });
    }
  }

  private async companyNames(companyId: string): Promise<{ name: string; legal: string }> {
    const [row] = await this.db
      .select({ name: companies.name, record: companyProfiles.record })
      .from(companies)
      .leftJoin(companyProfiles, eq(companyProfiles.companyId, companies.id))
      .where(eq(companies.id, companyId))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such company.' });
    return { name: row.name, legal: ((row.record ?? {}) as { legalName?: string }).legalName ?? '' };
  }

  private async setsFor(companyId: string): Promise<SourceSet[]> {
    const { name, legal } = await this.companyNames(companyId);
    return SOURCE_SETS.filter((s) => s.belongsTo.test(name) || (legal && s.belongsTo.test(legal)));
  }

  /** The approved template per document key for a company (only that company's rows). */
  async approved(companyId: string): Promise<Map<string, ApplicationDocumentTemplateRow>> {
    const rows = await this.db
      .select()
      .from(applicationDocumentTemplates)
      .where(and(eq(applicationDocumentTemplates.companyId, companyId), eq(applicationDocumentTemplates.status, 'approved')));
    return new Map(rows.map((r) => [r.docKey, r]));
  }

  /** The exact versions an application froze (falls back to nothing for a key it did not freeze). */
  async frozen(companyId: string, versions: Record<string, string>): Promise<Map<string, ApplicationDocumentTemplateRow>> {
    const keys = Object.keys(versions);
    if (keys.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(applicationDocumentTemplates)
      .where(and(eq(applicationDocumentTemplates.companyId, companyId), inArray(applicationDocumentTemplates.docKey, keys)));
    const out = new Map<string, ApplicationDocumentTemplateRow>();
    for (const r of rows) if (versions[r.docKey] === r.version) out.set(r.docKey, r);
    return out;
  }

  /** Documents a complete application needs that the company has not approved. */
  async awaiting(companyId: string): Promise<{ key: string; title: string }[]> {
    const approved = await this.approved(companyId);
    // A document added later blocks only a company whose own bundled set carries it (that set must
    // then be complete); another company keeps working and its drivers see "Awaiting …" for it.
    const own = new Set((await this.setsFor(companyId)).flatMap((s) => s.documents.map((d) => d.key)));
    return DOT_APP_DOCUMENTS.filter((d) => d.signer !== 'employer' && !approved.has(d.key) && (!d.addedLater || own.has(d.key))).map((d) => ({ key: d.key, title: d.title }));
  }

  async overview(principal: Principal): Promise<DotAppTemplateOverview> {
    this.assertManage(principal);
    const rows = await this.db
      .select()
      .from(applicationDocumentTemplates)
      .where(eq(applicationDocumentTemplates.companyId, principal.companyId))
      .orderBy(asc(applicationDocumentTemplates.createdAt));
    const { name } = await this.companyNames(principal.companyId);
    const sets = await this.setsFor(principal.companyId);
    return {
      company: { id: principal.companyId, name },
      documents: DOT_APP_DOCUMENTS.map((d) => {
        const versions = rows.filter((r) => r.docKey === d.key).map(toRow).reverse();
        return { key: d.key, title: d.title, step: d.step, current: versions.find((v) => v.status === 'approved') ?? null, versions };
      }),
      importableSets: sets.map((s) => ({ id: s.id, title: s.title, documents: s.documents.length })),
    };
  }

  async create(
    principal: Principal,
    input: { docKey: string; version: string; title: string; content: Record<string, unknown>; sourceFileId?: string; note?: string },
  ): Promise<DotAppTemplateRow> {
    this.assertManage(principal);
    if (!dotAppDocument(input.docKey)) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: `Unknown document ${input.docKey}.` });
    let source: { name: string; key: string; sha: string | null } | null = null;
    if (input.sourceFileId) {
      const [file] = await this.db
        .select()
        .from(storedFiles)
        .where(and(eq(storedFiles.companyId, principal.companyId), eq(storedFiles.id, input.sourceFileId)))
        .limit(1);
      if (!file) throw new AppError({ status: 404, title: 'Not Found', detail: 'That source file is not on file for this company.' });
      source = { name: file.fileName, key: file.storageKey, sha: null };
    }
    const id = `adt_${crypto.randomUUID()}`;
    try {
      await this.db.insert(applicationDocumentTemplates).values({
        id,
        companyId: principal.companyId,
        docKey: input.docKey,
        version: input.version,
        title: input.title,
        content: input.content,
        contentSha256: sha256(stableJson(input.content)),
        sourceFileName: source?.name ?? null,
        sourceStorageKey: source?.key ?? null,
        sourceSha256: source?.sha ?? null,
        note: input.note ?? null,
        createdByUserId: principal.userId,
        createdByName: principal.userName ?? principal.userId,
      });
    } catch (error) {
      if (String((error as { code?: string }).code) === '23505') {
        throw new AppError({ status: 409, title: 'Conflict', detail: `Version ${input.version} of this document already exists.` });
      }
      throw error;
    }
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'application_template',
      entityId: id,
      entityLabel: `${input.title} (${input.version})`,
      summary: `Document template draft: ${input.docKey} version ${input.version}`,
      changes: [{ field: 'status', old: null, new: 'draft' }],
    });
    const [row] = await this.db.select().from(applicationDocumentTemplates).where(eq(applicationDocumentTemplates.id, id));
    return toRow(row!);
  }

  /** Approve a draft: the previously approved version of that document is retired (kept). */
  async approve(principal: Principal, id: string): Promise<DotAppTemplateRow> {
    this.assertManage(principal);
    const at = new Date();
    const row = await this.db.transaction(async (tx) => {
      const [draft] = await tx
        .select()
        .from(applicationDocumentTemplates)
        .where(and(eq(applicationDocumentTemplates.companyId, principal.companyId), eq(applicationDocumentTemplates.id, id)))
        .for('update');
      if (!draft) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such template.' });
      if (draft.status !== 'draft') throw new AppError({ status: 409, title: 'Conflict', detail: `This version is ${draft.status}, not a draft.` });
      await tx
        .update(applicationDocumentTemplates)
        .set({ status: 'retired', retiredAt: at, retiredByName: principal.userName ?? principal.userId })
        .where(
          and(
            eq(applicationDocumentTemplates.companyId, principal.companyId),
            eq(applicationDocumentTemplates.docKey, draft.docKey),
            eq(applicationDocumentTemplates.status, 'approved'),
          ),
        );
      const [updated] = await tx
        .update(applicationDocumentTemplates)
        .set({ status: 'approved', approvedAt: at, approvedByUserId: principal.userId, approvedByName: principal.userName ?? principal.userId })
        .where(eq(applicationDocumentTemplates.id, id))
        .returning();
      return updated!;
    });
    await this.audit.write(principal, {
      action: 'approve',
      entityType: 'application_template',
      entityId: id,
      entityLabel: `${row.title} (${row.version})`,
      summary: `Document template approved: ${row.docKey} version ${row.version}`,
      changes: [{ field: 'status', old: 'draft', new: 'approved' }],
    });
    return toRow(row);
  }

  async retire(principal: Principal, id: string, reason: string): Promise<DotAppTemplateRow> {
    this.assertManage(principal);
    const [row] = await this.db
      .update(applicationDocumentTemplates)
      .set({ status: 'retired', retiredAt: new Date(), retiredByName: principal.userName ?? principal.userId })
      .where(and(eq(applicationDocumentTemplates.companyId, principal.companyId), eq(applicationDocumentTemplates.id, id)))
      .returning();
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such template.' });
    await this.audit.write(principal, {
      action: 'archive',
      entityType: 'application_template',
      entityId: id,
      entityLabel: `${row.title} (${row.version})`,
      summary: `Document template retired: ${row.docKey} version ${row.version}`,
      reason,
    });
    return toRow(row);
  }

  /**
   * Import a bundled source set as drafts — only the company's own set. Re-running skips versions
   * already on file. An administrator then reads and approves each document.
   */
  async importSet(principal: Principal, setId: string): Promise<{ created: number; skipped: number }> {
    this.assertManage(principal);
    const set = (await this.setsFor(principal.companyId)).find((s) => s.id === setId);
    if (!set) throw new AppError({ status: 403, title: 'Forbidden', detail: 'That document set belongs to another company and cannot be imported here.' });
    let created = 0;
    let skipped = 0;
    for (const d of set.documents) {
      const [exists] = await this.db
        .select({ id: applicationDocumentTemplates.id })
        .from(applicationDocumentTemplates)
        .where(
          and(
            eq(applicationDocumentTemplates.companyId, principal.companyId),
            eq(applicationDocumentTemplates.docKey, d.key),
            eq(applicationDocumentTemplates.version, d.version),
          ),
        )
        .limit(1);
      if (exists) {
        skipped++;
        continue;
      }
      await this.create(principal, { docKey: d.key, version: d.version, title: d.title, content: d.content as Record<string, unknown>, note: `Imported from ${set.title}` });
      created++;
    }
    return { created, skipped };
  }

  /** Approve every draft at once (the administrator has read them). */
  async approveAllDrafts(principal: Principal): Promise<{ approved: number }> {
    this.assertManage(principal);
    const drafts = await this.db
      .select({ id: applicationDocumentTemplates.id })
      .from(applicationDocumentTemplates)
      .where(and(eq(applicationDocumentTemplates.companyId, principal.companyId), eq(applicationDocumentTemplates.status, 'draft')));
    for (const d of drafts) await this.approve(principal, d.id);
    return { approved: drafts.length };
  }

  async one(principal: Principal, id: string): Promise<DotAppTemplate & { row: DotAppTemplateRow }> {
    this.assertManage(principal);
    const [row] = await this.db
      .select()
      .from(applicationDocumentTemplates)
      .where(and(eq(applicationDocumentTemplates.companyId, principal.companyId), eq(applicationDocumentTemplates.id, id)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such template.' });
    return { ...toTemplate(row), row: toRow(row) };
  }
}
