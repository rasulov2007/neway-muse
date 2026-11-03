import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  COMPANY_DOCUMENT_DEFS,
  CompanyProfileFieldsSchema,
  brokerPacketProblems,
  companyDocumentDef,
  companyDocumentStatus,
  type AddCompanyDocumentInput,
  type CompanyDocument,
  type CompanyDocumentKind,
  type CompanyDocumentSlot,
  type CompanyProfileFields,
  type CompanyProfileView,
  type UpdateCompanyProfileInput,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { companies, companyDocuments, companyProfiles } from '../../database/schema';
import { zip } from '../dispatch-board/xlsx';
import { FilesService } from '../files/files.service';
import { AuditService } from '../people/audit.service';

type DocRow = typeof companyDocuments.$inferSelect;

const refused = (status: number, detail: string) => new AppError({ status, title: status === 409 ? 'Conflict' : status === 404 ? 'Not Found' : 'Unprocessable Entity', detail });
const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** The fields people read on the profile, for the audit's before/after. */
const FIELD_LABEL: Partial<Record<keyof CompanyProfileFields, string>> = {
  legalName: 'Legal name',
  dba: 'DBA',
  mcNumber: 'MC #',
  dotNumber: 'DOT #',
  ein: 'EIN',
  scac: 'SCAC',
  phone: 'Phone',
  email: 'Email',
  physicalAddress: 'Physical address',
  mailingAddress: 'Mailing address',
  insuranceAgent: 'Insurance agent',
  insuranceAgentPhone: 'Agent phone',
  insuranceAgentEmail: 'Agent email',
  factoringCompany: 'Factoring company',
  noaReference: 'NOA reference',
  recruitingReplyTo: 'Recruiting reply-to email',
  accountingReplyTo: 'Accounting reply-to email',
};

/**
 * Company info (owner, 2026-10-19): the profile, the papers and the broker setup packet. Every
 * write is version-checked or append-only, audited, and scoped to the principal's company.
 */
