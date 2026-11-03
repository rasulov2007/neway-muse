import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ConversationsResponse, ConversationThread } from '@neway/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  permissions: ['dispatch.view', 'loads.view'] as string[],
}));

vi.mock('@/lib/api-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-client')>()),
  apiGet: (path: string, params?: unknown, options?: unknown) => mocks.apiGet(path, params, options),
  apiPost: (path: string, body: unknown, options?: unknown) => mocks.apiPost(path, body, options),
}));
vi.mock('@/features/auth/auth-context', async (orig) => ({
  ...(await orig<typeof import('@/features/auth/auth-context')>()),
  useAccount: () => ({ name: 'Jane Dispatcher', permissions: mocks.permissions }),
}));

import { InboxPage, INBOX_POLL_MS } from './InboxPage';

const summary = {
  id: 'cnv_1',
  kind: 'load' as const,
  department: 'dispatch' as const,
  departmentLabel: 'Dispatch',
  subject: { type: 'load' as const, id: 'ld_1', label: 'Load 0244482' },
  title: 'Load 0244482',
  drivers: [{ id: 'drv_1', name: 'Mike Johnson' }],
  lastMessage: { body: 'Pulling over at exit 76.', at: '2026-10-27T14:14:00.000Z', senderName: 'Mike Johnson', hasAttachments: false },
  unread: 2,
  participant: false,
  createdAt: '2026-10-27T14:10:00.000Z',
  updatedAt: '2026-10-27T14:14:00.000Z',
};
const list: ConversationsResponse = { conversations: [summary], unreadByDepartment: { dispatch: 2 }, unread: 2 };
const thread: ConversationThread = {
  conversation: summary,
  messages: [
    {
      id: 'msg_1',
      conversationId: 'cnv_1',
      body: "I've got a tire air leak on the trailer.",
      attachments: [{ fileId: 'file_1', fileName: 'tire.jpg', contentType: 'image/jpeg', sizeBytes: 2048 }],
      sender: { kind: 'driver', name: 'Mike Johnson', isMe: false },
      createdAt: '2026-10-27T14:10:00.000Z',
      state: null,
    },
    {
      id: 'msg_2',
      conversationId: 'cnv_1',
      body: 'Roadside is on the way.',
      attachments: [],
      sender: { kind: 'office', name: 'Jane Dispatcher', isMe: true },
      createdAt: '2026-10-27T14:17:00.000Z',
      state: 'read',
    },
  ],
};

describe('InboxPage', () => {
  beforeEach(() => {
    mocks.apiGet.mockReset();
    mocks.apiPost.mockReset();
    mocks.permissions = ['dispatch.view', 'loads.view'];
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === '/conversations') return Promise.resolve(list);
      if (path === '/conversations/cnv_1/messages') return Promise.resolve(thread);
      if (path === '/conversations/cnv_1/files/file_1/link') return Promise.resolve({ url: '/api/v1/files/signed/x', expiresAt: '2026-10-27T15:00:00.000Z' });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    mocks.apiPost.mockImplementation((path: string) => {
      if (path === '/conversations/cnv_1/read') return Promise.resolve({ ok: true, readAt: '2026-10-27T14:20:00.000Z' });
      if (path === '/conversations/cnv_1/messages') return Promise.resolve({ ...thread.messages[1], id: 'msg_3', body: 'On my way' });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
  });

  it('says Loading… first, then lists conversations with the department tabs the account may open and unread counts', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mocks.apiGet.mockImplementation((path: string) => (path === '/conversations' ? gate.then(() => list) : Promise.reject(new Error(path))));
    renderPage(<InboxPage />, { routePath: '/inbox', path: '/inbox' });
    // Never a 0 or an empty list before the data arrives.
    await waitFor(() => expect(screen.getByText('Loading…')).toBeInTheDocument());
    expect(screen.queryByText('No conversations')).toBeNull();
    release();
    expect(await screen.findByText('Load 0244482')).toBeInTheDocument();
    const tabs = screen.getByRole('tablist', { name: 'Departments' });
    expect(within(tabs).getByRole('tab', { name: /Dispatch/ })).toBeInTheDocument();
    // No safety.view / accounting.view: those departments are not offered.
    expect(within(tabs).queryByRole('tab', { name: /Safety/ })).toBeNull();
    expect(within(tabs).queryByRole('tab', { name: /Accounting/ })).toBeNull();
    expect(screen.getByText('2 new')).toBeInTheDocument();
    expect(INBOX_POLL_MS).toBe(15_000);
    // Polls: the list query carries the 15 s refetch.
    expect(mocks.apiGet).toHaveBeenCalledWith('/conversations', undefined, { background: true });
  });

  it('opens a thread, marks it read, shows the read state of my message and replies with an idempotency key', async () => {
    renderPage(<InboxPage />, { routePath: '/inbox', path: '/inbox?c=cnv_1' });
    expect(await screen.findByText("I've got a tire air leak on the trailer.")).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tire\.jpg/ })).toBeInTheDocument();
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/conversations/cnv_1/read', {}, undefined));

    const send = screen.getByRole('button', { name: /Send/ });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'On my way' } });
    fireEvent.click(send);
    await waitFor(() =>
      expect(mocks.apiPost).toHaveBeenCalledWith(
        '/conversations/cnv_1/messages',
        { body: 'On my way', attachmentFileIds: [] },
        { headers: { 'Idempotency-Key': expect.any(String) } },
      ),
    );
  });

  it('opens an attachment through the conversation file link', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({ location: { href: '' }, close: vi.fn() } as unknown as Window);
    renderPage(<InboxPage />, { routePath: '/inbox', path: '/inbox?c=cnv_1' });
    fireEvent.click(await screen.findByRole('button', { name: /tire\.jpg/ }));
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledWith('/conversations/cnv_1/files/file_1/link', undefined, { background: true }));
    open.mockRestore();
  });
});
