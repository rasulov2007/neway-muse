import { Injectable, Logger } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  CONTACT_METHOD_LABELS,
  DRIVER_RELATION_TOPICS,
  DRIVER_RELATION_TOPIC_LABELS,
  DriverRelationListQuerySchema,
  type CareLink,
  type ContactMethod,
  type DriverRelationActivity,
  type DriverRelationActivityType,
  type DriverRelationAssignee,
  type DriverRelationCounts,
  type DriverRelationDelivery,
  type DriverRelationDetail,
  type DriverRelationIntegrationStatus,
  type DriverRelationListQuery,
  type DriverRelationPage,
  type DriverRelationPayload,
  type DriverRelationRequest,
  type DriverRelationRosterOption,
  type DriverRelationStatus,
  type DriverRelationTopic,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { DocumentStorageService } from '../../common/storage/document-storage.service';
import { AppError } from '../../common/errors/app-error';
import { env } from '../../config/env';
import type { Transaction } from '../../database/client';
import { DatabaseService } from '../../database/database.service';
import { acctExpenses } from '../../database/schema/accounting';
import {
  memberships,
  membershipRoles,
  rolePermissions,
  roles,
  users,
} from '../../database/schema/admin';
import {
  driverCareLinks,
  driverRelationAttachments,
  driverCareSubmissions,
  driverRelationActivities,
  driverRelationOutbox,
  driverRelationRequests,
  type DriverRelationRequestRow,
} from '../../database/schema/driver-relations';
import { hiringLeads } from '../../database/schema/hiring';
import { drivers, trucks } from '../../database/schema/roster';
import { AuditService } from '../people/audit.service';

export const notFound = () =>
  new AppError({ status: 404, title: 'Not Found', detail: 'No such Driver Relations request.' });

function unprocessable(detail: string, path?: string): AppError {
  return new AppError({
    status: 422,
    title: 'Unprocessable Entity',
    detail,
    ...(path ? { extensions: { errors: [{ path, message: detail, code: 'custom' }] } } : {}),
  });
}

function stale(current: number): AppError {
  return new AppError({
    status: 409,
    title: 'Conflict',
    detail:
      'Someone else changed this request while you were working on it. Nothing was saved; your text is still here. Check the latest activity and save again.',
    extensions: { currentVersion: current },
  });
}

/** What one write does to a request: the new columns, the activity line and the audit line. */
interface Change {
  set: Partial<typeof driverRelationRequests.$inferInsert>;
  activity: {
    type: DriverRelationActivityType;
    method?: ContactMethod | null;
    note?: string | null;
    correctsActivityId?: string | null;
    detail?: Record<string, unknown> | null;
  };
  audit: {
    action: string;
    summary: string;
    changes?: { field: string; old: string | null; new: string | null }[];
  };
}

const STAFF_PERMISSIONS = ['driver_relations.contact', 'driver_relations.manage'];

/**
 * The Driver Relations workspace: list, counts, detail and every staff action on a request.
 *
 * Every action that changes a request goes through `change()`: one transaction that locks the
 * request row, refuses a stale version (409, nothing written), updates the request with the
 * version bumped, and appends the activity line. The badge is `needs_contact` on the row, so a
 * contact that loses the race cannot decrement it a second time — the row it would clear is
 * already clear and its version has moved.
 */
