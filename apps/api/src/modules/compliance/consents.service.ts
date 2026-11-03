import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  CONSENT_PURPOSE_LABELS,
  CONSENT_TTL_DAYS,
  REQUIREMENT_BY_CONSENT_PURPOSE,
  type ConsentPurpose,
  type ConsentRequest,
  type ConsentStatus,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import {
  complianceDocuments,
  consentEvents,
  consentRequests,
  verificationCases,
  type ConsentRequestRow,
} from '../../database/schema/compliance';
import { drivers } from '../../database/schema/roster';
import { ComplianceAuditService } from './compliance-audit.service';

const DAY_MS = 86_400_000;

/**
 * Consents: one authorization request to one driver for one purpose.
 *
 * A consent is never generic — the purpose is the legal basis for the check it unlocks, so an MVR
 * consent does not cover a background check. Every transition is an appended event.
 *
 * `respond` plays the driver's side. It exists because there is no driver portal yet: in
 * production the driver opens the link and the portal records the view, signature or refusal.
 * Until then the safety desk exercises every branch from the screen, and the response is written
 * with the driver as actor so the trail reads as it will read then.
 */
@Injectable()
export class ConsentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: ComplianceAuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async list(
    principal: Principal,
    query: { driverId?: string; status?: ConsentStatus; purpose?: ConsentPurpose },
  ): Promise<ConsentRequest[]> {
    const parts = [eq(consentRequests.companyId, principal.companyId)];
    if (query.driverId) parts.push(eq(consentRequests.driverId, query.driverId));
    if (query.status) parts.push(eq(consentRequests.status, query.status));
    if (query.purpose) parts.push(eq(consentRequests.purpose, query.purpose));
    const rows = await this.db
      .select()
      .from(consentRequests)
      .where(and(...parts))
      .orderBy(asc(consentRequests.requestedAt), asc(consentRequests.id));
    return this.hydrate(rows);
  }

  /** Consents for one driver, for the verification derivation. */
  async forDriver(companyId: string, driverId: string): Promise<ConsentRequest[]> {
    const rows = await this.db
      .select()
      .from(consentRequests)
      .where(and(eq(consentRequests.companyId, companyId), eq(consentRequests.driverId, driverId)));
    return this.hydrate(rows);
  }

  private async hydrate(rows: ConsentRequestRow[]): Promise<ConsentRequest[]> {
    if (rows.length === 0) return [];
    const events = await this.db
      .select()
      .from(consentEvents)
      .where(
        inArray(
          consentEvents.consentRequestId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(consentEvents.sortOrder));
    return rows.map((row) => ({
      id: row.id,
      driverId: row.driverId,
      driverName: row.driverName,
      purpose: row.purpose as ConsentPurpose,
      requirementCode: row.requirementCode,
      subject: row.subject,
      status: row.status as ConsentStatus,
      requestedAt: row.requestedAt.toISOString(),
      requestedBy: row.requestedBy,
      sentAt: row.sentAt?.toISOString() ?? null,
      viewedAt: row.viewedAt?.toISOString() ?? null,
      signedAt: row.signedAt?.toISOString() ?? null,
      declinedAt: row.declinedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt.toISOString(),
      signerName: row.signerName,
      signerChannel: row.signerChannel as ConsentRequest['signerChannel'],
      signedDocumentId: row.signedDocumentId,
      history: events
        .filter((e) => e.consentRequestId === row.id)
        .map((e) => ({
          at: e.at.toISOString(),
          status: e.status as ConsentStatus,
          actor: e.actor,
          note: e.note,
        })),
    }));
  }

  private async one(principal: Principal, id: string): Promise<ConsentRequest> {
    const [row] = await this.db
      .select()
      .from(consentRequests)
      .where(and(eq(consentRequests.companyId, principal.companyId), eq(consentRequests.id, id)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No consent ${id}` });
    const [hydrated] = await this.hydrate([row]);
    return hydrated as ConsentRequest;
  }

  private async transition(
    consent: ConsentRequest,
    status: ConsentStatus,
    actor: string,
    note: string | null,
    at: Date,
    patch: Partial<typeof consentRequests.$inferInsert> = {},
  ): Promise<void> {
    await this.db
      .update(consentRequests)
      .set({ status, ...patch })
      .where(eq(consentRequests.id, consent.id));
    await this.db.insert(consentEvents).values({
      id: `cev_${crypto.randomUUID()}`,
      consentRequestId: consent.id,
      at,
      status,
      actor,
      note,
      sortOrder: consent.history.length + 1,
    });
  }

  /** Drafts a new consent request; nothing reaches the driver until `send`. */
  /**
   * The name the file knows a driver by: the roster row when there is one, else the verification
   * case — a candidate has a qualification file before they have a roster record.
   */
  private async driverName(companyId: string, driverId: string): Promise<string | null> {
    const [driver] = await this.db
      .select({ first: drivers.firstName, last: drivers.lastName })
      .from(drivers)
      .where(and(eq(drivers.companyId, companyId), eq(drivers.id, driverId)))
      .limit(1);
    if (driver) return `${driver.first} ${driver.last}`;
    const [vc] = await this.db
      .select({ name: verificationCases.driverName })
      .from(verificationCases)
      .where(
        and(eq(verificationCases.companyId, companyId), eq(verificationCases.driverId, driverId)),
      )
      .limit(1);
    return vc?.name ?? null;
  }

  async create(
    principal: Principal,
    input: { driverId: string; purpose: ConsentPurpose; subject?: string | null; at?: Date },
  ): Promise<ConsentRequest> {
    const name = await this.driverName(principal.companyId, input.driverId);
    const at = input.at ?? new Date();
    const by = principal.userName ?? principal.userId;
    const id = `cns_${crypto.randomUUID()}`;
    await this.db.insert(consentRequests).values({
      id,
      companyId: principal.companyId,
      driverId: input.driverId,
      driverName: name ?? input.driverId,
      purpose: input.purpose,
      requirementCode: REQUIREMENT_BY_CONSENT_PURPOSE[input.purpose],
      subject: input.subject ?? null,
      status: 'draft',
      requestedAt: at,
      requestedBy: by,
      expiresAt: new Date(at.getTime() + CONSENT_TTL_DAYS * DAY_MS),
    });
    await this.db.insert(consentEvents).values({
      id: `cev_${crypto.randomUUID()}`,
      consentRequestId: id,
      at,
      status: 'draft',
      actor: by,
      note: null,
      sortOrder: 1,
    });
    return this.one(principal, id);
  }

  /**
   * Sends a draft to the driver, or re-sends one that was sent, viewed or has expired. A re-send
   * starts a fresh 14-day window; a signed, declined or cancelled request cannot be sent again.
   */
  async send(
    principal: Principal,
    id: string,
    options: { at?: Date } = {},
  ): Promise<ConsentRequest> {
    const consent = await this.one(principal, id);
    const before = consent.status;
    if (before === 'signed' || before === 'declined' || before === 'cancelled') return consent;
    const at = options.at ?? new Date();
    const by = principal.userName ?? principal.userId;
    const resend = before !== 'draft';
    await this.transition(consent, 'sent', by, resend ? 'Re-sent with a new link' : null, at, {
      sentAt: at,
      viewedAt: null,
      expiresAt: new Date(at.getTime() + CONSENT_TTL_DAYS * DAY_MS),
    });
    await this.audit.write(principal, {
      action: 'consent_sent',
      entity: { type: 'driver', id: consent.driverId, label: consent.driverName },
      subject: consent.requirementCode,
      before,
      after: 'sent',
      reason: resend ? 'Re-sent' : null,
      at,
    });
    return this.one(principal, id);
  }

  async cancel(principal: Principal, id: string): Promise<ConsentRequest> {
    const consent = await this.one(principal, id);
    if (consent.status === 'cancelled' || consent.status === 'signed') return consent;
    await this.transition(
      consent,
      'cancelled',
      principal.userName ?? principal.userId,
      null,
      new Date(),
    );
    return this.one(principal, id);
  }

  /** The driver's side, until a portal records it. Signing files the authorization as a document. */
  async respond(
    principal: Principal,
    id: string,
    input: { outcome: 'viewed' | 'signed' | 'declined'; signerName?: string },
    options: { at?: Date } = {},
  ): Promise<ConsentRequest> {
    const consent = await this.one(principal, id);
    const before = consent.status;
    if (before !== 'sent' && before !== 'viewed') return consent;
    const at = options.at ?? new Date();
    const signer = input.signerName ?? consent.driverName;
    const driverActor = { id: consent.driverId, name: consent.driverName };

    if (input.outcome === 'viewed') {
      if (before === 'viewed') return consent;
      await this.transition(consent, 'viewed', consent.driverName, null, at, { viewedAt: at });
      return this.one(principal, id);
    }

    const viewedAt = consent.viewedAt ? new Date(consent.viewedAt) : at;
    if (input.outcome === 'declined') {
      await this.transition(consent, 'declined', signer, 'Declined from the driver portal', at, {
        viewedAt,
        declinedAt: at,
      });
      await this.audit.write(principal, {
        action: 'consent_declined',
        entity: { type: 'driver', id: consent.driverId, label: consent.driverName },
        subject: consent.requirementCode,
        before,
        after: 'declined',
        reason: null,
        actor: driverActor,
        at,
      });
      return this.one(principal, id);
    }

    const [driver] = await this.db
      .select({ number: drivers.driverNumber })
      .from(drivers)
      .where(eq(drivers.id, consent.driverId))
      .limit(1);
    const documentId = `doc_${crypto.randomUUID()}`;
    await this.db.insert(complianceDocuments).values({
      id: documentId,
      companyId: principal.companyId,
      ownerType: 'driver',
      ownerId: consent.driverId,
      ownerLabel: consent.driverName,
      requirementCode: consent.requirementCode,
      title: `${CONSENT_PURPOSE_LABELS[consent.purpose]} consent`,
      fileName: `consent-${consent.purpose.replace(/_/g, '-')}-${driver?.number ?? consent.driverId}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 48_000 + consent.history.length * 1_024,
      issuedOn: at.toISOString().slice(0, 10),
      expiresOn: null,
      status: 'verified',
      source: 'driver_portal',
      uploadedAt: at,
      uploadedBy: 'Driver portal',
      verifiedAt: at,
      verifiedBy: 'Driver portal (e-signature)',
      version: 1,
      containsPii: false,
    });
    await this.transition(consent, 'signed', signer, null, at, {
      viewedAt,
      signedAt: at,
      signerName: signer,
      signerChannel: 'driver_portal',
      signedDocumentId: documentId,
    });
    await this.audit.write(principal, {
      action: 'consent_signed',
      entity: { type: 'driver', id: consent.driverId, label: consent.driverName },
      subject: consent.requirementCode,
      before,
      after: 'signed',
      reason: null,
      actor: { id: consent.driverId, name: signer },
      at,
    });
    return this.one(principal, id);
  }
}
