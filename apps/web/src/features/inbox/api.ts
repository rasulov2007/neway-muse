import type { ConversationsResponse, ConversationThread, MessageDepartment, MessageFileLink, MessageView } from '@neway/shared';
import { apiGet, apiPost } from '@/lib/api-client';

/** The office inbox (docs/mobile/API.md §8): the same conversations the driver app writes to. */

export function listConversations(department?: MessageDepartment | null): Promise<ConversationsResponse> {
  return apiGet<ConversationsResponse>('/conversations', department ? { department } : undefined, { background: true });
}

export function getThread(id: string): Promise<ConversationThread> {
  return apiGet<ConversationThread>(`/conversations/${encodeURIComponent(id)}/messages`, undefined, { background: true });
}

export function postMessage(id: string, body: string, attachmentFileIds: string[], idempotencyKey: string): Promise<MessageView> {
  return apiPost<MessageView>(`/conversations/${encodeURIComponent(id)}/messages`, { body, attachmentFileIds }, { headers: { 'Idempotency-Key': idempotencyKey } });
}

export function markConversationRead(id: string): Promise<{ ok: true; readAt: string }> {
  return apiPost(`/conversations/${encodeURIComponent(id)}/read`, {});
}

/** Find-or-create the Dispatch conversation of a load with its driver (the load page's Message driver). */
export function openLoadConversation(loadId: string): Promise<ConversationThread> {
  return apiPost<ConversationThread>('/conversations', { department: 'dispatch', subjectType: 'load', subjectId: loadId });
}

export function attachmentLink(conversationId: string, fileId: string): Promise<MessageFileLink> {
  return apiGet<MessageFileLink>(`/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(fileId)}/link`, undefined, { background: true });
}