@Injectable()
export class DriverRelationsService {
  private readonly logger = new Logger(DriverRelationsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: DocumentStorageService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Confidentiality (owner, 2026-10-06): Complaint & Feedback and confidential call requests are
   * read only by holders of driver_relations.confidential (the Driver Relations role and
   * administrators). For everyone else they do not exist: not in a list, a count, the badge, a
   * detail, a file or a write - a guessed id is a 404, exactly like another company's.
   */
  private seesConfidential(principal: Principal): boolean {
    return hasPermission(principal, 'driver_relations.confidential');
  }

  /** The rows this principal may see: their company, and confidential ones only with the permission. */
  private visible(principal: Principal): SQL {
    // Test requests are kept but never shown (owner, 2026-10-07).
    const company = and(
      eq(driverRelationRequests.companyId, principal.companyId),
      eq(driverRelationRequests.isTest, false),
    ) as SQL;
    return this.seesConfidential(principal)
      ? company
      : (and(company, eq(driverRelationRequests.confidential, false)) as SQL);
  }

  // =================================================================================== reads

  async counts(principal: Principal): Promise<DriverRelationCounts> {
    const rows = await this.db
      .select({
        topic: driverRelationRequests.topic,
        total: count(),
        needsContact: sql<number>`count(*) filter (where ${driverRelationRequests.needsContact})::int`,
        contacted: sql<number>`count(*) filter (where not ${driverRelationRequests.needsContact} and ${driverRelationRequests.status} = 'contacted')::int`,
        resolved: sql<number>`count(*) filter (where ${driverRelationRequests.status} = 'resolved')::int`,
      })
      .from(driverRelationRequests)
      .where(this.visible(principal))
      .groupBy(driverRelationRequests.topic);

    const byTopic = Object.fromEntries(
      DRIVER_RELATION_TOPICS.map((t) => [t, { needsContact: 0, total: 0 }]),
    ) as DriverRelationCounts['byTopic'];
    const byStatus = { awaitingContact: 0, contacted: 0, resolved: 0, all: 0 };
    for (const r of rows) {
      const topic = r.topic as DriverRelationTopic;
      if (byTopic[topic]) byTopic[topic] = { needsContact: r.needsContact, total: r.total };
      byStatus.awaitingContact += r.needsContact;
      byStatus.contacted += r.contacted;
      byStatus.resolved += r.resolved;
      byStatus.all += r.total;
    }
    return {
      needsContact: byStatus.awaitingContact,
      byTopic,
      byStatus,
      confidentialHidden: !this.seesConfidential(principal),
    };
  }

  private selectRequest() {
    return this.db
      .select({
        request: driverRelationRequests,
        driverFirst: drivers.firstName,
        driverLast: drivers.lastName,
        truckUnit: trucks.unitNumber,
        leadNumber: hiringLeads.leadNumber,
        attachmentCount: sql<number>`(select count(*)::int from ${driverRelationAttachments} a where a.company_id = ${driverRelationRequests.companyId} and a.request_id = ${driverRelationRequests.id})`,
      })
      .from(driverRelationRequests)
      .leftJoin(
        drivers,
        and(
          eq(drivers.id, driverRelationRequests.driverId),
          eq(drivers.companyId, driverRelationRequests.companyId),
        ),
      )
      .leftJoin(
        trucks,
        and(
          eq(trucks.id, driverRelationRequests.truckId),
          eq(trucks.companyId, driverRelationRequests.companyId),
        ),
      )
      .leftJoin(
        hiringLeads,
        and(
          eq(hiringLeads.id, driverRelationRequests.hrLeadId),
          eq(hiringLeads.companyId, driverRelationRequests.companyId),
        ),
      );
  }

  private toRequest(r: {
    request: DriverRelationRequestRow;
    driverFirst: string | null;
    driverLast: string | null;
    truckUnit: string | null;
    leadNumber: string | null;
    attachmentCount: number;
  }): DriverRelationRequest {
    const q = r.request;
    const topic = q.topic as DriverRelationTopic;
    return {
      id: q.id,
      requestNumber: q.requestNumber,
      topic,
      topicLabel: DRIVER_RELATION_TOPIC_LABELS[topic] ?? q.topic,
      source: q.source as DriverRelationRequest['source'],
      assignedTeam: q.assignedTeam,
      status: q.status as DriverRelationStatus,
      needsContact: q.needsContact,
      confidential: q.confidential,
      attachmentCount: Number(r.attachmentCount ?? 0),
      submittedName: q.submittedName,
      truckNumber: q.truckSnapshot,
      contactPhone: q.contactPhone,
      description: q.description,
      payload: (q.payload ?? {}) as DriverRelationPayload,
      driverId: q.driverId,
      driverName: r.driverFirst ? `${r.driverFirst} ${r.driverLast ?? ''}`.trim() : null,
      truckId: q.truckId,
      truckUnit: r.truckUnit,
      assignedUserId: q.assignedUserId,
      assignedUserName: q.assignedUserName,
      receivedAt: q.receivedAt.toISOString(),
      lastDriverMessageAt: q.lastDriverMessageAt.toISOString(),
      contactedAt: q.contactedAt?.toISOString() ?? null,
      contactedByName: q.contactedByName,
      resolvedAt: q.resolvedAt?.toISOString() ?? null,
      resolvedByName: q.resolvedByName,
      hrLeadId: q.hrLeadId,
      hrLeadNumber: r.leadNumber,
      accountingExpenseId: q.accountingExpenseId,
      version: q.version,
      updatedAt: q.updatedAt.toISOString(),
    };
  }

  async list(principal: Principal, raw: DriverRelationListQuery): Promise<DriverRelationPage> {
    const query = DriverRelationListQuerySchema.parse(raw);
    const parts: SQL[] = [this.visible(principal)];
    if (query.topic) parts.push(eq(driverRelationRequests.topic, query.topic));
    if (query.status === 'needs_contact') parts.push(eq(driverRelationRequests.needsContact, true));
    if (query.status === 'contacted') {
      parts.push(
        eq(driverRelationRequests.status, 'contacted'),
        eq(driverRelationRequests.needsContact, false),
      );
    }
    if (query.status === 'resolved') parts.push(eq(driverRelationRequests.status, 'resolved'));
    if (query.assignee === 'me')
      parts.push(eq(driverRelationRequests.assignedUserId, principal.userId));
    else if (query.assignee === 'unassigned')
      parts.push(isNull(driverRelationRequests.assignedUserId));
    else if (query.assignee) parts.push(eq(driverRelationRequests.assignedUserId, query.assignee));
    if (query.q) {
      const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const search = or(
        ilike(driverRelationRequests.submittedName, like),
        ilike(driverRelationRequests.truckSnapshot, like),
        ilike(driverRelationRequests.requestNumber, like),
        ilike(driverRelationRequests.contactPhone, like),
        ilike(driverRelationRequests.description, like),
      );
      if (search) parts.push(search);
    }
    const where = and(...parts);
    const [total] = await this.db
      .select({ value: count() })
      .from(driverRelationRequests)
      .where(where);
    const rows = await this.selectRequest()
      .where(where)
      .orderBy(
        desc(driverRelationRequests.needsContact),
        query.sort === 'received_asc'
          ? asc(driverRelationRequests.receivedAt)
          : desc(driverRelationRequests.receivedAt),
        asc(driverRelationRequests.id),
      )
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    return {
      data: rows.map((r) => this.toRequest(r)),
      total: total?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private async getRequest(principal: Principal, id: string): Promise<DriverRelationRequest> {
    const [row] = await this.selectRequest()
      .where(and(this.visible(principal), eq(driverRelationRequests.id, id)))
      .limit(1);
    if (!row) throw notFound();
    return this.toRequest(row);
  }

  async detail(principal: Principal, id: string): Promise<DriverRelationDetail> {
    const request = await this.getRequest(principal, id);
    const activities = await this.db
      .select()
      .from(driverRelationActivities)
      .where(
        and(
          eq(driverRelationActivities.companyId, principal.companyId),
          eq(driverRelationActivities.requestId, id),
        ),
      )
      .orderBy(asc(driverRelationActivities.at), asc(driverRelationActivities.requestVersion));
    const deliveries = await this.db
      .select()
      .from(driverRelationOutbox)
      .where(
        and(
          eq(driverRelationOutbox.companyId, principal.companyId),
          eq(driverRelationOutbox.requestId, id),
        ),
      )
      .orderBy(asc(driverRelationOutbox.createdAt));
    const files = await this.db
      .select()
      .from(driverRelationAttachments)
      .where(
        and(
          eq(driverRelationAttachments.companyId, principal.companyId),
          eq(driverRelationAttachments.requestId, id),
        ),
      )
      .orderBy(asc(driverRelationAttachments.createdAt));
    return {
      request,
      attachments: files.map((f) => ({
        id: f.id,
        fileName: f.originalFileName,
        contentType: f.contentType,
        sizeBytes: f.sizeBytes,
        createdAt: f.createdAt.toISOString(),
        url: `/api/v1/driver-relations/requests/${encodeURIComponent(id)}/attachments/${encodeURIComponent(f.id)}`,
      })),
      activities: activities.map((a): DriverRelationActivity => ({
        id: a.id,
        type: a.type as DriverRelationActivityType,
        actorType: a.actorType as DriverRelationActivity['actorType'],
        actorName: a.actorName,
        method: (a.method as ContactMethod | null) ?? null,
        note: a.note,
        correctsActivityId: a.correctsActivityId,
        detail: (a.detail as Record<string, unknown> | null) ?? null,
        at: a.at.toISOString(),
      })),
      deliveries: deliveries.map((d): DriverRelationDelivery => ({
        id: d.id,
        adapter: 'telegram',
        eventType: d.eventType,
        status: d.status as DriverRelationDelivery['status'],
        attempts: d.attempts,
        lastError: d.lastError,
        sentAt: d.sentAt?.toISOString() ?? null,
        createdAt: d.createdAt.toISOString(),
      })),
    };
  }

  /** Who a request may be assigned to: active accounts in this company that can work requests. */
  async assignees(principal: Principal): Promise<DriverRelationAssignee[]> {
    return (await this.staff(principal)).map(({ userId, name }) => ({ userId, name }));
  }

  /** Who can work requests, and whether each may see confidential ones. */
  private async staff(principal: Principal) {
    const rows = await this.db
      .select({
        userId: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        isOwner: memberships.isOwner,
        permission: rolePermissions.permissionCode,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
      .leftJoin(roles, and(eq(roles.id, membershipRoles.roleId), eq(roles.status, 'active')))
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .where(
        and(
          eq(memberships.companyId, principal.companyId),
          eq(memberships.status, 'active'),
          eq(users.isActive, true),
        ),
      );
    const people = new Map<
      string,
      { userId: string; name: string; works: boolean; confidential: boolean }
    >();
    for (const r of rows) {
      const person = people.get(r.userId) ?? {
        userId: r.userId,
        name: `${r.firstName} ${r.lastName}`.trim(),
        works: false,
        confidential: false,
      };
      if (r.isOwner || (r.permission && STAFF_PERMISSIONS.includes(r.permission)))
        person.works = true;
      if (r.isOwner || r.permission === 'driver_relations.confidential') person.confidential = true;
      people.set(r.userId, person);
    }
    return [...people.values()].filter((p) => p.works).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Drivers and trucks to verify a request against. The typed name is never matched for you. */
  async rosterOptions(
    principal: Principal,
    q: string | undefined,
  ): Promise<DriverRelationRosterOption[]> {
    const term = (q ?? '').trim();
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const driverRows = await this.db
      .select({
        id: drivers.id,
        firstName: drivers.firstName,
        lastName: drivers.lastName,
        number: drivers.driverNumber,
        phone: drivers.phone,
      })
      .from(drivers)
      .where(
        and(
          eq(drivers.companyId, principal.companyId),
          isNull(drivers.archivedAt),
          term
            ? or(
                ilike(sql`${drivers.firstName} || ' ' || ${drivers.lastName}`, like),
                ilike(drivers.driverNumber, like),
                ilike(drivers.phone, like),
              )
            : undefined,
        ),
      )
      .orderBy(asc(drivers.firstName), asc(drivers.lastName))
      .limit(20);
    const truckRows = await this.db
      .select({ id: trucks.id, unit: trucks.unitNumber, make: trucks.make })
      .from(trucks)
      .where(
        and(
          eq(trucks.companyId, principal.companyId),
          ne(trucks.status, 'archived'),
          term ? ilike(trucks.unitNumber, like) : undefined,
        ),
      )
      .orderBy(asc(trucks.unitNumber))
      .limit(20);
    return [
      ...driverRows.map((d) => ({
        kind: 'driver' as const,
        id: d.id,
        label: `${d.firstName} ${d.lastName}`.trim(),
        detail: [d.number, d.phone].filter(Boolean).join(' · ') || null,
      })),
      ...truckRows.map((t) => ({
        kind: 'truck' as const,
        id: t.id,
        label: `Truck ${t.unit}`,
        detail: t.make || null,
      })),
    ];
  }

  integrationStatus(): DriverRelationIntegrationStatus {
    const configured = Boolean(env.TELEGRAM_DR_BOT_TOKEN && env.TELEGRAM_DR_CHAT_ID);
    const enabled = env.DR_TELEGRAM_ENABLED && configured;
    return {
      telegram: { enabled, configured, label: enabled ? 'Connected' : 'Not connected' },
    };
  }

  // ================================================================================== writes

  private actor(principal: Principal) {
    return { id: principal.userId, name: principal.userName ?? principal.userId };
  }

  /**
   * The one door every staff write goes through. `expectedVersion` null means the action does not
   * change the request (an attempt, a note): it is appended without a version check and without
   * bumping the version, so it can never make somebody else's contact stale.
   */
  private async change(
    principal: Principal,
    id: string,
    expectedVersion: number | null,
    decide: (row: DriverRelationRequestRow, tx: Transaction) => Promise<Change> | Change,
  ): Promise<DriverRelationDetail> {
    const now = new Date();
    const actor = this.actor(principal);
    const result = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(driverRelationRequests)
        .where(and(this.visible(principal), eq(driverRelationRequests.id, id)))
        .for('update')
        .limit(1);
      if (!row) throw notFound();
      if (expectedVersion !== null && row.version !== expectedVersion) throw stale(row.version);

      const change = await decide(row, tx);
      const bumps = expectedVersion !== null;
      const version = bumps ? row.version + 1 : row.version;
      if (bumps) {
        const updated = await tx
          .update(driverRelationRequests)
          .set({ ...change.set, version, updatedAt: now })
          .where(
            and(
              eq(driverRelationRequests.companyId, principal.companyId),
              eq(driverRelationRequests.id, id),
              eq(driverRelationRequests.version, row.version),
            ),
          )
          .returning({ id: driverRelationRequests.id });
        if (updated.length === 0) throw stale(row.version);
      }
      await tx.insert(driverRelationActivities).values({
        id: `dra_${crypto.randomUUID()}`,
        companyId: principal.companyId,
        requestId: id,
        type: change.activity.type,
        actorType: 'staff',
        actorId: actor.id,
        actorName: actor.name,
        method: change.activity.method ?? null,
        note: change.activity.note ?? null,
        correctsActivityId: change.activity.correctsActivityId ?? null,
        detail: change.activity.detail ?? null,
        requestVersion: version,
        at: now,
      });
      return { row, change };
    });

    await this.audit
      .write(principal, {
        action: result.change.audit.action,
        entityType: 'driver_relation_request',
        entityId: id,
        entityLabel: `${result.row.requestNumber} · ${result.row.submittedName}`,
        summary: result.change.audit.summary,
        changes: result.change.audit.changes ?? [],
        at: now,
      })
      .catch((error: unknown) => {
        this.logger.error(
          `driver relations: ${result.row.requestNumber} saved but its audit entry failed: ${String(error)}`,
        );
      });
    for (const listener of this.afterChange) {
      try {
        await listener(principal, result.row, result.change.activity);
      } catch {
        // The listener records its own failure; the change stands.
      }
    }
    return this.detail(principal, id);
  }

  /**
   * Called after a staff action on a request is written (mobile M3): the mobile module tells the
   * driver who sent it from the app about a reply shared with them, a contact or a resolution.
   */
  readonly afterChange: Array<(principal: Principal, before: DriverRelationRequestRow, activity: Change['activity']) => Promise<void>> = [];

  async assign(
    principal: Principal,
    id: string,
    input: { assigneeUserId: string | null; expectedVersion: number },
  ): Promise<DriverRelationDetail> {
    let name: string | null = null;
    let assigneeSeesConfidential = true;
    if (input.assigneeUserId) {
      const match = (await this.staff(principal)).find((a) => a.userId === input.assigneeUserId);
      if (!match)
        throw unprocessable(
          'That person cannot work Driver Relations requests in this company.',
          'assigneeUserId',
        );
      name = match.name;
      assigneeSeesConfidential = match.confidential;
    }
    return this.change(principal, id, input.expectedVersion, (row) => {
      if (row.confidential && !assigneeSeesConfidential) {
        throw unprocessable(
          'This request is confidential; that person cannot see confidential requests.',
          'assigneeUserId',
        );
      }
      return {
        // Assigning never touches the alert: only a recorded contact clears it.
        set: { assignedUserId: input.assigneeUserId, assignedUserName: name },
        activity: {
          type: 'assigned',
          detail: { from: row.assignedUserName, to: name },
        },
        audit: {
          action: 'assign',
          summary: name ? `Assigned to ${name}` : 'Unassigned',
          changes: [{ field: 'assignedTo', old: row.assignedUserName, new: name }],
        },
      };
    });
  }

  /** "Tried calling, no answer": recorded, and the alert stays. */
  async attempt(principal: Principal, id: string, input: { method: ContactMethod; note: string }) {
    return this.change(principal, id, null, (row) => {
      if (row.status === 'resolved')
        throw unprocessable('This request is resolved. Reopen it first.');
      return {
        set: {},
        activity: { type: 'attempt', method: input.method, note: input.note },
        audit: {
          action: 'contact_attempt',
          summary: `Contact attempted by ${CONTACT_METHOD_LABELS[input.method]}; still needs contact`,
        },
      };
    });
  }

  /** The only action that clears the alert, and only for this request. */
  async contact(
    principal: Principal,
    id: string,
    input: { method: ContactMethod; note: string; expectedVersion: number },
  ) {
    const actor = this.actor(principal);
    return this.change(principal, id, input.expectedVersion, (row) => {
      if (row.status === 'resolved')
        throw unprocessable('This request is resolved. Reopen it first.');
      const now = new Date();
      return {
        set: {
          needsContact: false,
          status: 'contacted',
          contactedAt: now,
          contactedBy: actor.id,
          contactedByName: actor.name,
        },
        activity: { type: 'contacted', method: input.method, note: input.note },
        audit: {
          action: 'contacted',
          summary: `Driver contacted by ${CONTACT_METHOD_LABELS[input.method]}`,
          changes: [
            { field: 'needsContact', old: String(row.needsContact), new: 'false' },
            { field: 'status', old: row.status, new: 'contacted' },
          ],
        },
      };
    });
  }

  async addNote(
    principal: Principal,
    id: string,
    input: { note: string; correctsActivityId?: string; shareWithDriver?: boolean },
  ) {
    return this.change(principal, id, null, async (row, tx) => {
      // A reply for the driver goes only to a driver who is signed in to the app on this request.
      if (input.shareWithDriver && (row.source !== 'driver_app' || !row.driverId)) {
        throw unprocessable('Only a request sent from the driver app can carry a reply to the driver.', 'shareWithDriver');
      }
      if (input.correctsActivityId) {
        const [original] = await tx
          .select({ id: driverRelationActivities.id })
          .from(driverRelationActivities)
          .where(
            and(
              eq(driverRelationActivities.companyId, principal.companyId),
              eq(driverRelationActivities.requestId, id),
              eq(driverRelationActivities.id, input.correctsActivityId),
            ),
          )
          .limit(1);
        if (!original)
          throw unprocessable(
            'The entry being corrected is not on this request.',
            'correctsActivityId',
          );
      }
      const correction = Boolean(input.correctsActivityId);
      return {
        set: {},
        activity: {
          type: correction ? 'correction' : 'note',
          note: input.note,
          correctsActivityId: input.correctsActivityId ?? null,
          detail: input.shareWithDriver ? { sharedWithDriver: true } : null,
        },
        audit: {
          action: correction ? 'correction' : input.shareWithDriver ? 'reply_to_driver' : 'note',
          summary: correction ? 'Correction added (the original entry is kept)' : input.shareWithDriver ? 'Reply shared with the driver in the app' : 'Note added',
        },
      };
    });
  }

  async resolve(
    principal: Principal,
    id: string,
    input: { note: string; expectedVersion: number },
  ) {
    const actor = this.actor(principal);
    return this.change(principal, id, input.expectedVersion, (row) => {
      if (row.status === 'resolved') throw unprocessable('This request is already resolved.');
      // No supervisor exception exists: an uncontacted request cannot be closed, and the alert is
      // never cleared by anything but a recorded contact.
      if (row.needsContact || !row.contactedAt) {
        throw unprocessable(
          'Record contact with the driver before resolving. The alert stays until contact is recorded.',
        );
      }
      return {
        set: {
          status: 'resolved',
          resolvedAt: new Date(),
          resolvedBy: actor.id,
          resolvedByName: actor.name,
        },
        activity: { type: 'resolved', note: input.note },
        audit: {
          action: 'resolve',
          summary: 'Request resolved',
          changes: [{ field: 'status', old: row.status, new: 'resolved' }],
        },
      };
    });
  }

  async reopen(principal: Principal, id: string, input: { note: string; expectedVersion: number }) {
    return this.change(principal, id, input.expectedVersion, (row) => {
      if (row.status !== 'resolved')
        throw unprocessable('Only a resolved request can be reopened.');
      return {
        set: {
          status: row.contactedAt ? 'contacted' : 'new',
          needsContact: true,
          resolvedAt: null,
          resolvedBy: null,
          resolvedByName: null,
        },
        activity: { type: 'reopened', note: input.note },
        audit: {
          action: 'reopen',
          summary: 'Request reopened; needs contact again',
          changes: [
            { field: 'status', old: 'resolved', new: row.contactedAt ? 'contacted' : 'new' },
            { field: 'needsContact', old: String(row.needsContact), new: 'true' },
          ],
        },
      };
    });
  }

  /**
   * A message the driver sent some other way (a call, a text, Telegram), logged by staff. Like a
   * new message through Driver Care, it puts the alert back; a resolved request reopens.
   */
  async driverMessage(
    principal: Principal,
    id: string,
    input: { message: string; method: ContactMethod; expectedVersion: number },
  ) {
    return this.change(principal, id, input.expectedVersion, (row) => {
      const reopening = row.status === 'resolved';
      return {
        set: {
          needsContact: true,
          lastDriverMessageAt: new Date(),
          ...(reopening
            ? {
                status: row.contactedAt ? 'contacted' : 'new',
                resolvedAt: null,
                resolvedBy: null,
                resolvedByName: null,
              }
            : {}),
        },
        activity: {
          type: 'driver_message',
          method: input.method,
          note: input.message,
          detail: { loggedBy: 'staff', reopened: reopening },
        },
        audit: {
          action: 'driver_message',
          summary: reopening
            ? 'New driver message logged; request reopened and needs contact'
            : 'New driver message logged; needs contact',
          changes: [{ field: 'needsContact', old: String(row.needsContact), new: 'true' }],
        },
      };
    });
  }

  /**
   * Verified links: the roster driver and truck staff confirmed, and an Accounting reimbursement
   * recorded in Accounting's own workflow. Each is checked to be this company's; nothing in the
   * linked record changes.
   */
  async link(
    principal: Principal,
    id: string,
    input: {
      driverId?: string | null;
      truckId?: string | null;
      accountingExpenseId?: string | null;
      expectedVersion: number;
    },
  ) {
    const actor = this.actor(principal);
    return this.change(principal, id, input.expectedVersion, async (row, tx) => {
      const set: Change['set'] = {};
      const changes: { field: string; old: string | null; new: string | null }[] = [];
      if (input.driverId !== undefined) {
        if (input.driverId) {
          const [d] = await tx
            .select({ id: drivers.id })
            .from(drivers)
            .where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, input.driverId)))
            .limit(1);
          if (!d) throw unprocessable('No such driver in this company.', 'driverId');
        }
        set.driverId = input.driverId;
        changes.push({ field: 'driverId', old: row.driverId, new: input.driverId });
      }
      if (input.truckId !== undefined) {
        if (input.truckId) {
          const [t] = await tx
            .select({ id: trucks.id })
            .from(trucks)
            .where(and(eq(trucks.companyId, principal.companyId), eq(trucks.id, input.truckId)))
            .limit(1);
          if (!t) throw unprocessable('No such truck in this company.', 'truckId');
        }
        set.truckId = input.truckId;
        changes.push({ field: 'truckId', old: row.truckId, new: input.truckId });
      }
      if (input.accountingExpenseId !== undefined) {
        if (input.accountingExpenseId) {
          if (row.topic !== 'reimbursement') {
            throw unprocessable(
              'Only a reimbursement request links to an Accounting reimbursement.',
              'accountingExpenseId',
            );
          }
          // Read only: the reimbursement must already exist in Accounting's own workflow.
          const [e] = await tx
            .select({ id: acctExpenses.id })
            .from(acctExpenses)
            .where(
              and(
                eq(acctExpenses.companyId, principal.companyId),
                eq(acctExpenses.id, input.accountingExpenseId),
                sql`jsonb_typeof(${acctExpenses.record}->'reimbursement') = 'object'`,
              ),
            )
            .limit(1);
          if (!e) {
            throw unprocessable(
              'No such reimbursement in Accounting. Accounting records it first; then link it here.',
              'accountingExpenseId',
            );
          }
        }
        set.accountingExpenseId = input.accountingExpenseId;
        changes.push({
          field: 'accountingExpenseId',
          old: row.accountingExpenseId,
          new: input.accountingExpenseId,
        });
      }
      if (set.driverId !== undefined || set.truckId !== undefined) {
        set.verifiedBy = actor.id;
        set.verifiedAt = new Date();
      }
      return {
        set,
        activity: {
          type: 'linked',
          detail: Object.fromEntries(changes.map((c) => [c.field, c.new])),
        },
        audit: {
          action: 'link',
          summary: `Linked records updated (${changes.map((c) => c.field).join(', ')})`,
          changes,
        },
      };
    });
  }

  /**
   * One receipt's bytes. The request must be visible to this principal (company and
   * confidentiality) and the file must belong to it; anything else is a 404.
   */
  async attachment(principal: Principal, requestId: string, attachmentId: string) {
    await this.getRequest(principal, requestId);
    const [file] = await this.db
      .select()
      .from(driverRelationAttachments)
      .where(
        and(
          eq(driverRelationAttachments.companyId, principal.companyId),
          eq(driverRelationAttachments.requestId, requestId),
          eq(driverRelationAttachments.id, attachmentId),
        ),
      )
      .limit(1);
    if (!file) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such file.' });
    return { file, bytes: await this.storage.get(file.storageKey) };
  }

  // ============================================================================= care links

  async listCareLinks(principal: Principal): Promise<CareLink[]> {
    const rows = await this.db
      .select({
        link: driverCareLinks,
        requests: sql<number>`(select count(*)::int from ${driverCareSubmissions} s where s.care_link_id = ${driverCareLinks.id})`,
      })
      .from(driverCareLinks)
      .where(eq(driverCareLinks.companyId, principal.companyId))
      .orderBy(desc(driverCareLinks.active), desc(driverCareLinks.createdAt));
    return rows.map((r) => ({
      id: r.link.id,
      slug: r.link.slug,
      name: r.link.name,
      active: r.link.active,
      createdAt: r.link.createdAt.toISOString(),
      requestCount: Number(r.requests ?? 0),
    }));
  }

  async createCareLink(
    principal: Principal,
    input: { name: string; slug: string },
  ): Promise<CareLink> {
    const id = `dcl_${crypto.randomUUID()}`;
    try {
      await this.db.insert(driverCareLinks).values({
        id,
        companyId: principal.companyId,
        slug: input.slug,
        name: input.name,
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
          detail: `The address /care/${input.slug} is already taken. Choose another.`,
        });
      }
      throw error;
    }
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'driver_care_link',
      entityId: id,
      entityLabel: input.name,
      summary: `Driver Care link /care/${input.slug} created`,
    });
    const found = (await this.listCareLinks(principal)).find((l) => l.id === id);
    if (!found) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such link' });
    return found;
  }

  /**
   * Test data (owner, 2026-10-07): the request is kept and audited but left out of every list,
   * count, badge and thread; anything still waiting to go to Telegram is skipped.
   */
  async markTest(principal: Principal, requestNumber: string, reason: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(driverRelationRequests)
      .where(
        and(
          eq(driverRelationRequests.companyId, principal.companyId),
          eq(driverRelationRequests.requestNumber, requestNumber),
        ),
      );
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No request ${requestNumber}` });
    if (row.isTest) return;
    const at = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(driverRelationRequests)
        .set({
          isTest: true,
          testMarkedAt: at,
          testMarkedBy: principal.userName ?? principal.userId,
          testReason: reason,
          updatedAt: at,
        })
        .where(and(eq(driverRelationRequests.companyId, principal.companyId), eq(driverRelationRequests.id, row.id)));
      await tx
        .update(driverRelationOutbox)
        .set({ status: 'skipped', lastError: 'request marked as test data', updatedAt: at })
        .where(
          and(
            eq(driverRelationOutbox.companyId, principal.companyId),
            eq(driverRelationOutbox.requestId, row.id),
            or(eq(driverRelationOutbox.status, 'pending'), eq(driverRelationOutbox.status, 'failed')),
          ),
        );
    });
    await this.audit.write(principal, {
      action: 'mark_test',
      entityType: 'driver_relation_request',
      entityId: row.id,
      entityLabel: row.requestNumber,
      summary: `Driver Relations request ${row.requestNumber} marked as test data and hidden`,
      reason,
      changes: [{ field: 'isTest', old: 'false', new: 'true' }],
      at,
    });
  }

  async updateCareLink(
    principal: Principal,
    id: string,
    patch: { name?: string; active?: boolean },
  ): Promise<CareLink> {
    const before = (await this.listCareLinks(principal)).find((l) => l.id === id);
    if (!before) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such link' });
    await this.db
      .update(driverCareLinks)
      .set({ name: patch.name, active: patch.active, updatedAt: new Date() })
      .where(and(eq(driverCareLinks.companyId, principal.companyId), eq(driverCareLinks.id, id)));
    await this.audit.write(principal, {
      action: patch.active === false ? 'status_change' : 'update',
      entityType: 'driver_care_link',
      entityId: id,
      entityLabel: before.name,
      summary:
        patch.active === false
          ? `Driver Care link /care/${before.slug} switched off`
          : patch.active === true && !before.active
            ? `Driver Care link /care/${before.slug} switched on`
            : `Driver Care link /care/${before.slug} updated`,
      changes: [
        ...(patch.name !== undefined && patch.name !== before.name
          ? [{ field: 'name', old: before.name, new: patch.name }]
          : []),
        ...(patch.active !== undefined && patch.active !== before.active
          ? [{ field: 'active', old: String(before.active), new: String(patch.active) }]
          : []),
      ],
    });
    return (await this.listCareLinks(principal)).find((l) => l.id === id)!;
  }
}