@Injectable()
export class CompanyProfileService {
  constructor(
    private readonly database: DatabaseService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private who(principal: Principal): string {
    return principal.userName ?? principal.userId;
  }

  private requireEdit(principal: Principal): void {
    if (!hasPermission(principal, 'company_profile.edit')) throw refused(403, 'Changing company info needs the Company info edit permission.');
  }

  async view(principal: Principal): Promise<CompanyProfileView> {
    const companyId = principal.companyId;
    const [row] = await this.db.select().from(companyProfiles).where(eq(companyProfiles.companyId, companyId)).limit(1);
    const [co] = await this.db
      .select({ name: companies.name, recruitingReplyTo: companies.recruitingReplyTo, accountingReplyTo: companies.accountingReplyTo })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    const stored = CompanyProfileFieldsSchema.parse(row?.record ?? {});
    // Before anybody has saved one, the legal name starts as the company's own name. The reply-to
    // addresses live on the company row (the email sender reads them there).
    const profile = {
      ...stored,
      legalName: stored.legalName || co?.name || '',
      recruitingReplyTo: co?.recruitingReplyTo ?? '',
      accountingReplyTo: co?.accountingReplyTo ?? '',
    };
    const today = easternToday();
    const docs = await this.db
      .select()
      .from(companyDocuments)
      .where(and(eq(companyDocuments.companyId, companyId), isNull(companyDocuments.voidedAt)))
      .orderBy(asc(companyDocuments.createdAt));
    const slots = this.slots(docs, today);
    const problems = brokerPacketProblems(slots);
    return {
      profile,
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedBy ?? null,
      today,
      documents: slots,
      packet: { ready: problems.length === 0, problems, kinds: COMPANY_DOCUMENT_DEFS.filter((d) => d.inPacket).map((d) => d.kind) },
      canEdit: hasPermission(principal, 'company_profile.edit'),
    };
  }

  private toDoc(r: DocRow, versionNumber: number, today: string): CompanyDocument {
    return {
      id: r.id,
      kind: r.kind as CompanyDocumentKind,
      title: r.title || companyDocumentDef(r.kind as CompanyDocumentKind).label,
      fileId: r.fileId,
      fileName: r.fileName,
      issuedOn: r.issuedOn,
      expiresOn: r.expiresOn,
      note: r.note,
      versionNumber,
      uploadedBy: r.uploadedBy,
      uploadedAt: r.createdAt.toISOString(),
      status: companyDocumentStatus(r.expiresOn, today),
    };
  }

  /** One row per kind (the newest file, its earlier versions under it); every "Other" file is its own row. */
  private slots(docs: DocRow[], today: string): CompanyDocumentSlot[] {
    const out: CompanyDocumentSlot[] = [];
    for (const def of COMPANY_DOCUMENT_DEFS) {
      const mine = docs.filter((d) => d.kind === def.kind).map((d, i) => this.toDoc(d, i + 1, today));
      if (def.kind === 'other') {
        for (const d of mine.reverse()) out.push({ kind: def.kind, label: d.title, group: def.group, required: false, inPacket: false, status: d.status, current: d, history: [] });
        continue;
      }
      const current = mine.at(-1) ?? null;
      if (!current && !def.required) continue;
      out.push({
        kind: def.kind,
        label: def.label,
        group: def.group,
        required: def.required,
        inPacket: def.inPacket,
        status: current ? current.status : 'missing',
        current,
        history: mine.slice(0, -1).reverse(),
      });
    }
    return out;
  }

  async update(principal: Principal, input: UpdateCompanyProfileInput): Promise<CompanyProfileView> {
    this.requireEdit(principal);
    const companyId = principal.companyId;
    const { version, ...patch } = input;
    const [row] = await this.db.select().from(companyProfiles).where(eq(companyProfiles.companyId, companyId)).limit(1);
    const current = row?.version ?? 0;
    if (version !== current) throw refused(409, 'Someone changed the company info since you opened it. Reload to see their changes, then edit again.');
    const [co] = await this.db
      .select({ recruitingReplyTo: companies.recruitingReplyTo, accountingReplyTo: companies.accountingReplyTo })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    const before = CompanyProfileFieldsSchema.parse({ ...(row?.record ?? {}), recruitingReplyTo: co?.recruitingReplyTo ?? '', accountingReplyTo: co?.accountingReplyTo ?? '' });
    const after = CompanyProfileFieldsSchema.parse({ ...before, ...patch });
    // The reply-to addresses are kept on the company row, not in the profile record.
    const { recruitingReplyTo, accountingReplyTo, ...record } = after;
    const now = new Date();
    await this.db.transaction(async (tx) => {
      if (row) {
        const done = await tx
          .update(companyProfiles)
          .set({ record, version: current + 1, updatedBy: this.who(principal), updatedAt: now })
          .where(and(eq(companyProfiles.companyId, companyId), eq(companyProfiles.version, current)))
          .returning({ v: companyProfiles.version });
        if (done.length === 0) throw refused(409, 'Someone changed the company info at the same moment. Reload and edit again.');
      } else {
        await tx.insert(companyProfiles).values({ companyId, record, version: 1, updatedBy: this.who(principal), updatedAt: now });
      }
      if (recruitingReplyTo !== before.recruitingReplyTo || accountingReplyTo !== before.accountingReplyTo) {
        await tx
          .update(companies)
          .set({ recruitingReplyTo: recruitingReplyTo.trim().toLowerCase() || null, accountingReplyTo: accountingReplyTo.trim().toLowerCase() || null, updatedAt: now })
          .where(eq(companies.id, companyId));
      }
    });
    const changes = (Object.keys(FIELD_LABEL) as Array<keyof CompanyProfileFields>)
      .filter((k) => before[k] !== after[k])
      .map((k) => ({ field: FIELD_LABEL[k]!, old: String(before[k] ?? '') || null, new: String(after[k] ?? '') || null }));
    if (JSON.stringify(before.trailerYards) !== JSON.stringify(after.trailerYards)) {
      changes.push({ field: 'Trailer yards', old: before.trailerYards.map((y) => y.name).join(', ') || null, new: after.trailerYards.map((y) => y.name).join(', ') || null });
    }
    await this.audit.write(principal, { action: 'update', entityType: 'company_profile', entityId: companyId, entityLabel: after.legalName || 'Company info', summary: changes.length ? `Company info changed: ${changes.map((c) => c.field).join(', ')}` : 'Company info saved (no change)', changes });
    return this.view(principal);
  }

  async addDocument(principal: Principal, input: AddCompanyDocumentInput): Promise<CompanyProfileView> {
    this.requireEdit(principal);
    const def = companyDocumentDef(input.kind);
    const info = await this.files.describe(principal.companyId, input.fileId).catch(() => null);
    if (!info) throw refused(422, 'That file is not in this company’s file store. Upload it again.');
    if (def.kind === 'coi' && !input.expiresOn) throw refused(422, 'A certificate of insurance needs its expiry date.');
    if (input.issuedOn && input.expiresOn && input.expiresOn < input.issuedOn) throw refused(422, 'It cannot expire before it was issued.');
    const id = `cdoc_${crypto.randomUUID()}`;
    const title = input.title?.trim() || def.label;
    await this.db.insert(companyDocuments).values({
      id,
      companyId: principal.companyId,
      kind: def.kind,
      title,
      fileId: input.fileId,
      fileName: info.fileName,
      issuedOn: input.issuedOn ?? null,
      expiresOn: input.expiresOn ?? null,
      note: input.note?.trim() || null,
      uploadedBy: this.who(principal),
    });
    await this.audit.write(principal, { action: 'create', entityType: 'company_document', entityId: id, entityLabel: title, summary: `${title} uploaded (${info.fileName})${input.expiresOn ? `, expires ${input.expiresOn}` : ''}`, changes: [{ field: title, old: null, new: info.fileName }] });
    return this.view(principal);
  }

  async voidDocument(principal: Principal, id: string, reason: string): Promise<CompanyProfileView> {
    this.requireEdit(principal);
    const [row] = await this.db.select().from(companyDocuments).where(and(eq(companyDocuments.companyId, principal.companyId), eq(companyDocuments.id, id))).limit(1);
    if (!row) throw refused(404, 'No such company document.');
    if (row.voidedAt) throw refused(422, 'That document is already removed.');
    await this.db.update(companyDocuments).set({ voidedAt: new Date(), voidedBy: this.who(principal), voidReason: reason.trim() }).where(eq(companyDocuments.id, id));
    await this.audit.write(principal, { action: 'void', entityType: 'company_document', entityId: id, entityLabel: row.title, summary: `${row.title} removed: ${reason.trim()}`, reason: reason.trim(), changes: [{ field: row.title, old: row.fileName, new: null }] });
    return this.view(principal);
  }

  /** The broker setup packet: the current W-9, COI, MC authority and NOA, as one ZIP. */
  async packet(principal: Principal): Promise<{ fileName: string; data: Buffer }> {
    const v = await this.view(principal);
    if (!v.packet.ready) throw refused(422, `The broker packet is not ready: ${v.packet.problems.join(' ')}`);
    const entries: Array<{ name: string; data: Buffer }> = [];
    for (const slot of v.documents.filter((s) => s.inPacket && s.current)) {
      const { bytes, info } = await this.files.read(principal.companyId, slot.current!.fileId);
      const ext = (info.fileName.match(/\.[a-z0-9]+$/i)?.[0] ?? '.pdf').toLowerCase();
      entries.push({ name: `${slot.label.replace(/[^\w-]+/g, '_')}${ext}`, data: bytes });
    }
    const p = v.profile;
    const sheet = [
      p.legalName,
      p.dba ? `DBA ${p.dba}` : '',
      [p.mcNumber && `MC ${p.mcNumber}`, p.dotNumber && `DOT ${p.dotNumber}`, p.scac && `SCAC ${p.scac}`].filter(Boolean).join(' · '),
      p.physicalAddress,
      p.mailingAddress && p.mailingAddress !== p.physicalAddress ? `Mailing: ${p.mailingAddress}` : '',
      [p.phone, p.email].filter(Boolean).join(' · '),
      p.factoringCompany ? `Factoring: ${p.factoringCompany}${p.noaReference ? ` (NOA ${p.noaReference})` : ''}` : '',
      p.insuranceAgent ? `Insurance agent: ${[p.insuranceAgent, p.insuranceAgentPhone, p.insuranceAgentEmail].filter(Boolean).join(' · ')}` : '',
    ].filter(Boolean);
    entries.unshift({ name: 'Company_info.txt', data: Buffer.from(`${sheet.join('\r\n')}\r\n`) });
    await this.audit.write(principal, { action: 'export', entityType: 'company_profile', entityId: principal.companyId, entityLabel: p.legalName || 'Company info', summary: `Broker packet downloaded (${entries.length - 1} documents)`, changes: [] });
    const safeName = (p.legalName || 'Company').replace(/[^\w-]+/g, '_');
    return { fileName: `${safeName}_broker_packet.zip`, data: zip(entries) };
  }
}
