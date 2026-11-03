import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  COMPLIANCE_SUBJECT_LABELS,
  DRIVER_CARE_STATE_LABEL,
  DRIVER_CARE_TEAM_LABEL,
  DRIVER_REFERRAL_STAGE_LABEL,
  DRIVER_RELATION_TOPIC_LABELS,
  MANAGEMENT_CALL_TOPIC_LABELS,
  careTeamFor,
  isConfidentialSubmission,
  type DriverCareCreateInput,
  type DriverCareList,
  type DriverCareRequest,
  type DriverCareState,
  type DriverCareTeam,
  type DriverReferral,
  type DriverReferralCreateInput,
  type DriverReferralList,
  type DriverReferralStage,
  type DriverRelationPayload,
  type DriverRelationTopic,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { driverRelationActivities, driverRelationAttachments, driverRelationRequests, type DriverRelationRequestRow } from '../../database/schema/driver-relations';
import { hiringCases, hiringLeads } from '../../database/schema/hiring';
import { SettingsService } from '../admin/settings.service';
import { CareIntakeService } from '../driver-relations/care-intake.service';
import type { Receipt } from '../driver-relations/receipts';
import { FilesService } from '../files/files.service';
import { DriverContextService, type DriverContext } from './driver-context.service';
import { DriverOwnershipService } from './driver-ownership.service';
import { MobileNotificationsService } from './mobile-notifications.service';

const notFound = () => new AppError({ status: 404, title: 'Not Found', detail: 'No such request.' });

/** Who is told about a new request, by the team that answers it. Confidential: only those who may read it. */
const TEAM_CODES: Record<DriverCareTeam, readonly string[]> = {
  driver_relations: ['driver_relations.contact'],
  accounting: ['accounting.edit'],
  safety: ['safety.manage'],
};

const CARE_FILE_TYPES = new Set(['image/jpeg', 'image/png', 'image/heic', 'application/pdf']);

/**
 * Driver Care and referrals from the app (mobile M3, API.md §10-§11), through the existing Driver
 * Relations request pipeline (`CareIntakeService.submitFromDriver`). The driver reads back the
 * acknowledgement, the status and the replies staff shared - never an internal note.
 */
