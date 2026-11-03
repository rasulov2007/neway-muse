import { z } from 'zod';

/**
 * Messages (mobile M4, docs/mobile/PLAN.md §C, API.md §8).
 *
 * A conversation belongs to one company and is linked to a load, a case (breakdown, Driver
 * Relations request, PTI), a department or a person. Participants are office users and/or roster
 * drivers. A department conversation is open to every office user holding that department's
 * permission; a driver only ever sees conversations they are a participant of.
 */

export const MESSAGE_DEPARTMENTS = ['dispatch', 'safety', 'fleet', 'accounting', 'driver_relations'] as const;
export type MessageDepartment = (typeof MESSAGE_DEPARTMENTS)[number];

/** The permission that opens a department's conversations (and that its notifications target). */
export const MESSAGE_DEPARTMENT_PERMISSION: Record<MessageDepartment, string> = {
  dispatch: 'dispatch.view',
  safety: 'safety.view',
  fleet: 'maintenance.view',
  accounting: 'accounting.view',
  driver_relations: 'driver_relations.view',
};

export const MESSAGE_DEPARTMENT_LABEL: Record<MessageDepartment, string> = {
  dispatch: 'Dispatch',
  safety: 'Safety',
  fleet: 'Fleet',
  accounting: 'Accounting',
  driver_relations: 'Driver Relations',
};

/** Every code that opens some department's conversations. */
export const MESSAGE_OFFICE_PERMISSIONS = Object.values(MESSAGE_DEPARTMENT_PERMISSION);

export const CONVERSATION_KINDS = ['load', 'case', 'department', 'direct'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

/** What a conversation may be linked to. `load` needs loads.view on the office side. */
export const CONVERSATION_SUBJECT_TYPES = ['load', 'breakdown', 'dr_request', 'pti'] as const;
export type ConversationSubjectType = (typeof CONVERSATION_SUBJECT_TYPES)[number];

export const MESSAGE_MAX_ATTACHMENTS = 10;
export const MESSAGE_MAX_BODY = 4000;

const subject = {
  subjectType: z.enum(CONVERSATION_SUBJECT_TYPES).nullable().optional(),
  subjectId: z.string().trim().min(1).max(120).nullable().optional(),
};

/** The driver starts a conversation with a department, optionally about their own load / case. */
export const DriverStartConversationSchema = z
  .object({
    department: z.enum(MESSAGE_DEPARTMENTS),
    ...subject,
    /** The first message (optional: the thread can be opened empty). */
    body: z.string().trim().max(MESSAGE_MAX_BODY).optional(),
    attachmentFileIds: z.array(z.string().min(1).max(120)).max(MESSAGE_MAX_ATTACHMENTS).optional(),
  })
  .refine((v) => !v.subjectType === !v.subjectId, { message: 'subjectType and subjectId go together' });
export type DriverStartConversationRequest = z.input<typeof DriverStartConversationSchema>;

/** The office starts (or reopens) a conversation with a driver. */
export const OfficeStartConversationSchema = z
  .object({
    department: z.enum(MESSAGE_DEPARTMENTS),
    /** Roster driver id or driver number. Optional for a load conversation (the load's driver). */
    driverId: z.string().trim().min(1).max(120).nullable().optional(),
    ...subject,
    title: z.string().trim().max(200).optional(),
    body: z.string().trim().max(MESSAGE_MAX_BODY).optional(),
    attachmentFileIds: z.array(z.string().min(1).max(120)).max(MESSAGE_MAX_ATTACHMENTS).optional(),
  })
  .refine((v) => !v.subjectType === !v.subjectId, { message: 'subjectType and subjectId go together' })
  .refine((v) => Boolean(v.driverId) || v.subjectType === 'load', { message: 'Name the driver, or a load that has one' });
export type OfficeStartConversationRequest = z.input<typeof OfficeStartConversationSchema>;

export const PostMessageSchema = z
  .object({
    body: z.string().trim().max(MESSAGE_MAX_BODY).default(''),
    attachmentFileIds: z.array(z.string().min(1).max(120)).max(MESSAGE_MAX_ATTACHMENTS).default([]),
  })
  .refine((v) => v.body.length > 0 || v.attachmentFileIds.length > 0, { message: 'Write something or attach a file' });
export type PostMessageRequest = z.input<typeof PostMessageSchema>;

/** sent = stored · received = someone on the other side can see it · read = they opened the thread after it. */
export type MessageDeliveryState = 'sent' | 'received' | 'read';

export interface MessageAttachment {
  fileId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface MessageView {
  id: string;
  conversationId: string;
  body: string;
  attachments: MessageAttachment[];
  sender: { kind: 'driver' | 'office'; name: string; isMe: boolean };
  createdAt: string;
  /** For the caller's own messages; null on messages from others. */
  state: MessageDeliveryState | null;
}

export interface ConversationSummary {
  id: string;
  kind: ConversationKind;
  department: MessageDepartment | null;
  departmentLabel: string | null;
  subject: { type: ConversationSubjectType; id: string; label: string } | null;
  title: string;
  /** The driver(s) in the conversation. */
  drivers: Array<{ id: string; name: string }>;
  lastMessage: { body: string; at: string; senderName: string; hasAttachments: boolean } | null;
  unread: number;
  /** The caller is a participant (false: visible through the department permission). */
  participant: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationsResponse {
  conversations: ConversationSummary[];
  /** Office: unread per department the caller may open. Driver: one entry, `all`. */
  unreadByDepartment: Record<string, number>;
  unread: number;
}

export interface ConversationThread {
  conversation: ConversationSummary;
  messages: MessageView[];
}

export interface MessageFileLink {
  url: string;
  expiresAt: string;
}
