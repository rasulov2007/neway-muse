import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiConversationView, AiMessageView, AiUsageView, UpdateAiConversationInput } from '@neway/shared';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet, apiPatch, apiPost } from '@/lib/api-client';

/** NeWay AI's server calls. Every key carries the company, so switching company shows that company's chats. */
export function useAiKeys() {
  const companyId = useAccount()?.companyId ?? null;
  return {
    usage: ['ai', companyId, 'usage'] as const,
    conversations: ['ai', companyId, 'conversations'] as const,
    messages: (id: string | null) => ['ai', companyId, 'messages', id] as const,
  };
}

export function useCanUseAi(): boolean {
  return useAccount()?.permissions.includes('ai_assistant.use') ?? false;
}

export function useAiUsage(enabled = true) {
  const keys = useAiKeys();
  return useQuery({ queryKey: keys.usage, queryFn: () => apiGet<AiUsageView>('/ai/usage'), enabled, staleTime: 30_000 });
}

export function useAiConversations(enabled = true) {
  const keys = useAiKeys();
  return useQuery({ queryKey: keys.conversations, queryFn: () => apiGet<AiConversationView[]>('/ai/conversations'), enabled });
}

export function useAiMessages(id: string | null) {
  const keys = useAiKeys();
  return useQuery({ queryKey: keys.messages(id), queryFn: () => apiGet<AiMessageView[]>(`/ai/conversations/${encodeURIComponent(id!)}/messages`), enabled: Boolean(id) });
}

export function createConversation(model?: string) {
  return apiPost<AiConversationView>('/ai/conversations', model ? { model } : {});
}

export function updateConversation(id: string, input: UpdateAiConversationInput) {
  return apiPatch<AiConversationView>(`/ai/conversations/${encodeURIComponent(id)}`, input);
}

export function archiveConversation(id: string) {
  return apiPost<{ id: string }>(`/ai/conversations/${encodeURIComponent(id)}/archive`, {});
}

export interface SendResult {
  conversation: AiConversationView;
  messages: AiMessageView[];
  usage: AiUsageView;
}

export function sendMessage(id: string, body: { text: string; model?: string; attachmentFileIds: string[] }) {
  return apiPost<SendResult>(`/ai/conversations/${encodeURIComponent(id)}/messages`, body);
}

/** The browser ran the screen steps of a paused answer: their results, so NeWay AI carries on (or stops). */
export function postClientResults(id: string, body: { messageId: string; results: Array<{ tool_use_id: string; content: string; is_error: boolean }>; stop: boolean }) {
  return apiPost<SendResult>(`/ai/conversations/${encodeURIComponent(id)}/client-results`, body);
}

export function useProposalAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'confirm' | 'cancel' }) => apiPost<{ status: string; result?: string }>(`/ai/proposals/${encodeURIComponent(id)}/${action}`, {}),
    // An action changed records other screens show: refresh everything, not only the chat.
    onSettled: () => client.invalidateQueries(),
  });
}