@Injectable()
export class DriverCareService {
  private readonly logger = new Logger(DriverCareService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly context: DriverContextService,
    private readonly ownership: DriverOwnershipService,
    private readonly intake: CareIntakeService,
    private readonly files: FilesService,
    private readonly settings: SettingsService,
    private readonly notifications: MobileNotificationsService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ================================================================================ care

  async create(principal: Principal, input: DriverCareCreateInput & { attachments: string[] }, key: string): Promise<DriverCareRequest> {
    const ctx = await this.context.resolve(principal);
    const files = await this.receipts(principal, input.attachments);
    const topic = input.topic;
    const confidential = isConfidentialSubmission({ topic, callTopic: input.subtopic ?? null });
    const team = careTeamFor(topic);
    const result = await this.intake.submitFromDriver(principal, {
      key: `${ctx.membershipId}:${key}`,
      driver: this.driverOf(ctx),
      topic,
      description: input.message.trim(),
      payload: this.payload(input),
      confidential,
      team,
      referral: topic === 'referral' ? { fullName: input.referralName!, phone: input.referralPhone!, note: input.message.trim() } : null,
      files,
    });
    if (result.created) await this.tellTeam(ctx, result.requestId, result.number, topic, team, confidential);
    return this.one(ctx, result.requestId);
  }

  async mine(principal: Principal): Promise<DriverCareList> {
    const ctx = await this.context.resolve(principal);
    const rows = await this.db
      .select()
      .from(driverRelationRequests)
      .where(and(eq(driverRelationRequests.companyId, ctx.companyId), eq(driverRelationRequests.driverId, ctx.driverId), eq(driverRelationRequests.source, 'driver_app'), eq(driverRelationRequests.isTest, false)))
      .orderBy(desc(driverRelationRequests.receivedAt))
      .limit(100);
    return { requests: await Promise.all(rows.map((r) => this.view(r))) };
  }

  async mineOne(principal: Principal, id: string): Promise<DriverCareRequest> {
    const ctx = await this.context.resolve(principal);
    return this.one(ctx, id);
  }

  private async one(ctx: DriverContext, id: string): Promise<DriverCareRequest> {
    const [row] = await this.db
      .select()
      .from(driverRelationRequests)
      .where(and(eq(driverRelationRequests.companyId, ctx.companyId), eq(driverRelationRequests.driverId, ctx.driverId), eq(driverRelationRequests.source, 'driver_app'), eq(driverRelationRequests.isTest, false), eq(driverRelationRequests.id, id)))
      .limit(1);
    const found = row ?? (await this.byNumber(ctx, id));
    if (!found) throw notFound();
    return this.view(found);
  }

  private async byNumber(ctx: DriverContext, number: string): Promise<DriverRelationRequestRow | null> {
    const [row] = await this.db
      .select()
      .from(driverRelationRequests)
      .where(and(eq(driverRelationRequests.companyId, ctx.companyId), eq(driverRelationRequests.driverId, ctx.driverId), eq(driverRelationRequests.source, 'driver_app'), eq(driverRelationRequests.isTest, false), eq(driverRelationRequests.requestNumber, number)))
      .limit(1);
    return row ?? null;
  }

  private async view(row: DriverRelationRequestRow): Promise<DriverCareRequest> {
    const activities = await this.db
      .select()
      .from(driverRelationActivities)
      .where(and(eq(driverRelationActivities.companyId, row.companyId), eq(driverRelationActivities.requestId, row.id)))
      .orderBy(asc(driverRelationActivities.at));
    const attachments = await this.db
      .select({ id: driverRelationAttachments.id })
      .from(driverRelationAttachments)
      .where(and(eq(driverRelationAttachments.companyId, row.companyId), eq(driverRelationAttachments.requestId, row.id)));
    // Only what staff chose to share with the driver; every other note is internal.
    const responses = activities
      .filter((a) => a.actorType === 'staff' && a.note && (a.detail as { sharedWithDriver?: boolean } | null)?.sharedWithDriver === true)
      .map((a) => ({ at: a.at.toISOString(), byName: a.actorName, text: a.note! }));
    const state: DriverCareState = row.status === 'resolved' ? 'resolved' : row.status === 'contacted' || row.assignedUserId ? 'in_progress' : 'received';
    const topic = row.topic as DriverRelationTopic;
    const team = (row.assignedTeam as DriverCareTeam) ?? 'driver_relations';
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      number: row.requestNumber,
      topic,
      topicLabel: DRIVER_RELATION_TOPIC_LABELS[topic] ?? row.topic,
      subtopic: (payload['subject'] as string | undefined) ?? (payload['callTopic'] as string | undefined) ?? null,
      message: row.description,
      team,
      teamLabel: DRIVER_CARE_TEAM_LABEL[team] ?? team,
      confidential: row.confidential,
      state,
      stateLabel: DRIVER_CARE_STATE_LABEL[state],
      acknowledgedAt: row.receivedAt.toISOString(),
      responses,
      attachments: attachments.map((a) => a.id),
      lastUpdate: row.updatedAt.toISOString(),
    };
  }

  // ============================================================================ referrals

  async refer(principal: Principal, input: DriverReferralCreateInput, key: string): Promise<DriverReferral> {
    const ctx = await this.context.resolve(principal);
    const result = await this.intake.submitFromDriver(principal, {
      key: `${ctx.membershipId}:${key}`,
      driver: this.driverOf(ctx),
      topic: 'referral',
      description: input.note?.trim() || `Referral from ${ctx.driverName}`,
      payload: {},
      confidential: false,
      team: 'driver_relations',
      referral: { fullName: input.name.trim(), phone: input.phone, note: input.note?.trim() || null },
      files: [],
    });
    if (result.created) {
      const recipients = await this.notifications.teamUserIds(ctx.companyId, ['recruiting.manage']);
      await this.notifications
        .notifyUsers(ctx.companyId, recipients, {
          title: `Driver referral ${result.number}: ${input.name.trim()}`,
          body: `Referred by ${ctx.driverName} from the driver app.`,
          pushTitle: 'Driver referral',
          pushBody: `${result.number}: a driver referred someone.`,
          target: { type: 'referral', id: result.requestId },
          dedupeKey: `referral:${result.requestId}`,
        })
        .catch((error: unknown) => this.logger.warn(`Notifying Recruiting about ${result.number} failed: ${String(error)}`));
    }
    const list = await this.referralsOf(ctx);
    return list.find((r) => r.id === result.requestId)!;
  }

