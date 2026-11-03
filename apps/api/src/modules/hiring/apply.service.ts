import { createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { and, count, desc, eq, gte, max, sql } from 'drizzle-orm';
import {
  APPLY_LINK_SLUG_PATTERN,
  PublicApplicationSchema,
  normalizeApplyPhone,
  phoneMatchKey,
  sourceFromAttribution,
  splitFullName,
  type ApplicationAnswers,
  type ApplyLink,
  type CreateApplyLinkInput,
  type PublicApplication,
  type PublicApplicationReceipt,
  type PublicApplyConfig,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { LeadTelegramNotifier } from './lead-telegram';
import {
  hiringApplyLinks,
  hiringCampaigns,
  hiringLeadApplications,
  hiringLeads,
  type HiringApplyLinkRow,
} from '../../database/schema/hiring';
import { employees } from '../../database/schema/people';
import { companies } from '../../database/schema/roster';
import { weekStartIndex } from '../../common/auth/demo-principal.middleware';
import { nextNumber, retryOnDuplicate } from '../hr/hr.util';
import { AuditService } from '../people/audit.service';
import { LeadRotationService } from './lead-rotation.service';
import { SmsPreferencesService } from './sms-preferences.service';
import { LeadsService } from './leads.service';

/** Who the request came from, as far as rate limiting needs to know. Never stored raw. */
export interface RequestMeta {
  ip: string;
  userAgent: string | null;
}

/** Durable limits, enforced in the database so they hold across restarts and instances. */
const PER_ADDRESS_PER_HOUR = 20;
const PER_PHONE_PER_DAY = 5;

const applicationPipe = new ZodValidationPipe(PublicApplicationSchema);

const NOT_ACTIVE = 'This application link is not active. Please contact the company directly.';

/**
 * The public driver application and the links it is reached through.
 *
 * The rules, in the order a submission meets them:
 *
 *   1. The link decides the company. The slug is looked up on the server; an unknown or switched
 *      off link is a 404 that says nothing about any company.
 *   2. The honeypot. A filled `website` field is a bot: it is told "received" (so it does not
 *      learn to retry differently) and nothing is written.
 *   3. Normalization with the shared utilities, so the stored phone is E.164 and the email is
 *      lower-case — the same forms the duplicate rule compares.
 *   4. The submission key. A key already on file is the same submission arriving again (a double
 *      tap, a retry after a dropped connection) and answers "received" without writing.
 *   5. Durable limits per hashed address and per phone number.
 *   6. One transaction, serialized per company: the duplicate-candidate rule decides whether this
 *      is a new lead or an application joining an existing one. An existing lead keeps its stage,
 *      its notes and its history; only `last_applied_at` moves.
 *   7. The audit entry, after commit. It is what drives the workflow engine's notifications. If it
 *      fails the application is still saved, and the driver is told so truthfully.
 */
@Injectable()
export class ApplyService {
  private readonly logger = new Logger(ApplyService.name);
  private readonly configLimiter = new RateLimiter(60, 60_000);
  private readonly submitLimiter = new RateLimiter(10, 10 * 60_000);

  constructor(
    private readonly database: DatabaseService,
    private readonly leads: LeadsService,
    private readonly audit: AuditService,
    private readonly telegram: LeadTelegramNotifier,
    private readonly rotation: LeadRotationService,
    private readonly smsPrefs: SmsPreferencesService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ============================================================================== public side

  private async activeLink(slug: string) {
    if (!APPLY_LINK_SLUG_PATTERN.test(slug)) {
      throw new AppError({ status: 404, title: 'Not Found', detail: NOT_ACTIVE });
    }
    const [row] = await this.db
      .select({
        link: hiringApplyLinks,
        companyName: companies.name,
        timezone: companies.timezone,
        weekStart: companies.weekStart,
      })
      .from(hiringApplyLinks)
      .innerJoin(companies, eq(companies.id, hiringApplyLinks.companyId))
      .where(and(eq(hiringApplyLinks.slug, slug), eq(hiringApplyLinks.active, true)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: NOT_ACTIVE });
    return row;
  }

  async publicConfig(slug: string, meta: RequestMeta): Promise<PublicApplyConfig> {
    this.configLimiter.hit(`config:${meta.ip}`);
    const { link, companyName } = await this.activeLink(slug);
    return {
      companyName,
      shortName: link.shortName,
      logoUrl: link.logoUrl,
      consentText: link.consentText,
      privacyPolicyUrl: link.privacyPolicyUrl,
    };
  }

  /** A keyed hash of the client address: enough to count by, useless to anyone who reads it. */
  private addressHash(ip: string): string {
    return createHmac('sha256', env.APP_SECRET).update(`apply:${ip}`).digest('hex').slice(0, 32);
  }

  /**
   * `raw` is the unparsed body on purpose: the address limit has to count a request before
   * validation can refuse it, or a stream of malformed posts would never be limited.
   */
  async submit(slug: string, raw: unknown, meta: RequestMeta): Promise<PublicApplicationReceipt> {
    this.submitLimiter.hit(`submit:${meta.ip}`);
    const body: PublicApplication = applicationPipe.transform(raw);
    const { link, timezone, weekStart } = await this.activeLink(slug);
    const received: PublicApplicationReceipt = { status: 'received' };

    if (body.website.trim() !== '') {
      // Nothing about the person: the slug is the only identifier worth a log line here.
      this.logger.warn(`apply: honeypot filled on link ${link.slug}; nothing saved`);
      return received;
    }

    // A number typed with + is a full international number; anything else is US or Canadian.
    const phone = normalizeApplyPhone(body.phone);
    if (!phone.ok) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `phone: ${phone.message}`,
        extensions: { errors: [{ path: 'phone', message: phone.message, code: 'custom' }] },
      });
    }
    const companyId = link.companyId;
    const { firstName, lastName } = splitFullName(body.fullName);
    const phoneKey = phoneMatchKey(phone.e164);
    const ipHash = this.addressHash(meta.ip);
    const answers: ApplicationAnswers = {
      fullName: body.fullName.replace(/\s+/g, ' ').trim(),
      phone: phone.e164,
      // Free text, kept verbatim: never parsed into years, a CDL class or a pay type.
      experience: body.experience,
      position: body.position,
      completedInSeconds: body.completedInSeconds ?? null,
    };

    // A retry of a submission already saved is answered before any limit can refuse it.
    if (await this.alreadySaved(companyId, body.submissionId)) return received;
    await this.enforceDurableLimits(companyId, ipHash, phoneKey);


    const outcome = await this.saving(link.slug, () =>
      retryOnDuplicate(() =>
        this.db.transaction(async (tx) => {
          // One intake at a time per company: the duplicate check and the lead number cannot race.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${`lead-intake:${companyId}`}))`,
          );

          const [replay] = await tx
            .select({ id: hiringLeadApplications.id })
            .from(hiringLeadApplications)
            .where(
              and(
                eq(hiringLeadApplications.companyId, companyId),
                eq(hiringLeadApplications.submissionKey, body.submissionId),
              ),
            )
            .limit(1);
          if (replay) return null;

          const at = new Date();
          // Instagram or Facebook, from what the ad click carried; otherwise the link's source.
          const source = sourceFromAttribution(body.attribution, link.source);
          // The same phone is the same person only under the same name (case and spacing aside):
          // a different name on a known number is another driver's application and gets its own
          // lead (owner, 2026-10-04).
          const samePhone = await this.leads.findOpenLeadByPhone(tx, companyId, phone.e164);
          let existing = samePhone;
          if (samePhone) {
            const [known] = await tx
              .select({ firstName: hiringLeads.firstName, lastName: hiringLeads.lastName })
              .from(hiringLeads)
              .where(and(eq(hiringLeads.companyId, companyId), eq(hiringLeads.id, samePhone.id)))
              .limit(1);
            const key = (s: string) => s.toLowerCase().replace(/[^a-zÀ-ɏ]+/g, ' ').trim();
            if (!known || key(`${known.firstName} ${known.lastName}`) !== key(`${firstName} ${lastName}`)) {
              existing = null;
            }
          }
          let leadId: string;
          // A new lead takes the next recruiter in turn (owner, 2026-10-07); a lead applying
          // again keeps whoever already has it.
          if (existing) {
            leadId = existing.id;
            await tx
              .update(hiringLeads)
              .set({ lastAppliedAt: at, updatedAt: at })
              .where(and(eq(hiringLeads.companyId, companyId), eq(hiringLeads.id, existing.id)));
          } else {
            const leadNumber = await nextNumber(
              tx,
              hiringLeads,
              hiringLeads.leadNumber,
              hiringLeads.companyId,
              companyId,
              'LEAD',
              1000,
            );
            // Lead numbers are per company; the id is global, so it cannot be built from the number.
            leadId = `lead_${crypto.randomUUID()}`;
            const recruiter = await this.rotation.assignNext(
              tx,
              companyId,
              { id: leadId, label: answers.fullName },
              { id: `apply_link:${link.id}`, name: `Online application · ${link.name}`, type: 'system' },
              'online_application',
            );
            await tx.insert(hiringLeads).values({
              id: leadId,
              companyId,
              leadNumber,
              firstName,
              lastName,
              phone: phone.e164,
              email: null,
              cdlClass: null,
              state: null,
              // The form asks in the driver's own words, not a number; a number here would be
              // invented. The answer is on the application, and prequalification records the figure.
              yearsExperience: null,
              source,
              campaignId: link.campaignId,
              recruiterEmployeeId: recruiter?.employeeId ?? null,
              notes: null,
              status: 'new',
              lastAppliedAt: at,
              createdAt: at,
              updatedAt: at,
            });
          }

          const applicationId = `lapp_${crypto.randomUUID()}`;
          await tx.insert(hiringLeadApplications).values({
            id: applicationId,
            companyId,
            leadId,
            applyLinkId: link.id,
            submissionKey: body.submissionId,
            outcome: existing ? 'existing_lead' : 'new_lead',
            source,
            campaignId: link.campaignId,
            answers,
            attribution: body.attribution,
            consentText: link.consentText,
            privacyPolicyUrl: link.privacyPolicyUrl,
            consentedAt: at,
            phoneKey,
            ipHash,
            userAgent: meta.userAgent?.slice(0, 300) ?? null,
            receivedAt: at,
          });
          return { leadId, existing, at, source };
        }),
      ),
    );

    if (outcome) {
      await this.recordAudit(
        this.systemPrincipal(companyId, timezone, weekStart),
        link,
        answers,
        outcome,
      ).catch((error: unknown) => {
        // The application is committed; the driver hears "received" because it was.
        this.logger.error(
          `apply: application saved on link ${link.slug} but its audit entry failed: ${String(error)}`,
        );
      });
      // The recruiting group hears about it (owner, 2026-10-07): after the commit, never blocking
      // the driver's answer; a Telegram failure leaves the lead as it is.
      if (this.telegram.enabled) void this.announce(companyId, answers, outcome);
      // The link's consent names SMS ("contacted … by phone, email, or SMS"): that is the driver's
      // opt-in to texts about the application. Never over a STOP; never blocking the answer.
      if (/\bSMS\b|\btext messages?\b/i.test(link.consentText)) {
        await this.smsPrefs
          .optInFromApplication(this.systemPrincipal(companyId, timezone, weekStart), answers.phone, link.consentText)
          .catch((error: unknown) => this.logger.error(`apply: SMS consent not recorded on link ${link.slug}: ${(error as Error).name}`));
      }
    }
    return received;
  }

  /**
   * Runs the save, and turns any failure into a plain "not saved, try again".
   *
   * A database error carries the failed query's parameters — this driver's name and phone — and
   * the global filter logs a 5xx with its error attached. So the error is logged here by its code
   * alone, and the response is a fresh error with no cause.
   */
  private async saving<T>(slug: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AppError) throw error;
      const code =
        (error as { code?: string }).code ??
        (error as { cause?: { code?: string } }).cause?.code ??
        'unknown';
      this.logger.error(`apply: saving an application on link ${slug} failed (code ${code})`);
      throw new AppError({
        status: 503,
        title: 'Service Unavailable',
        detail: 'Your application could not be saved just now. Please try again.',
      });
    }
  }

  private async alreadySaved(companyId: string, submissionKey: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: hiringLeadApplications.id })
      .from(hiringLeadApplications)
      .where(
        and(
          eq(hiringLeadApplications.companyId, companyId),
          eq(hiringLeadApplications.submissionKey, submissionKey),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  private async enforceDurableLimits(companyId: string, ipHash: string, phoneKey: string) {
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);
    const [byAddress] = await this.db
      .select({ value: count() })
      .from(hiringLeadApplications)
      .where(
        and(
          eq(hiringLeadApplications.ipHash, ipHash),
          gte(hiringLeadApplications.receivedAt, hourAgo),
        ),
      );
    if ((byAddress?.value ?? 0) >= PER_ADDRESS_PER_HOUR) {
      throw new AppError({
        status: 429,
        title: 'Too Many Requests',
        detail: 'Too many applications from this connection. Please try again later.',
        extensions: { retryAfter: 3600 },
      });
    }
    const [byPhone] = await this.db
      .select({ value: count() })
      .from(hiringLeadApplications)
      .where(
        and(
          eq(hiringLeadApplications.companyId, companyId),
          eq(hiringLeadApplications.phoneKey, phoneKey),
          gte(hiringLeadApplications.receivedAt, dayAgo),
        ),
      );
    if ((byPhone?.value ?? 0) >= PER_PHONE_PER_DAY) {
      throw new AppError({
        status: 429,
        title: 'Too Many Requests',
        detail:
          'We already have several applications from this phone number today. Our recruiting team will contact you.',
        extensions: { retryAfter: 24 * 3600 },
      });
    }
  }

  /**
   * The identity an online application acts under: the company the link belongs to, no user, no
   * permissions. It exists so the audit trail and the default-recruiter rule have a company to
   * scope by; it can authorize nothing.
   */
  private systemPrincipal(companyId: string, timezone: string, weekStart: string): Principal {
    return {
      userId: 'system:online-application',
      userName: 'Online application',
      companyId,
      companyTimezone: timezone,
      weekStart: weekStartIndex(weekStart),
      roles: [],
      permissions: new Set(),
    };
  }

  private async announce(
    companyId: string,
    answers: ApplicationAnswers,
    outcome: { leadId: string; existing: { status: string } | null; source: string },
  ): Promise<void> {
    try {
      const [lead] = await this.db
        .select({
          leadNumber: hiringLeads.leadNumber,
          recruiterFirst: employees.firstName,
          recruiterLast: employees.lastName,
        })
        .from(hiringLeads)
        .leftJoin(
          employees,
          and(eq(employees.id, hiringLeads.recruiterEmployeeId), eq(employees.companyId, companyId)),
        )
        .where(and(eq(hiringLeads.companyId, companyId), eq(hiringLeads.id, outcome.leadId)))
        .limit(1);
      await this.telegram.send(
        this.telegram.text({
          leadNumber: lead?.leadNumber ?? 'Lead',
          leadId: outcome.leadId,
          answers,
          source: outcome.source,
          again: outcome.existing !== null,
          recruiterName:
            lead?.recruiterFirst != null
              ? `${lead.recruiterFirst} ${lead.recruiterLast ?? ''}`.trim()
              : null,
        }),
      );
    } catch (error) {
      this.logger.warn(
        `apply: telegram announcement skipped (${error instanceof Error ? error.name : 'error'})`,
      );
    }
  }

  private async recordAudit(
    principal: Principal,
    link: HiringApplyLinkRow,
    answers: ApplicationAnswers,
    outcome: { leadId: string; existing: { status: string } | null; at: Date; source: string },
  ) {
    const label = answers.fullName;
    const actor = { id: `apply_link:${link.id}`, name: `Online application · ${link.name}` };
    if (outcome.existing) {
      await this.audit.write(principal, {
        action: 'apply',
        actorType: 'system',
        actor,
        entityType: 'lead',
        entityId: outcome.leadId,
        entityLabel: label,
        summary: `Applied again online through "${link.name}"; stage unchanged`,
        changes: [
          { field: 'source', old: null, new: outcome.source },
          { field: 'applyLink', old: null, new: link.slug },
        ],
        at: outcome.at,
      });
      return;
    }
    await this.audit.write(principal, {
      action: 'create',
      actorType: 'system',
      actor,
      entityType: 'lead',
      entityId: outcome.leadId,
      entityLabel: label,
      summary: `Lead added from online application "${link.name}"`,
      changes: [
        { field: 'source', old: null, new: outcome.source },
        { field: 'channel', old: null, new: 'online_application' },
        { field: 'applyLink', old: null, new: link.slug },
      ],
      at: outcome.at,
    });
  }

  // ================================================================================ HR side

  async listLinks(principal: Principal): Promise<ApplyLink[]> {
    const stats = this.db
      .select({
        linkId: hiringLeadApplications.applyLinkId,
        total: count().as('total'),
        last: max(hiringLeadApplications.receivedAt).as('last'),
      })
      .from(hiringLeadApplications)
      .where(eq(hiringLeadApplications.companyId, principal.companyId))
      .groupBy(hiringLeadApplications.applyLinkId)
      .as('stats');
    const rows = await this.db
      .select({
        link: hiringApplyLinks,
        campaignName: hiringCampaigns.name,
        total: stats.total,
        last: stats.last,
      })
      .from(hiringApplyLinks)
      .leftJoin(hiringCampaigns, eq(hiringCampaigns.id, hiringApplyLinks.campaignId))
      .leftJoin(stats, eq(stats.linkId, hiringApplyLinks.id))
      .where(eq(hiringApplyLinks.companyId, principal.companyId))
      .orderBy(desc(hiringApplyLinks.active), desc(hiringApplyLinks.createdAt));
    return rows.map((r) => this.toLink(r.link, r.campaignName, r.total, r.last));
  }

  private toLink(
    link: HiringApplyLinkRow,
    campaignName: string | null,
    total: number | null,
    last: Date | string | null,
  ): ApplyLink {
    return {
      id: link.id,
      slug: link.slug,
      name: link.name,
      shortName: link.shortName,
      source: link.source as ApplyLink['source'],
      campaignId: link.campaignId,
      campaignName: campaignName ?? null,
      logoUrl: link.logoUrl,
      consentText: link.consentText,
      privacyPolicyUrl: link.privacyPolicyUrl,
      active: link.active,
      applicationCount: Number(total ?? 0),
      lastApplicationAt: last ? new Date(last).toISOString() : null,
      createdAt: link.createdAt.toISOString(),
    };
  }

  private async getLink(principal: Principal, id: string): Promise<ApplyLink> {
    const all = await this.listLinks(principal);
    const found = all.find((l) => l.id === id);
    if (!found) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such link' });
    return found;
  }

  /** A campaign named on a link must be this company's. */
  private async assertCampaign(principal: Principal, campaignId: string | null | undefined) {
    if (!campaignId) return;
    const [row] = await this.db
      .select({ id: hiringCampaigns.id })
      .from(hiringCampaigns)
      .where(
        and(eq(hiringCampaigns.companyId, principal.companyId), eq(hiringCampaigns.id, campaignId)),
      )
      .limit(1);
    if (!row) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'campaignId: No such campaign',
        extensions: {
          errors: [{ path: 'campaignId', message: 'No such campaign', code: 'custom' }],
        },
      });
    }
  }

  async createLink(
    principal: Principal,
    input: Required<Omit<CreateApplyLinkInput, 'campaignId' | 'logoUrl' | 'shortName'>> & {
      campaignId: string | null;
      logoUrl: string | null;
      shortName: string | null;
    },
  ): Promise<ApplyLink> {
    await this.assertCampaign(principal, input.campaignId);
    const id = `alink_${crypto.randomUUID()}`;
    try {
      await this.db.insert(hiringApplyLinks).values({
        id,
        companyId: principal.companyId,
        slug: input.slug,
        name: input.name,
        shortName: input.shortName,
        source: input.source,
        campaignId: input.campaignId,
        logoUrl: input.logoUrl,
        consentText: input.consentText,
        privacyPolicyUrl: input.privacyPolicyUrl,
        active: true,
        createdBy: principal.userName ?? principal.userId,
      });
    } catch (error) {
      const code =
        (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
      if (code === '23505') {
        throw new AppError({
          status: 409,
          title: 'Conflict',
          detail: `The address /apply/${input.slug} is already taken. Choose another.`,
        });
      }
      throw error;
    }
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'apply_link',
      entityId: id,
      entityLabel: input.name,
      summary: `Application link /apply/${input.slug} created`,
    });
    return this.getLink(principal, id);
  }

  async updateLink(
    principal: Principal,
    id: string,
    patch: {
      name?: string;
      shortName?: string | null;
      source?: string;
      campaignId?: string | null;
      logoUrl?: string | null;
      consentText?: string;
      privacyPolicyUrl?: string;
      active?: boolean;
    },
  ): Promise<ApplyLink> {
    const before = await this.getLink(principal, id);
    await this.assertCampaign(principal, patch.campaignId);
    await this.db
      .update(hiringApplyLinks)
      .set({
        name: patch.name,
        shortName: patch.shortName,
        source: patch.source,
        campaignId: patch.campaignId,
        logoUrl: patch.logoUrl,
        consentText: patch.consentText,
        privacyPolicyUrl: patch.privacyPolicyUrl,
        active: patch.active,
        updatedAt: new Date(),
      })
      .where(and(eq(hiringApplyLinks.companyId, principal.companyId), eq(hiringApplyLinks.id, id)));
    const changes = (
      ['name', 'shortName', 'source', 'logoUrl', 'consentText', 'privacyPolicyUrl', 'active'] as const
    )
      .filter((f) => patch[f] !== undefined && String(patch[f]) !== String(before[f]))
      .map((f) => ({ field: f, old: String(before[f]), new: String(patch[f]) }));
    await this.audit.write(principal, {
      action: patch.active === false ? 'status_change' : 'update',
      entityType: 'apply_link',
      entityId: id,
      entityLabel: before.name,
      summary:
        patch.active === false
          ? `Application link /apply/${before.slug} switched off`
          : patch.active === true && !before.active
            ? `Application link /apply/${before.slug} switched on`
            : `Application link /apply/${before.slug} updated`,
      changes,
    });
    return this.getLink(principal, id);
  }
}

export type ApplyLinkCreateBody = Parameters<ApplyService['createLink']>[1];
export type ApplyLinkUpdateBody = Parameters<ApplyService['updateLink']>[2];
