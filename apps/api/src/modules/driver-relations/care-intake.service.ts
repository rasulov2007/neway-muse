import { createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { and, count, desc, eq, gte, ne, sql } from 'drizzle-orm';
import {
  COMPLIANCE_SUBJECT_LABELS,
  DRIVER_CARE_MAX_BODY_BYTES,
  DRIVER_CARE_SLUG_PATTERN,
  DRIVER_RELATION_TOPIC_LABELS,
  DriverCareSubmissionSchema,
  MANAGEMENT_CALL_TOPIC_LABELS,
  isConfidentialSubmission,
  normalizeApplyPhone,
  phoneMatchKey,
  splitFullName,
  type DriverCareConfig,
  type DriverCareReceipt,
  type DriverCareSubmission,
  type DriverRelationPayload,
} from '@neway/shared';
import { weekStartIndex } from '../../common/auth/demo-principal.middleware';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { env } from '../../config/env';
import type { Transaction } from '../../database/client';
import { DocumentStorageService } from '../../common/storage/document-storage.service';
import { DatabaseService } from '../../database/database.service';
import {
  driverCareLinks,
  driverRelationAttachments,
  driverCareSubmissions,
  driverRelationActivities,
  driverRelationOutbox,
  driverRelationRequests,
} from '../../database/schema/driver-relations';
import { hiringLeads } from '../../database/schema/hiring';
import { companies } from '../../database/schema/roster';
import { LeadsService } from '../hiring/leads.service';
import { nextNumber, retryOnDuplicate } from '../hr/hr.util';
import { AuditService } from '../people/audit.service';
import { decodeReceipts, extensionFor, type Receipt } from './receipts';

export interface CareRequestMeta {
  ip: string;
  userAgent: string | null;
}

const PER_ADDRESS_PER_HOUR = 30;
const PER_PHONE_PER_DAY = 10;
/** A second message from the same driver on the same topic within this window joins the thread. */
const THREAD_WINDOW_DAYS = 30;

const pipe = new ZodValidationPipe(DriverCareSubmissionSchema);
const NOT_ACTIVE =
  'This Driver Care link is not active. Please call your dispatcher or the office.';

function fieldError(path: string, message: string): AppError {
  return new AppError({
    status: 422,
    title: 'Unprocessable Entity',
    detail: `${path}: ${message}`,
    extensions: { errors: [{ path, message, code: 'custom' }] },
  });
}

interface Shaped {
  submittedName: string;
  truckSnapshot: string;
  contactPhone: string | null;
  description: string;
  payload: DriverRelationPayload;
  referral: { firstName: string; lastName: string; phone: string; fullName: string } | null;
}

/**
 * The public side of Driver Relations: the NORTHWIND FREIGHT Driver Care page posts here.
 *
 * In the order a submission meets them (the same order as the driver application):
 *   1. An in-memory limit per address, before anything is parsed, and a size cap on the body.
 *   2. Validation (422 per field), then the link's slug decides the company (404 if unknown/off).
 *   3. The honeypot: a bot is told "received" and nothing is written.
 *   4. The submission key: a retry of a saved form answers with the same reference, writes nothing.
 *   5. Durable limits per hashed address and per phone, in the database.
 *   6. One transaction, serialized per company: a new request (or a new message on the driver's
 *      open request for the same topic), its activity line, its outbox row, the submission row,
 *      and — for a referral — the HR lead it creates or joins. "Received" is answered only after
 *      the commit.
 */
@Injectable()
export class CareIntakeService {
  private readonly logger = new Logger(CareIntakeService.name);
  private readonly configLimiter = new RateLimiter(60, 60_000);
  private readonly submitLimiter = new RateLimiter(15, 10 * 60_000);

  constructor(
    private readonly database: DatabaseService,
    private readonly leads: LeadsService,
    private readonly audit: AuditService,
    private readonly storage: DocumentStorageService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private async activeLink(slug: string) {
    if (!DRIVER_CARE_SLUG_PATTERN.test(slug)) {
      throw new AppError({ status: 404, title: 'Not Found', detail: NOT_ACTIVE });
    }
    const [row] = await this.db
      .select({
        link: driverCareLinks,
        companyName: companies.name,
        timezone: companies.timezone,
        weekStart: companies.weekStart,
      })
      .from(driverCareLinks)
      .innerJoin(companies, eq(companies.id, driverCareLinks.companyId))
      .where(and(eq(driverCareLinks.slug, slug), eq(driverCareLinks.active, true)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: NOT_ACTIVE });
    return row;
  }

  async publicConfig(slug: string, meta: CareRequestMeta): Promise<DriverCareConfig> {
    this.configLimiter.hit(`config:${meta.ip}`);
    const { companyName } = await this.activeLink(slug);
    return { companyName, displayName: companyName };
  }

  private addressHash(ip: string): string {
    return createHmac('sha256', env.APP_SECRET).update(`care:${ip}`).digest('hex').slice(0, 32);
  }

  private shape(body: DriverCareSubmission): Shaped {
    const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
    const phoneOf = (raw: string, path: string) => {
      const result = normalizeApplyPhone(raw);
      if (!result.ok) throw fieldError(path, result.message);
      return result.e164;
    };
    const base = { submittedName: clean(body.name), truckSnapshot: clean(body.truckNumber) };
    switch (body.topic) {
      case 'referral': {
        const phone = phoneOf(body.referralPhone, 'referralPhone');
        const fullName = clean(body.referralName);
        const { firstName, lastName } = splitFullName(fullName);
        return {
          ...base,
          contactPhone: null,
          description: `Referral: ${fullName}, phone ${phone}.`,
          payload: { referralName: fullName, referralPhone: phone },
          referral: { firstName, lastName, phone, fullName },
        };
      }
      case 'complaint_feedback':
        return {
          ...base,
          contactPhone: phoneOf(body.phone, 'phone'),
          description: body.details,
          payload: {},
          referral: null,
        };
      case 'reimbursement':
        return {
          ...base,
          contactPhone: phoneOf(body.phone, 'phone'),
          description: body.details,
          payload: {
            amount: Math.round(body.amount * 100) / 100,
            loadNumber: body.loadNumber,
          },
          referral: null,
        };
      case 'pay_statement':
        return {
          ...base,
          contactPhone: phoneOf(body.phone, 'phone'),
          description: body.details,
          payload: { weekStart: body.weekStart, loadNumber: body.loadNumber },
          referral: null,
        };
      case 'compliance':
        return {
          ...base,
          contactPhone: phoneOf(body.phone, 'phone'),
          description: body.details,
          payload: { subject: body.subject, subjectLabel: COMPLIANCE_SUBJECT_LABELS[body.subject] },
          referral: null,
        };
      case 'management_call':
        return {
          ...base,
          contactPhone: phoneOf(body.phone, 'phone'),
          description: body.details,
          // A request for a call, never a booking: the time is what the driver asked for.
          payload: {
            callTopic: body.callTopic,
            callTopicLabel: MANAGEMENT_CALL_TOPIC_LABELS[body.callTopic],
            preferredTime: body.preferredTime,
          },
          referral: null,
        };
    }
  }

  async submit(slug: string, raw: unknown, meta: CareRequestMeta): Promise<DriverCareReceipt> {
    this.submitLimiter.hit(`submit:${meta.ip}`);
    // The text is capped on its own; receipts are measured after decoding (receipts.ts).
    const textOnly =
      raw && typeof raw === 'object'
        ? { ...(raw as Record<string, unknown>), attachments: undefined }
        : raw;
    if (JSON.stringify(textOnly ?? null).length > DRIVER_CARE_MAX_BODY_BYTES) {
      throw new AppError({
        status: 413,
        title: 'Payload Too Large',
        detail: 'That message is too long. Please shorten it.',
      });
    }
    const body = pipe.transform(raw);
    const { link, timezone, weekStart } = await this.activeLink(slug);

    if (body.website.trim() !== '') {
      this.logger.warn(`driver care: honeypot filled on link ${link.slug}; nothing saved`);
      return { status: 'received', reference: null };
    }

    const shaped = this.shape(body);
    const receipts: Receipt[] =
      body.topic === 'reimbursement' ? decodeReceipts(body.attachments) : [];
    const confidential = isConfidentialSubmission(body);
    const companyId = link.companyId;
    const phoneKey = shaped.contactPhone
      ? phoneMatchKey(shaped.contactPhone)
      : shaped.referral
        ? phoneMatchKey(shaped.referral.phone)
        : null;
    const ipHash = this.addressHash(meta.ip);

    const replay = await this.savedReference(companyId, body.submissionId);
    if (replay !== null) return { status: 'received', reference: replay };
    await this.enforceLimits(companyId, ipHash, phoneKey);

    const staged = await this.stage(companyId, receipts);
    let committed = false;

    const outcome = await this.saving(link.slug, async () => {
      try {
        const result = await retryOnDuplicate(() =>
          this.db.transaction(async (tx) => {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtext(${`driver-care:${companyId}`}))`,
            );
            const [again] = await tx
              .select({ number: driverRelationRequests.requestNumber })
              .from(driverCareSubmissions)
              .innerJoin(
                driverRelationRequests,
                eq(driverRelationRequests.id, driverCareSubmissions.requestId),
              )
              .where(
                and(
                  eq(driverCareSubmissions.companyId, companyId),
                  eq(driverCareSubmissions.submissionKey, body.submissionId),
                ),
              )
              .limit(1);
            if (again) return { reference: again.number, audit: null };

            const at = new Date();
            const thread = shaped.contactPhone
              ? await this.openThread(tx, companyId, body.topic, phoneKey!, shaped.submittedName)
              : null;
            if (thread) {
              const version = thread.version + 1;
              await tx
                .update(driverRelationRequests)
                .set({ needsContact: true, lastDriverMessageAt: at, version, updatedAt: at })
                .where(
                  and(
                    eq(driverRelationRequests.companyId, companyId),
                    eq(driverRelationRequests.id, thread.id),
                  ),
                );
              const activityId = `dra_${crypto.randomUUID()}`;
              await tx.insert(driverRelationActivities).values({
                id: activityId,
                companyId,
                requestId: thread.id,
                type: 'driver_message',
                actorType: 'driver',
                actorId: `driver_care:${link.id}`,
                actorName: `${shaped.submittedName} (Driver Care)`,
                note: shaped.description,
                detail: { payload: shaped.payload, truck: shaped.truckSnapshot },
                requestVersion: version,
                eventKey: body.submissionId,
                at,
              });
              await this.enqueue(tx, companyId, thread.id, activityId, 'driver_message');
              await this.attach(tx, companyId, thread.id, activityId, staged);
              await tx.insert(driverCareSubmissions).values({
                id: `dcs_${crypto.randomUUID()}`,
                companyId,
                careLinkId: link.id,
                submissionKey: body.submissionId,
                requestId: thread.id,
                outcome: 'thread_message',
                topic: body.topic,
                phoneKey,
                ipHash,
                userAgent: meta.userAgent?.slice(0, 300) ?? null,
                receivedAt: at,
              });
              return {
                reference: thread.requestNumber,
                audit: {
                  requestId: thread.id,
                  number: thread.requestNumber,
                  thread: true,
                  lead: null,
                },
              };
            }

            const requestNumber = await nextNumber(
              tx,
              driverRelationRequests,
              driverRelationRequests.requestNumber,
              driverRelationRequests.companyId,
              companyId,
              'DR',
              1000,
            );
            const requestId = `drr_${crypto.randomUUID()}`;
            const lead = shaped.referral
              ? await this.referralLead(tx, companyId, shaped, requestNumber, at)
              : null;
            await tx.insert(driverRelationRequests).values({
              id: requestId,
              companyId,
              requestNumber,
              topic: body.topic,
              source: 'driver_care',
              careLinkId: link.id,
              submittedName: shaped.submittedName,
              truckSnapshot: shaped.truckSnapshot,
              contactPhone: shaped.contactPhone,
              phoneKey,
              description: shaped.description,
              payload: shaped.payload,
              status: 'new',
              needsContact: true,
              confidential,
              receivedAt: at,
              lastDriverMessageAt: at,
              hrLeadId: lead?.id ?? null,
              version: 1,
              idempotencyKey: body.submissionId,
              createdAt: at,
              updatedAt: at,
            });
            const activityId = `dra_${crypto.randomUUID()}`;
            await tx.insert(driverRelationActivities).values({
              id: activityId,
              companyId,
              requestId,
              type: 'received',
              actorType: 'driver',
              actorId: `driver_care:${link.id}`,
              actorName: `${shaped.submittedName} (Driver Care)`,
              note: shaped.description,
              detail: { link: link.slug },
              requestVersion: 1,
              eventKey: body.submissionId,
              at,
            });
            if (lead) {
              await tx.insert(driverRelationActivities).values({
                id: `dra_${crypto.randomUUID()}`,
                companyId,
                requestId,
                type: 'linked',
                actorType: 'system',
                actorId: 'system:driver-care',
                actorName: 'Driver Care',
                note: lead.created
                  ? `HR lead ${lead.number} created in Recruiting (source: driver referral).`
                  : `Linked to HR lead ${lead.number}, already on file for this phone number.`,
                detail: { hrLeadId: lead.id, leadNumber: lead.number, created: lead.created },
                requestVersion: 1,
                at,
              });
            }
            await this.enqueue(tx, companyId, requestId, activityId, 'received');
            await tx.insert(driverCareSubmissions).values({
              id: `dcs_${crypto.randomUUID()}`,
              companyId,
              careLinkId: link.id,
              submissionKey: body.submissionId,
              requestId,
              outcome: 'new_request',
              topic: body.topic,
              phoneKey,
              ipHash,
              userAgent: meta.userAgent?.slice(0, 300) ?? null,
              receivedAt: at,
            });
            await this.attach(tx, companyId, requestId, activityId, staged);
            return {
              reference: requestNumber,
              audit: { requestId, number: requestNumber, thread: false, lead },
            };
          }),
        );
        committed = result.audit !== null;
        return result;
      } finally {
        if (!committed) await this.unstage(staged);
      }
    });

    if (outcome.audit) {
      await this.recordAudit(
        this.systemPrincipal(companyId, timezone, weekStart),
        link,
        body.topic,
        shaped,
        outcome.audit,
      ).catch((error: unknown) => {
        this.logger.error(
          `driver care: ${outcome.reference} saved but its audit entry failed: ${String(error)}`,
        );
      });
    }
    return { status: 'received', reference: outcome.reference };
  }

  /**
   * A request from the driver app (mobile M3). The same request, activity, outbox and attachment
   * rows as a Driver Care submission, but the driver is the signed-in one - resolved on the server,
   * so the request carries the roster driver and truck from the start (no typed name to verify) -
   * and it is routed to the team that answers its topic. A referral creates or joins the HR lead
   * exactly as the public form does, remembering which driver referred them. `key` (the phone's
   * Idempotency-Key, scoped to the account) makes a retry land on the first request.
   */
  async submitFromDriver(
    principal: Principal,
    input: {
      key: string;
      driver: { id: string; name: string; phone: string | null; truckId: string | null; truckNumber: string | null };
      topic: DriverCareSubmission['topic'];
      description: string;
      payload: DriverRelationPayload;
      confidential: boolean;
      team: string;
      referral: { fullName: string; phone: string; note: string | null } | null;
      files: Receipt[];
    },
  ): Promise<{ requestId: string; number: string; created: boolean; lead: { id: string; number: string; created: boolean } | null }> {
    const companyId = principal.companyId;
    const key = `driver_app:${input.key}`;
    const existing = await this.db
      .select({ id: driverRelationRequests.id, number: driverRelationRequests.requestNumber, hrLeadId: driverRelationRequests.hrLeadId })
      .from(driverRelationRequests)
      .where(and(eq(driverRelationRequests.companyId, companyId), eq(driverRelationRequests.idempotencyKey, key)))
      .limit(1);
    if (existing[0]) return { requestId: existing[0].id, number: existing[0].number, created: false, lead: null };

    let referral: { firstName: string; lastName: string; phone: string; fullName: string } | null = null;
    if (input.referral) {
      const phone = normalizeApplyPhone(input.referral.phone);
      if (!phone.ok) throw fieldError('phone', phone.message);
      const { firstName, lastName } = splitFullName(input.referral.fullName);
      referral = { firstName, lastName, phone: phone.e164, fullName: input.referral.fullName.replace(/\s+/g, ' ').trim() };
    }
    const shaped: Shaped = {
      submittedName: input.driver.name,
      truckSnapshot: input.driver.truckNumber ?? '',
      contactPhone: referral ? null : input.driver.phone,
      description: referral ? `Referral: ${referral.fullName}, phone ${referral.phone}.${input.referral?.note ? ` ${input.referral.note}` : ''}` : input.description,
      payload: referral ? { ...input.payload, referralName: referral.fullName, referralPhone: referral.phone } : input.payload,
      referral,
    };
    const phoneKey = referral ? phoneMatchKey(referral.phone) : input.driver.phone ? phoneMatchKey(input.driver.phone) : null;
    const staged = await this.stage(companyId, input.files);
    let committed = false;
    try {
      const result = await retryOnDuplicate(() =>
        this.db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`driver-care:${companyId}`}))`);
          const [again] = await tx
            .select({ id: driverRelationRequests.id, number: driverRelationRequests.requestNumber })
            .from(driverRelationRequests)
            .where(and(eq(driverRelationRequests.companyId, companyId), eq(driverRelationRequests.idempotencyKey, key)))
            .limit(1);
          if (again) return { requestId: again.id, number: again.number, created: false, lead: null };
          const at = new Date();
          const requestNumber = await nextNumber(tx, driverRelationRequests, driverRelationRequests.requestNumber, driverRelationRequests.companyId, companyId, 'DR', 1000);
          const requestId = `drr_${crypto.randomUUID()}`;
          const lead = referral ? await this.referralLead(tx, companyId, shaped, requestNumber, at, input.driver.id) : null;
          await tx.insert(driverRelationRequests).values({
            id: requestId,
            companyId,
            requestNumber,
            topic: input.topic,
            source: 'driver_app',
            careLinkId: null,
            // Signed in, resolved on the server: the identity is the account's, not a typed name.
            driverId: input.driver.id,
            truckId: input.driver.truckId,
            verifiedBy: 'Driver app sign-in',
            verifiedAt: at,
            submittedName: shaped.submittedName,
            truckSnapshot: shaped.truckSnapshot || null,
            contactPhone: shaped.contactPhone,
            phoneKey,
            description: shaped.description,
            payload: shaped.payload,
            status: 'new',
            needsContact: true,
            confidential: input.confidential,
            assignedTeam: input.team,
            receivedAt: at,
            lastDriverMessageAt: at,
            hrLeadId: lead?.id ?? null,
            version: 1,
            idempotencyKey: key,
            createdAt: at,
            updatedAt: at,
          });
          const activityId = `dra_${crypto.randomUUID()}`;
          await tx.insert(driverRelationActivities).values({
            id: activityId,
            companyId,
            requestId,
            type: 'received',
            actorType: 'driver',
            actorId: `driver:${input.driver.id}`,
            actorName: `${input.driver.name} (driver app)`,
            note: shaped.description,
            detail: { source: 'driver_app', team: input.team },
            requestVersion: 1,
            eventKey: key,
            at,
          });
          if (lead) {
            await tx.insert(driverRelationActivities).values({
              id: `dra_${crypto.randomUUID()}`,
              companyId,
              requestId,
              type: 'linked',
              actorType: 'system',
              actorId: 'system:driver-app',
              actorName: 'Driver app',
              note: lead.created ? `HR lead ${lead.number} created in Recruiting (source: driver referral).` : `Linked to HR lead ${lead.number}, already on file for this phone number.`,
              detail: { hrLeadId: lead.id, leadNumber: lead.number, created: lead.created },
              requestVersion: 1,
              at,
            });
          }
          await this.enqueue(tx, companyId, requestId, activityId, 'received');
          await this.attach(tx, companyId, requestId, activityId, staged);
          return { requestId, number: requestNumber, created: true, lead };
        }),
      );
      committed = result.created;
      if (result.created) {
        const actor = { id: `driver:${input.driver.id}`, name: `${input.driver.name} (driver app)` };
        await this.audit
          .write(principal, {
            action: 'create',
            actor,
            entityType: 'driver_relation_request',
            entityId: result.requestId,
            entityLabel: `${result.number} · ${input.driver.name}`,
            summary: `${DRIVER_RELATION_TOPIC_LABELS[input.topic]} received from the driver app (team: ${input.team})`,
          })
          .catch((error: unknown) => this.logger.error(`driver app: ${result.number} saved but its audit entry failed: ${String(error)}`));
        if (result.lead?.created) {
          await this.audit
            .write(principal, {
              action: 'create',
              actor,
              entityType: 'lead',
              entityId: result.lead.id,
              entityLabel: referral!.fullName,
              summary: `Lead added from a driver referral (Driver Relations ${result.number}, driver app)`,
              changes: [
                { field: 'source', old: null, new: 'referral' },
                { field: 'channel', old: null, new: 'driver_app' },
              ],
            })
            .catch(() => undefined);
        }
      }
      return result;
    } finally {
      if (!committed) await this.unstage(staged);
    }
  }

  /**
   * Receipt bytes go to private storage before the transaction, under keys only this request's
   * rows will name; if the transaction does not commit them (a replay, a failure) they are removed.
   */
  private async stage(companyId: string, receipts: Receipt[]) {
    const staged: (Receipt & { id: string; key: string })[] = [];
    try {
      for (const receipt of receipts) {
        const id = `dra_file_${crypto.randomUUID()}`;
        const key = `driver-relations/${companyId}/${id}${extensionFor(receipt.contentType)}`;
        await this.storage.put(key, receipt.bytes);
        staged.push({ ...receipt, id, key });
      }
    } catch (error) {
      await this.unstage(staged);
      throw error;
    }
    return staged;
  }

  private async unstage(staged: { key: string }[]) {
    for (const file of staged) await this.storage.remove(file.key).catch(() => undefined);
  }

  private async attach(
    tx: Transaction,
    companyId: string,
    requestId: string,
    activityId: string,
    staged: (Receipt & { id: string; key: string })[],
  ) {
    for (const file of staged) {
      await tx.insert(driverRelationAttachments).values({
        id: file.id,
        companyId,
        requestId,
        activityId,
        originalFileName: file.fileName,
        contentType: file.contentType,
        sizeBytes: file.bytes.length,
        sha256: file.sha256,
        storageKey: file.key,
      });
    }
  }

  /** The driver's open request on this topic: same phone and same name, not resolved, recent. */
  private async openThread(
    tx: Transaction,
    companyId: string,
    topic: string,
    phoneKey: string,
    name: string,
  ) {
    const since = new Date(Date.now() - THREAD_WINDOW_DAYS * 24 * 60 * 60_000);
    const [row] = await tx
      .select({
        id: driverRelationRequests.id,
        requestNumber: driverRelationRequests.requestNumber,
        version: driverRelationRequests.version,
      })
      .from(driverRelationRequests)
      .where(
        and(
          eq(driverRelationRequests.companyId, companyId),
          eq(driverRelationRequests.topic, topic),
          eq(driverRelationRequests.phoneKey, phoneKey),
          ne(driverRelationRequests.status, 'resolved'),
          // A new message never joins a hidden test request.
          eq(driverRelationRequests.isTest, false),
          gte(driverRelationRequests.lastDriverMessageAt, since),
          sql`lower(${driverRelationRequests.submittedName}) = lower(${name})`,
        ),
      )
      .orderBy(desc(driverRelationRequests.receivedAt))
      .for('update')
      .limit(1);
    return row ?? null;
  }

  /**
   * HR → Recruiting → Leads is where a referred driver belongs: one lead, source "referral". A
   * number already on an open lead joins that lead (its stage, notes and history untouched);
   * otherwise a new lead is created, unassigned, exactly as the online application does.
   */
  private async referralLead(
    tx: Transaction,
    companyId: string,
    shaped: Shaped,
    requestNumber: string,
    at: Date,
    referredByDriverId: string | null = null,
  ) {
    const ref = shaped.referral!;
    const existing = await this.leads.findOpenLeadByPhone(tx, companyId, ref.phone);
    if (existing) return { id: existing.id, number: existing.number, created: false };
    const number = await nextNumber(
      tx,
      hiringLeads,
      hiringLeads.leadNumber,
      hiringLeads.companyId,
      companyId,
      'LEAD',
      1000,
    );
    const id = `lead_${crypto.randomUUID()}`;
    await tx.insert(hiringLeads).values({
      id,
      companyId,
      leadNumber: number,
      firstName: ref.firstName,
      lastName: ref.lastName,
      phone: ref.phone,
      email: null,
      cdlClass: null,
      state: null,
      yearsExperience: null,
      source: 'referral',
      campaignId: null,
      recruiterEmployeeId: null,
      notes: `Referred by ${shaped.submittedName} (truck ${shaped.truckSnapshot || 'n/a'}) through ${referredByDriverId ? 'the driver app' : 'Driver Care'}, request ${requestNumber}.`,
      referredByDriverId,
      status: 'new',
      createdAt: at,
      updatedAt: at,
    });
    return { id, number, created: true };
  }

  private async enqueue(
    tx: Transaction,
    companyId: string,
    requestId: string,
    eventId: string,
    eventType: string,
  ) {
    // Written with the request, sent after commit by the worker; while Telegram is not connected
    // it stays pending and nothing leaves the server.
    await tx
      .insert(driverRelationOutbox)
      .values({
        id: `dro_${crypto.randomUUID()}`,
        companyId,
        requestId,
        eventId,
        eventType,
        adapter: 'telegram',
        status: 'pending',
      })
      .onConflictDoNothing();
  }

  private async savedReference(companyId: string, key: string): Promise<string | null> {
    const [row] = await this.db
      .select({ number: driverRelationRequests.requestNumber })
      .from(driverCareSubmissions)
      .innerJoin(
        driverRelationRequests,
        eq(driverRelationRequests.id, driverCareSubmissions.requestId),
      )
      .where(
        and(
          eq(driverCareSubmissions.companyId, companyId),
          eq(driverCareSubmissions.submissionKey, key),
        ),
      )
      .limit(1);
    return row?.number ?? null;
  }

  private async enforceLimits(companyId: string, ipHash: string, phoneKey: string | null) {
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    const [byAddress] = await this.db
      .select({ value: count() })
      .from(driverCareSubmissions)
      .where(
        and(
          eq(driverCareSubmissions.ipHash, ipHash),
          gte(driverCareSubmissions.receivedAt, hourAgo),
        ),
      );
    if ((byAddress?.value ?? 0) >= PER_ADDRESS_PER_HOUR) {
      throw new AppError({
        status: 429,
        title: 'Too Many Requests',
        detail:
          'Too many messages from this connection. Please try again later or call the office.',
        extensions: { retryAfter: 3600 },
      });
    }
    if (!phoneKey) return;
    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);
    const [byPhone] = await this.db
      .select({ value: count() })
      .from(driverCareSubmissions)
      .where(
        and(
          eq(driverCareSubmissions.companyId, companyId),
          eq(driverCareSubmissions.phoneKey, phoneKey),
          gte(driverCareSubmissions.receivedAt, dayAgo),
        ),
      );
    if ((byPhone?.value ?? 0) >= PER_PHONE_PER_DAY) {
      throw new AppError({
        status: 429,
        title: 'Too Many Requests',
        detail:
          'We already have several messages from this phone number today. The team will contact you.',
        extensions: { retryAfter: 24 * 3600 },
      });
    }
  }

  /** A database failure is logged by its code alone: its parameters are the driver's words. */
  private async saving<T>(slug: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AppError) throw error;
      const code =
        (error as { code?: string }).code ??
        (error as { cause?: { code?: string } }).cause?.code ??
        'unknown';
      this.logger.error(`driver care: saving a request on link ${slug} failed (code ${code})`);
      throw new AppError({
        status: 503,
        title: 'Service Unavailable',
        detail: 'Your message could not be saved just now. Please try again.',
      });
    }
  }

  private systemPrincipal(companyId: string, timezone: string, weekStart: string): Principal {
    return {
      userId: 'system:driver-care',
      userName: 'Driver Care',
      companyId,
      companyTimezone: timezone,
      weekStart: weekStartIndex(weekStart),
      roles: [],
      permissions: new Set(),
    };
  }

  private async recordAudit(
    principal: Principal,
    link: { id: string; slug: string; name: string },
    topic: DriverCareSubmission['topic'],
    shaped: Shaped,
    saved: {
      requestId: string;
      number: string;
      thread: boolean;
      lead: { id: string; number: string; created: boolean } | null;
    },
  ) {
    const actor = { id: `driver_care:${link.id}`, name: `Driver Care · ${link.name}` };
    await this.audit.write(principal, {
      action: saved.thread ? 'driver_message' : 'create',
      actorType: 'system',
      actor,
      entityType: 'driver_relation_request',
      entityId: saved.requestId,
      entityLabel: `${saved.number} · ${shaped.submittedName}`,
      summary: saved.thread
        ? `New message from the driver through Driver Care; needs contact`
        : `${DRIVER_RELATION_TOPIC_LABELS[topic]} received through Driver Care (/care/${link.slug})`,
    });
    if (saved.lead?.created) {
      await this.audit.write(principal, {
        action: 'create',
        actorType: 'system',
        actor,
        entityType: 'lead',
        entityId: saved.lead.id,
        entityLabel: shaped.referral!.fullName,
        summary: `Lead added from a driver referral (Driver Relations ${saved.number})`,
        changes: [
          { field: 'source', old: null, new: 'referral' },
          { field: 'channel', old: null, new: 'driver_care' },
        ],
      });
    }
  }
}