  async myReferrals(principal: Principal): Promise<DriverReferralList> {
    const ctx = await this.context.resolve(principal);
    const bonus = await this.settings.value<number | null>(ctx.companyId, 'referral.bonus_amount', null);
    return { referrals: await this.referralsOf(ctx), bonusAmountCents: typeof bonus === 'number' && bonus > 0 ? Math.round(bonus * 100) : null };
  }

  private async referralsOf(ctx: DriverContext): Promise<DriverReferral[]> {
    const rows = await this.db
      .select({ id: driverRelationRequests.id, number: driverRelationRequests.requestNumber, payload: driverRelationRequests.payload, receivedAt: driverRelationRequests.receivedAt, leadId: driverRelationRequests.hrLeadId })
      .from(driverRelationRequests)
      .where(and(eq(driverRelationRequests.companyId, ctx.companyId), eq(driverRelationRequests.driverId, ctx.driverId), eq(driverRelationRequests.source, 'driver_app'), eq(driverRelationRequests.topic, 'referral'), eq(driverRelationRequests.isTest, false)))
      .orderBy(desc(driverRelationRequests.receivedAt));
    const leadIds = rows.map((r) => r.leadId).filter((l): l is string => Boolean(l));
    const leads = leadIds.length
      ? await this.db
          .select({ id: hiringLeads.id, status: hiringLeads.status, referredBy: hiringLeads.referredByDriverId, caseId: hiringLeads.hiringCaseId })
          .from(hiringLeads)
          .where(and(eq(hiringLeads.companyId, ctx.companyId), inArray(hiringLeads.id, leadIds)))
      : [];
    const caseIds = leads.map((l) => l.caseId).filter((c): c is string => Boolean(c));
    const cases = caseIds.length
      ? await this.db.select({ id: hiringCases.id, hiredAt: hiringCases.hiredAt, closedAt: hiringCases.closedAt }).from(hiringCases).where(and(eq(hiringCases.companyId, ctx.companyId), inArray(hiringCases.id, caseIds)))
      : [];
    const leadById = new Map(leads.map((l) => [l.id, l]));
    const caseById = new Map(cases.map((c) => [c.id, c]));
    return rows.map((r) => {
      const lead = r.leadId ? leadById.get(r.leadId) : undefined;
      // A person already on file before this referral: their progress is not this driver's to read.
      let stage: DriverReferralStage = 'received';
      if (lead && lead.referredBy === ctx.driverId) {
        const hiring = lead.caseId ? caseById.get(lead.caseId) : undefined;
        stage =
          lead.status === 'dead'
            ? 'closed'
            : lead.status === 'converted'
              ? hiring?.hiredAt
                ? 'hired'
                : hiring?.closedAt
                  ? 'closed'
                  : 'hiring'
              : lead.status === 'prequalified'
                ? 'in_review'
                : lead.status === 'contacted' || lead.status === 'no_answer'
                  ? 'contacted'
                  : 'received';
      }
      const payload = (r.payload ?? {}) as { referralName?: string };
      return { id: r.id, number: r.number, name: payload.referralName ?? 'Referral', stage, stageLabel: DRIVER_REFERRAL_STAGE_LABEL[stage], submittedAt: r.receivedAt.toISOString() };
    });
  }

  // ============================================================================== plumbing

  private driverOf(ctx: DriverContext) {
    return { id: ctx.driverId, name: ctx.driverName, phone: ctx.driver.phone ?? null, truckId: ctx.truck?.id ?? null, truckNumber: ctx.truck?.unitNumber ?? null };
  }

