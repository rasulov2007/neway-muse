import { Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  MESSAGE_DEPARTMENT_LABEL,
  MESSAGE_DEPARTMENT_PERMISSION,
  MESSAGE_DEPARTMENTS,
  type ConversationKind,
  type ConversationsResponse,
  type ConversationSubjectType,
  type ConversationSummary,
  type ConversationThread,
  type MessageAttachment,
  type MessageDeliveryState,
  type MessageDepartment,
  type MessageFileLink,
  type MessageView,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { users } from '../../database/schema/admin';
import { driverRelationRequests } from '../../database/schema/driver-relations';
import { storedFiles } from '../../database/schema/files';
import { loads as loadsTable } from '../../database/schema/loads';
import { conversationParticipants, conversations, fleetBreakdowns, messages } from '../../database/schema/mobile';
import { ptiInspections } from '../../database/schema/pti';
import { drivers } from '../../database/schema/roster';
import { SIGNED_LINK_TTL_MS, signFileLink } from '../files/file-access';
import { FilesService } from '../files/files.service';
import { MobileNotificationsService } from '../mobile/mobile-notifications.service';
import { MessageAudienceService } from './message-audience.service';

type ConversationRow = typeof conversations.$inferSelect;
type ParticipantRow = typeof conversationParticipants.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

/** Who is reading or writing: an office account, or the driver resolved from the session. */
export type Viewer = { side: 'office'; principal: Principal } | { side: 'driver'; principal: Principal; driverId: string; driverName: string };

export interface StartInput {
  department: MessageDepartment;
  subjectType?: ConversationSubjectType | null;
  subjectId?: string | null;
  driverId?: string | null;
  title?: string;
}

export interface PostInput {
  body: string;
  attachmentFileIds: string[];
  idempotencyKey?: string | null;
}

const notFound = () => new AppError({ status: 404, title: 'Not Found', detail: 'No such conversation.' });
const forbidden = (detail: string) => new AppError({ status: 403, title: 'Forbidden', detail });
const unprocessable = (detail: string) => new AppError({ status: 422, title: 'Unprocessable Entity', detail });

const SUBJECT_LABEL: Record<ConversationSubjectType, string> = { load: 'Load', breakdown: 'Breakdown', dr_request: 'Driver Care request', pti: 'PTI' };

/**
 * Conversations and messages (mobile M4, PLAN §C). One service for both sides:
 *
 * - a driver sees only conversations they are a participant of, and may link a new one only to
 *   their own load / breakdown / Driver Care request / PTI;
 * - an office user sees conversations they take part in, plus the conversations of every
 *   department whose permission they hold (load conversations also need loads.view);
 * - a new message writes a notification row for each person it is for (the other participants;
 *   for a driver's message, that department's permission holders too), then a push whose text never
 *   carries the message.
 *
 * Read state is `conversation_participants.last_read_at`; sent / received / read are derived from it.
 */
@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly files: FilesService,
    private readonly notifications: MobileNotificationsService,
    private readonly audience: MessageAudienceService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ------------------------------------------------------------------------------- access

  /** The departments this office principal may open and answer for. */
  departmentsOf(principal: Principal): MessageDepartment[] {
    if (principal.driverId) return [];
    return MESSAGE_DEPARTMENTS.filter((d) => hasPermission(principal, MESSAGE_DEPARTMENT_PERMISSION[d]));
  }

  private requiredCodes(conversation: Pick<ConversationRow, 'department' | 'subjectType'>): string[] {
    const dept = conversation.department as MessageDepartment | null;
    if (!dept || !(MESSAGE_DEPARTMENTS as readonly string[]).includes(dept)) return [];
    const codes = [MESSAGE_DEPARTMENT_PERMISSION[dept]];
    if (conversation.subjectType === 'load') codes.push('loads.view');
    return codes;
  }

  /** May this office principal open it through its department (not as a participant)? */
  private departmentAdmits(principal: Principal, conversation: ConversationRow): boolean {
    const codes = this.requiredCodes(conversation);
    return codes.length > 0 && codes.every((c) => hasPermission(principal, c));
  }

  private async participants(conversationIds: string[]): Promise<ParticipantRow[]> {
    if (conversationIds.length === 0) return [];
    return this.db
      .select()
      .from(conversationParticipants)
      .where(and(inArray(conversationParticipants.conversationId, conversationIds), isNull(conversationParticipants.leftAt)));
  }

  private isMe(viewer: Viewer, p: Pick<ParticipantRow, 'userId' | 'driverId'>): boolean {
    return viewer.side === 'driver' ? p.driverId === viewer.driverId : p.userId === viewer.principal.userId;
  }

  /** The conversation, when the viewer may open it; 404 otherwise (another company, not theirs). */
  async open(viewer: Viewer, id: string): Promise<{ conversation: ConversationRow; participants: ParticipantRow[] }> {
    const [conversation] = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.companyId, viewer.principal.companyId), eq(conversations.id, id), isNull(conversations.archivedAt)))
      .limit(1);
    if (!conversation) throw notFound();
    const participants = await this.participants([conversation.id]);
    const participant = participants.some((p) => this.isMe(viewer, p));
    if (viewer.side === 'driver') {
      if (!participant) throw notFound();
    } else if (!participant && !this.departmentAdmits(viewer.principal, conversation)) {
      // It exists in this company: say it is not theirs to open rather than pretend it is absent.
      throw forbidden(`This conversation belongs to ${conversation.department ? MESSAGE_DEPARTMENT_LABEL[conversation.department as MessageDepartment] : 'its participants'}.`);
    }
    return { conversation, participants };
  }

  // -------------------------------------------------------------------------------- lists

  async list(viewer: Viewer, filter: { scope?: 'mine' | 'department' | 'all'; department?: string; subjectType?: string; subjectId?: string } = {}): Promise<ConversationsResponse> {
    const companyId = viewer.principal.companyId;
    let rows: ConversationRow[];
    if (viewer.side === 'driver') {
      const mine = this.db
        .select({ id: conversationParticipants.conversationId })
        .from(conversationParticipants)
        .where(and(eq(conversationParticipants.companyId, companyId), eq(conversationParticipants.driverId, viewer.driverId), isNull(conversationParticipants.leftAt)));
      rows = await this.db
        .select()
        .from(conversations)
        .where(and(eq(conversations.companyId, companyId), isNull(conversations.archivedAt), inArray(conversations.id, mine)))
        .orderBy(desc(conversations.updatedAt))
        .limit(200);
    } else {
      const principal = viewer.principal;
      let departments = this.departmentsOf(principal);
      if (filter.department) {
        if (!(MESSAGE_DEPARTMENTS as readonly string[]).includes(filter.department)) throw unprocessable(`department must be one of ${MESSAGE_DEPARTMENTS.join(', ')}`);
        if (!departments.includes(filter.department as MessageDepartment)) throw forbidden(`You do not have ${MESSAGE_DEPARTMENT_PERMISSION[filter.department as MessageDepartment]}.`);
        departments = [filter.department as MessageDepartment];
      }
      const scope = filter.scope ?? 'all';
      const mine = this.db
        .select({ id: conversationParticipants.conversationId })
        .from(conversationParticipants)
        .where(and(eq(conversationParticipants.companyId, companyId), eq(conversationParticipants.userId, principal.userId), isNull(conversationParticipants.leftAt)));
      const byDepartment = departments.length > 0 ? inArray(conversations.department, departments) : sql`false`;
      const reach = scope === 'mine' ? inArray(conversations.id, mine) : scope === 'department' ? byDepartment : or(inArray(conversations.id, mine), byDepartment);
      const subject = filter.subjectType && filter.subjectId ? and(eq(conversations.subjectType, filter.subjectType), eq(conversations.subjectId, filter.subjectId)) : undefined;
      const fetched = await this.db
        .select()
        .from(conversations)
        .where(and(eq(conversations.companyId, companyId), isNull(conversations.archivedAt), reach, subject, filter.department ? eq(conversations.department, filter.department) : undefined))
        .orderBy(desc(conversations.updatedAt))
        .limit(200);
      const participantRows = await this.participants(fetched.map((c) => c.id));
      const mineIds = new Set(participantRows.filter((p) => p.userId === principal.userId).map((p) => p.conversationId));
      // A load conversation reached through the department also needs loads.view.
      rows = fetched.filter((c) => (scope !== 'department' && mineIds.has(c.id)) || this.departmentAdmits(principal, c));
    }
    const summaries = await this.summaries(viewer, rows);
    const unreadByDepartment: Record<string, number> = {};
    for (const s of summaries) {
      const key = viewer.side === 'driver' ? 'all' : (s.department ?? 'direct');
      unreadByDepartment[key] = (unreadByDepartment[key] ?? 0) + s.unread;
    }
    if (viewer.side === 'office') for (const d of this.departmentsOf(viewer.principal)) unreadByDepartment[d] ??= 0;
    return { conversations: summaries, unreadByDepartment, unread: summaries.reduce((n, s) => n + s.unread, 0) };
  }

  private async summaries(viewer: Viewer, rows: ConversationRow[]): Promise<ConversationSummary[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const participantRows = await this.participants(ids);
    const driverIds = [...new Set(participantRows.map((p) => p.driverId).filter((d): d is string => Boolean(d)))];
    const driverNames = await this.driverNames(viewer.principal.companyId, driverIds);
    const last = await this.db
      .selectDistinctOn([messages.conversationId], {
        conversationId: messages.conversationId,
        body: messages.body,
        createdAt: messages.createdAt,
        senderUserId: messages.senderUserId,
        senderDriverId: messages.senderDriverId,
        attachments: messages.attachments,
      })
      .from(messages)
      .where(and(inArray(messages.conversationId, ids), isNull(messages.voidedAt)))
      .orderBy(messages.conversationId, desc(messages.createdAt));
    const userNames = await this.userNames(last.map((m) => m.senderUserId).filter((u): u is string => Boolean(u)));
    const unread = await this.unreadCounts(viewer, ids);
    return rows.map((row) => {
      const parts = participantRows.filter((p) => p.conversationId === row.id);
      const m = last.find((l) => l.conversationId === row.id);
      return {
        ...this.head(row, viewer, parts, driverNames),
        lastMessage: m
          ? {
              body: m.body,
              at: m.createdAt.toISOString(),
              senderName: m.senderDriverId ? (driverNames.get(m.senderDriverId) ?? 'Driver') : (userNames.get(m.senderUserId ?? '') ?? 'Office'),
              hasAttachments: Array.isArray(m.attachments) && (m.attachments as unknown[]).length > 0,
            }
          : null,
        unread: unread.get(row.id) ?? 0,
      };
    });
  }

  private head(row: ConversationRow, viewer: Viewer, parts: ParticipantRow[], driverNames: Map<string, string>): Omit<ConversationSummary, 'lastMessage' | 'unread'> {
    const dept = (row.department as MessageDepartment | null) ?? null;
    const subjectType = row.subjectType as ConversationSubjectType | null;
    return {
      id: row.id,
      kind: row.kind as ConversationKind,
      department: dept,
      departmentLabel: dept ? MESSAGE_DEPARTMENT_LABEL[dept] : null,
      subject: subjectType && row.subjectId ? { type: subjectType, id: row.subjectId, label: row.title || `${SUBJECT_LABEL[subjectType]} ${row.subjectId}` } : null,
      title: row.title,
      drivers: parts.filter((p) => p.driverId).map((p) => ({ id: p.driverId!, name: driverNames.get(p.driverId!) ?? 'Driver' })),
      participant: parts.some((p) => this.isMe(viewer, p)),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Messages from others after the viewer's last read, per conversation. */
  private async unreadCounts(viewer: Viewer, ids: string[]): Promise<Map<string, number>> {
    const me = viewer.side === 'driver' ? sql`p.driver_id = ${viewer.driverId}` : sql`p.user_id = ${viewer.principal.userId}`;
    const fromOthers = viewer.side === 'driver' ? sql`m.sender_driver_id is distinct from ${viewer.driverId}` : sql`m.sender_user_id is distinct from ${viewer.principal.userId}`;
    const rows = (await this.db.execute(sql`
      select m.conversation_id, count(*)::int as n
        from messages m
        left join conversation_participants p on p.conversation_id = m.conversation_id and p.left_at is null and ${me}
       where m.company_id = ${viewer.principal.companyId}
         and m.conversation_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
         and m.voided_at is null and ${fromOthers}
         and (p.last_read_at is null or m.created_at > p.last_read_at)
       group by m.conversation_id`)) as unknown as Array<{ conversation_id: string; n: number }>;
    return new Map(rows.map((r) => [r.conversation_id, Number(r.n)]));
  }

  private async driverNames(companyId: string, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: drivers.id, firstName: drivers.firstName, lastName: drivers.lastName })
      .from(drivers)
      .where(and(eq(drivers.companyId, companyId), inArray(drivers.id, ids)));
    return new Map(rows.map((r) => [r.id, `${r.firstName} ${r.lastName}`.trim()]));
  }

  private async userNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(inArray(users.id, unique));
    return new Map(rows.map((r) => [r.id, `${r.firstName} ${r.lastName}`.trim()]));
  }

  // ------------------------------------------------------------------------------- thread

  async thread(viewer: Viewer, id: string): Promise<ConversationThread> {
    const { conversation, participants } = await this.open(viewer, id);
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversation.id), eq(messages.companyId, viewer.principal.companyId), isNull(messages.voidedAt)))
      .orderBy(desc(messages.createdAt))
      .limit(200);
    rows.reverse();
    const [summary] = await this.summaries(viewer, [conversation]);
    return { conversation: summary!, messages: await this.views(viewer, conversation, participants, rows) };
  }

  private async views(viewer: Viewer, conversation: ConversationRow, participants: ParticipantRow[], rows: MessageRow[]): Promise<MessageView[]> {
    const driverNames = await this.driverNames(
      conversation.companyId,
      [...new Set([...participants.map((p) => p.driverId), ...rows.map((r) => r.senderDriverId)].filter((d): d is string => Boolean(d)))],
    );
    const userNames = await this.userNames(rows.map((r) => r.senderUserId).filter((u): u is string => Boolean(u)));
    const fileIds = [...new Set(rows.flatMap((r) => (Array.isArray(r.attachments) ? (r.attachments as string[]) : [])))];
    const fileRows = fileIds.length
      ? await this.db
          .select({ id: storedFiles.id, fileName: storedFiles.fileName, contentType: storedFiles.contentType, sizeBytes: storedFiles.sizeBytes })
          .from(storedFiles)
          .where(and(eq(storedFiles.companyId, conversation.companyId), inArray(storedFiles.id, fileIds)))
      : [];
    const fileMap = new Map(fileRows.map((f) => [f.id, f]));
    // The other side's reads: for the driver, the office participants; for the office, the drivers.
    const otherSide = participants.filter((p) => (viewer.side === 'driver' ? p.userId !== null : p.driverId !== null));
    const otherReads = otherSide.map((p) => p.lastReadAt?.getTime() ?? 0);
    const driverReachable =
      viewer.side === 'office'
        ? (await Promise.all(participants.filter((p) => p.driverId).map((p) => this.notifications.driverUserIds(conversation.companyId, p.driverId!)))).some((u) => u.length > 0)
        : true;
    return rows.map((r) => {
      const mine = viewer.side === 'driver' ? r.senderDriverId === viewer.driverId : r.senderUserId === viewer.principal.userId;
      let state: MessageDeliveryState | null = null;
      if (mine) {
        const at = r.createdAt.getTime();
        if (otherReads.some((t) => t >= at)) state = 'read';
        else if (viewer.side === 'driver' || driverReachable) state = 'received';
        else state = 'sent';
      }
      return {
        id: r.id,
        conversationId: r.conversationId,
        body: r.body,
        attachments: (Array.isArray(r.attachments) ? (r.attachments as string[]) : [])
          .map((fid) => fileMap.get(fid))
          .filter((f): f is NonNullable<typeof f> => Boolean(f))
          .map((f): MessageAttachment => ({ fileId: f.id, fileName: f.fileName, contentType: f.contentType, sizeBytes: f.sizeBytes })),
        sender: r.senderDriverId
          ? { kind: 'driver', name: driverNames.get(r.senderDriverId) ?? 'Driver', isMe: mine }
          : { kind: 'office', name: userNames.get(r.senderUserId ?? '') ?? 'Office', isMe: mine },
        createdAt: r.createdAt.toISOString(),
        state,
      };
    });
  }

  // -------------------------------------------------------------------------------- start

  /**
   * Finds the open conversation for (department, subject, driver), or makes it. A driver may link
   * only their own records; the office needs the department's permission (and loads.view for a load).
   */
  async start(viewer: Viewer, input: StartInput): Promise<ConversationRow> {
    const companyId = viewer.principal.companyId;
    const department = input.department;
    let driverId: string;
    let title = input.title?.trim() || '';
    const subjectType = input.subjectType ?? null;
    let subjectId = input.subjectId?.trim() || null;

    if (viewer.side === 'office') {
      const principal = viewer.principal;
      if (!hasPermission(principal, MESSAGE_DEPARTMENT_PERMISSION[department])) throw forbidden(`Messaging for ${MESSAGE_DEPARTMENT_LABEL[department]} needs ${MESSAGE_DEPARTMENT_PERMISSION[department]}.`);
      if (subjectType === 'load' && !hasPermission(principal, 'loads.view')) throw forbidden('A load conversation needs loads.view.');
    }

    if (subjectType === 'load' && subjectId) {
      const [load] = await this.db
        .select({ id: loadsTable.id, loadNumber: loadsTable.loadNumber, driverId: loadsTable.driverId })
        .from(loadsTable)
        .where(and(eq(loadsTable.companyId, companyId), or(eq(loadsTable.id, subjectId), eq(loadsTable.loadNumber, subjectId))))
        .limit(1);
      if (!load) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such load.' });
      if (viewer.side === 'driver' && load.driverId !== viewer.driverId) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such load.' });
      subjectId = load.id;
      title ||= `Load ${load.loadNumber}`;
      if (viewer.side === 'driver') driverId = viewer.driverId;
      else {
        const named = input.driverId ? await this.resolveDriver(companyId, input.driverId) : null;
        if (named && load.driverId && named !== load.driverId) throw unprocessable('That driver is not on this load.');
        const resolved = named ?? load.driverId;
        if (!resolved) throw unprocessable('This load has no driver yet.');
        driverId = resolved;
      }
    } else {
      if (viewer.side === 'driver') driverId = viewer.driverId;
      else {
        if (!input.driverId) throw unprocessable('Name the driver.');
        driverId = await this.resolveDriver(companyId, input.driverId);
      }
      if (subjectType && subjectId) {
        const owner = await this.caseDriver(viewer, companyId, subjectType, subjectId);
        if (owner === undefined || (viewer.side === 'driver' && owner !== viewer.driverId)) throw new AppError({ status: 404, title: 'Not Found', detail: `No such ${SUBJECT_LABEL[subjectType].toLowerCase()}.` });
        title ||= `${SUBJECT_LABEL[subjectType]} ${subjectId}`;
      }
    }

    const existing = await this.db
      .select({ conversation: conversations })
      .from(conversations)
      .innerJoin(conversationParticipants, and(eq(conversationParticipants.conversationId, conversations.id), eq(conversationParticipants.driverId, driverId), isNull(conversationParticipants.leftAt)))
      .where(
        and(
          eq(conversations.companyId, companyId),
          eq(conversations.department, department),
          isNull(conversations.archivedAt),
          subjectType && subjectId ? and(eq(conversations.subjectType, subjectType), eq(conversations.subjectId, subjectId)) : and(isNull(conversations.subjectType), isNull(conversations.subjectId)),
        ),
      )
      .orderBy(asc(conversations.createdAt))
      .limit(1);
    let conversation = existing[0]?.conversation;
    if (!conversation) {
      const driverName = (await this.driverNames(companyId, [driverId])).get(driverId) ?? 'Driver';
      const now = new Date();
      const kind: ConversationKind = subjectType === 'load' ? 'load' : subjectType ? 'case' : 'department';
      [conversation] = await this.db
        .insert(conversations)
        .values({
          id: `cnv_${crypto.randomUUID()}`,
          companyId,
          kind,
          subjectType,
          subjectId,
          department,
          title: title || `${driverName} · ${MESSAGE_DEPARTMENT_LABEL[department]}`,
          createdByUserId: viewer.principal.userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await this.db.insert(conversationParticipants).values({ id: `cnp_${crypto.randomUUID()}`, companyId, conversationId: conversation!.id, driverId, role: 'driver', joinedAt: now });
    }
    if (viewer.side === 'office') await this.join(viewer.principal, conversation!.id, 'member');
    return conversation!;
  }

  /** The driver a case belongs to; undefined when the case is not in this company (or not reachable). */
  private async caseDriver(viewer: Viewer, companyId: string, type: ConversationSubjectType, id: string): Promise<string | null | undefined> {
    const p = viewer.principal;
    const office = viewer.side === 'office';
    if (type === 'pti') {
      if (office && !hasPermission(p, 'maintenance.view') && !hasPermission(p, 'safety.view')) throw forbidden('A PTI conversation needs maintenance.view or safety.view.');
      const [row] = await this.db.select({ driverId: ptiInspections.driverId }).from(ptiInspections).where(and(eq(ptiInspections.companyId, companyId), eq(ptiInspections.id, id))).limit(1);
      return row ? row.driverId : undefined;
    }
    if (type === 'breakdown') {
      if (office && !hasPermission(p, 'maintenance.view') && !hasPermission(p, 'dispatch.view')) throw forbidden('A breakdown conversation needs maintenance.view or dispatch.view.');
      const [row] = await this.db
        .select({ driverId: fleetBreakdowns.driverId })
        .from(fleetBreakdowns)
        .where(and(eq(fleetBreakdowns.companyId, companyId), or(eq(fleetBreakdowns.id, id), eq(fleetBreakdowns.number, id)), isNull(fleetBreakdowns.voidedAt)))
        .limit(1);
      return row ? row.driverId : undefined;
    }
    if (type === 'dr_request') {
      if (office && !hasPermission(p, 'driver_relations.view')) throw forbidden('A Driver Care conversation needs driver_relations.view.');
      const [row] = await this.db
        .select({ driverId: driverRelationRequests.driverId })
        .from(driverRelationRequests)
        .where(and(eq(driverRelationRequests.companyId, companyId), eq(driverRelationRequests.id, id)))
        .limit(1);
      return row ? row.driverId : undefined;
    }
    return undefined;
  }

  private async resolveDriver(companyId: string, idOrNumber: string): Promise<string> {
    const [row] = await this.db
      .select({ id: drivers.id })
      .from(drivers)
      .where(and(eq(drivers.companyId, companyId), or(eq(drivers.id, idOrNumber), eq(drivers.driverNumber, idOrNumber)), isNull(drivers.archivedAt)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such driver.' });
    return row.id;
  }

  /** Makes the office user a participant (or upgrades a reader to a member). */
  private async join(principal: Principal, conversationId: string, role: 'member' | 'reader', readAt?: Date): Promise<void> {
    const [row] = await this.db
      .select()
      .from(conversationParticipants)
      .where(and(eq(conversationParticipants.conversationId, conversationId), eq(conversationParticipants.userId, principal.userId), isNull(conversationParticipants.leftAt)))
      .limit(1);
    if (!row) {
      await this.db.insert(conversationParticipants).values({
        id: `cnp_${crypto.randomUUID()}`,
        companyId: principal.companyId,
        conversationId,
        userId: principal.userId,
        role,
        lastReadAt: readAt ?? null,
      });
      return;
    }
    const patch: Partial<ParticipantRow> = {};
    if (role === 'member' && row.role === 'reader') patch.role = 'member';
    if (readAt && (!row.lastReadAt || row.lastReadAt < readAt)) patch.lastReadAt = readAt;
    if (Object.keys(patch).length) await this.db.update(conversationParticipants).set(patch).where(eq(conversationParticipants.id, row.id));
  }

  // --------------------------------------------------------------------------------- post

  async post(viewer: Viewer, id: string, input: PostInput): Promise<MessageView> {
    const { conversation, participants } = await this.open(viewer, id);
    const companyId = viewer.principal.companyId;
    const body = (input.body ?? '').trim();
    const fileIds = [...new Set(input.attachmentFileIds ?? [])];
    if (!body && fileIds.length === 0) throw unprocessable('Write something or attach a file.');
    const key = input.idempotencyKey?.trim() || null;
    if (key) {
      const [again] = await this.db
        .select()
        .from(messages)
        .where(and(eq(messages.companyId, companyId), eq(messages.conversationId, conversation.id), eq(messages.idempotencyKey, key)))
        .limit(1);
      if (again) return (await this.views(viewer, conversation, participants, [again]))[0]!;
    }
    await this.checkAttachments(viewer, fileIds);

    const now = new Date();
    const [row] = await this.db
      .insert(messages)
      .values({
        id: `msg_${crypto.randomUUID()}`,
        companyId,
        conversationId: conversation.id,
        senderUserId: viewer.side === 'office' ? viewer.principal.userId : null,
        senderDriverId: viewer.side === 'driver' ? viewer.driverId : null,
        body,
        attachments: fileIds,
        idempotencyKey: key,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      // A concurrent retry with the same key won: answer with its message.
      const [again] = await this.db.select().from(messages).where(and(eq(messages.companyId, companyId), eq(messages.conversationId, conversation.id), eq(messages.idempotencyKey, key ?? ''))).limit(1);
      if (!again) throw new AppError({ status: 409, title: 'Conflict', detail: 'That message is being sent. Try again in a moment.' });
      return (await this.views(viewer, conversation, participants, [again]))[0]!;
    }
    await this.db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, conversation.id));
    // The sender has seen their own message.
    if (viewer.side === 'office') await this.join(viewer.principal, conversation.id, 'member', now);
    else {
      await this.db
        .update(conversationParticipants)
        .set({ lastReadAt: now })
        .where(and(eq(conversationParticipants.conversationId, conversation.id), eq(conversationParticipants.driverId, viewer.driverId), isNull(conversationParticipants.leftAt)));
    }
    await this.notify(viewer, conversation, row);
    const fresh = await this.participants([conversation.id]);
    return (await this.views(viewer, conversation, fresh, [row]))[0]!;
  }

  /**
   * Attachments are stored files of this company: a driver's own uploads (POST /driver/files), or
   * for the office its own uploads or any file it may already open.
   */
  async checkAttachments(viewer: Viewer, fileIds: string[]): Promise<void> {
    if (fileIds.length === 0) return;
    const rows = await this.db
      .select()
      .from(storedFiles)
      .where(and(eq(storedFiles.companyId, viewer.principal.companyId), inArray(storedFiles.id, fileIds), isNull(storedFiles.deletedAt)));
    for (const fid of fileIds) {
      const row = rows.find((r) => r.id === fid);
      if (!row) throw unprocessable(`Attachment ${fid} is not a file of this company.`);
      if (row.uploadedBy === viewer.principal.userId) continue;
      if (viewer.side === 'driver') throw unprocessable(`Attachment ${fid} was not uploaded by you.`);
      await this.files.assertMayOpen(viewer.principal, row);
    }
  }

  /**
   * The notification rows (then pushes) for a new message. A driver's message reaches the office
   * participants and the department's permission holders; an office message reaches the driver(s)
   * and the other office participants. The push text never carries the message.
   */
  private async notify(viewer: Viewer, conversation: ConversationRow, message: MessageRow): Promise<void> {
    const companyId = conversation.companyId;
    const participants = await this.participants([conversation.id]);
    const codes = this.requiredCodes(conversation);
    const holders = new Set(codes.length ? await this.audience.usersHoldingAll(companyId, codes) : []);
    const officeMembers = participants.filter((p) => p.userId && p.role !== 'reader').map((p) => p.userId!);
    const recipients = new Set<string>();
    // Office participants still need the department (a person who lost the permission is not told).
    for (const u of officeMembers) if (codes.length === 0 || holders.has(u)) recipients.add(u);
    if (viewer.side === 'driver') for (const u of holders) recipients.add(u);
    else for (const p of participants.filter((x) => x.driverId)) for (const u of await this.notifications.driverUserIds(companyId, p.driverId!)) recipients.add(u);
    recipients.delete(viewer.principal.userId);

    const dept = conversation.department ? MESSAGE_DEPARTMENT_LABEL[conversation.department as MessageDepartment] : 'the office';
    const fromDriver = viewer.side === 'driver';
    const senderName = fromDriver ? viewer.driverName : (viewer.principal.userName ?? 'Office');
    for (const userId of recipients) {
      const toDriverAccount = !holders.has(userId) && !officeMembers.includes(userId);
      try {
        await this.notifications.notify(companyId, userId, {
          title: fromDriver ? `New message from ${senderName}` : toDriverAccount ? `New message from ${dept}` : `New message from ${senderName}`,
          // Where it is, never what it says.
          body: conversation.title || null,
          pushTitle: 'New message',
          pushBody: toDriverAccount ? `${dept} sent you a message.` : fromDriver ? `A driver sent a message to ${dept}.` : `New message in a ${dept} conversation.`,
          severity: 'info',
          target: { type: 'conversation', id: conversation.id },
          dedupeKey: `msg:${message.id}:${userId}`,
        });
      } catch (error) {
        this.logger.warn(`Could not notify ${userId} about ${message.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // --------------------------------------------------------------------------------- read

  async markRead(viewer: Viewer, id: string): Promise<{ ok: true; readAt: string }> {
    const { conversation } = await this.open(viewer, id);
    const now = new Date();
    if (viewer.side === 'office') await this.join(viewer.principal, conversation.id, 'reader', now);
    else {
      await this.db
        .update(conversationParticipants)
        .set({ lastReadAt: now })
        .where(and(eq(conversationParticipants.conversationId, conversation.id), eq(conversationParticipants.driverId, viewer.driverId), isNull(conversationParticipants.leftAt)));
    }
    return { ok: true, readAt: now.toISOString() };
  }

  // ---------------------------------------------------------------------------- file link

  /** A five-minute link to a file attached to a message of a conversation the viewer may open. */
  async fileLink(viewer: Viewer, id: string, fileId: string): Promise<MessageFileLink> {
    const { conversation } = await this.open(viewer, id);
    const [hit] = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, conversation.id), eq(messages.companyId, conversation.companyId), isNull(messages.voidedAt), sql`${messages.attachments} @> ${JSON.stringify([fileId])}::jsonb`))
      .limit(1);
    if (!hit) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such file in this conversation.' });
    const [file] = await this.db
      .select({ id: storedFiles.id })
      .from(storedFiles)
      .where(and(eq(storedFiles.companyId, conversation.companyId), eq(storedFiles.id, fileId), isNull(storedFiles.deletedAt)))
      .limit(1);
    if (!file) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such file in this conversation.' });
    const expires = Date.now() + SIGNED_LINK_TTL_MS;
    const token = signFileLink(env.APP_SECRET, { f: file.id, c: conversation.companyId, u: viewer.principal.userId, e: expires });
    return { url: FilesService.signedUrlFor(token), expiresAt: new Date(expires).toISOString() };
  }
}