  private payload(input: DriverCareCreateInput): DriverRelationPayload {
    const sub = input.subtopic ?? null;
    switch (input.topic) {
      case 'compliance': {
        const subject = (sub ?? 'other') as keyof typeof COMPLIANCE_SUBJECT_LABELS;
        return { subject, subjectLabel: COMPLIANCE_SUBJECT_LABELS[subject] ?? subject } as DriverRelationPayload;
      }
      case 'pay_statement':
        return { weekStart: input.weekStart ?? null, loadNumber: input.loadNumber ?? null } as DriverRelationPayload;
      case 'reimbursement':
        return { loadNumber: input.loadNumber ?? null } as DriverRelationPayload;
      case 'management_call': {
        const callTopic = (sub ?? 'general_support') as keyof typeof MANAGEMENT_CALL_TOPIC_LABELS;
        return { callTopic, callTopicLabel: MANAGEMENT_CALL_TOPIC_LABELS[callTopic] ?? callTopic, preferredTime: input.preferredTime ?? null } as DriverRelationPayload;
      }
      default:
        return {} as DriverRelationPayload;
    }
  }

  /** The driver's uploads, copied into Driver Relations' private storage as the request's attachments. */
  private async receipts(principal: Principal, ids: readonly string[]): Promise<Receipt[]> {
    const own = await this.ownership.ownFiles(principal, ids, (t) => CARE_FILE_TYPES.has(t));
    const out: Receipt[] = [];
    for (const file of own.values()) {
      const { bytes } = await this.files.read(principal.companyId, file.id);
      out.push({ fileName: file.fileName, contentType: file.contentType as Receipt['contentType'], bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    return out;
  }

  private async tellTeam(ctx: DriverContext, requestId: string, number: string, topic: DriverRelationTopic, team: DriverCareTeam, confidential: boolean) {
    const codes = confidential ? ['driver_relations.confidential'] : TEAM_CODES[team];
    const recipients = await this.notifications.teamUserIds(ctx.companyId, codes);
    await this.notifications
      .notifyUsers(ctx.companyId, recipients, {
        // A confidential request names nobody and says nothing in the line itself.
        title: confidential ? `Confidential Driver Care request ${number}` : `${DRIVER_RELATION_TOPIC_LABELS[topic]} ${number} from ${ctx.driverName}`,
        body: confidential ? 'Open it in Driver Relations.' : `Sent from the driver app; routed to ${DRIVER_CARE_TEAM_LABEL[team]}.`,
        pushTitle: 'Driver Care request',
        pushBody: `${number}: a driver sent a request.`,
        target: { type: 'care', id: requestId },
        dedupeKey: `care:${requestId}:received`,
      })
      .catch((error: unknown) => this.logger.warn(`Notifying ${team} about ${number} failed: ${String(error)}`));
  }

  /** Hook: a shared reply, a contact or a resolution on a request the driver sent from the app. */
  async onStaffChange(principal: Principal, row: DriverRelationRequestRow, activity: { type: string; note?: string | null; detail?: Record<string, unknown> | null }) {
    if (row.source !== 'driver_app' || !row.driverId) return;
    const shared = activity.type === 'note' && activity.detail?.['sharedWithDriver'] === true;
    const status = activity.type === 'contacted' || activity.type === 'resolved' || activity.type === 'reopened';
    if (!shared && !status) return;
    const label = shared ? 'New reply' : activity.type === 'resolved' ? 'Resolved' : activity.type === 'reopened' ? 'Reopened' : 'In progress';
    await this.notifications.notifyDriver(principal.companyId, row.driverId, {
      title: `${row.requestNumber}: ${label}`,
      body: shared ? (activity.note ?? null) : null,
      pushTitle: 'Driver Care',
      pushBody: shared ? `${row.requestNumber}: you have a reply.` : `${row.requestNumber}: ${label.toLowerCase()}.`,
      target: { type: 'care', id: row.id },
      dedupeKey: `care:${row.id}:${activity.type}:${Date.now()}`,
    });
  }

}
