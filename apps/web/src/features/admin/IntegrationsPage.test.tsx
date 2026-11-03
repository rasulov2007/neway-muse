import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INTEGRATION_PROVIDERS, PERMISSION_CODES, type IntegrationAccount } from '@neway/shared';
import { renderPage } from '@/features/common/test-router';
import { IntegrationsPage } from './IntegrationsPage';

/**
 * An account with no credential has nothing to Remove; Archive is how it leaves the list. It is
 * kept on record behind "Show archived", where Unarchive brings it back.
 */
const account = (over: Partial<IntegrationAccount>): IntegrationAccount => ({
  id: 'int_x',
  provider: 'rts',
  name: 'Old RTS account',
  category: 'accounting',
  status: 'not_configured',
  credentialHint: null,
  credentialUpdatedAt: null,
  config: { clientNumber: '101212REC' },
  externalName: '101212REC @ ftps.financial.rtspro.com',
  lastSyncAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastSummary: null,
  errorCount: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

let accounts: IntegrationAccount[] = [];
let posts: { path: string; body: unknown }[] = [];
const original = globalThis.fetch;

beforeEach(() => {
  accounts = [
    account({ id: 'int_old_rts' }),
    account({ id: 'int_samsara', provider: 'samsara', name: 'Samsara yard A', category: 'eld', status: 'connected', credentialHint: '••••••••ABCD', credentialUpdatedAt: '2026-10-01T00:00:00.000Z', config: {}, externalName: null }),
  ];
  posts = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, 'http://localhost').pathname.replace(/^\/api\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/admin/me') return reply({ permissions: [...PERMISSION_CODES] });
    if (path === '/admin/email') return reply({ configured: false });
    if (path === '/admin/integrations' && method === 'GET') {
      return reply({
        integrations: INTEGRATION_PROVIDERS.map((p) => ({
          ...p,
          accounts: accounts.filter((a) => a.provider === p.provider && a.status !== 'archived'),
          archivedAccounts: accounts.filter((a) => a.provider === p.provider && a.status === 'archived'),
        })),
        connectorsImplemented: true,
        note: 'What syncs.',
      });
    }
    const action = /^\/admin\/integrations\/accounts\/([^/]+)\/(archive|unarchive)$/.exec(path);
    if (action && method === 'POST') {
      posts.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      accounts = accounts.map((a) =>
        a.id === action[1] ? { ...a, status: action[2] === 'archive' ? 'archived' : 'not_configured' } : a,
      );
      const changed = accounts.find((a) => a.id === action[1])!;
      return reply({ account: changed }, 201);
    }
    return inner(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = original;
});

describe('integrations — archive an account', () => {
  it('offers Archive beside Add key only when no credential is stored', async () => {
    renderPage(<IntegrationsPage />, { routePath: '/', path: '/' });
    const name = await screen.findByText('Old RTS account');
    const row = name.closest('li')!;
    expect(within(row).getByRole('button', { name: 'Add key' })).toBeVisible();
    expect(within(row).getByRole('button', { name: 'Archive' })).toBeVisible();
    expect(within(row).queryByRole('button', { name: 'Remove' })).toBeNull();

    // An account with a key keeps Remove and has no Archive.
    const samsara = screen.getByText('Samsara yard A').closest('li')!;
    expect(within(samsara).getByRole('button', { name: 'Remove' })).toBeVisible();
    expect(within(samsara).queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('archives after a confirm, hides the account, and Show archived brings back Unarchive', async () => {
    const user = userEvent.setup();
    renderPage(<IntegrationsPage />, { routePath: '/', path: '/' });
    const row = (await screen.findByText('Old RTS account')).closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Archive' }));

    expect(await screen.findByText('Archive this account?')).toBeVisible();
    expect(screen.getByText('It is hidden from the list and kept on record.')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: /Reason/ }), 'Old account');
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(posts).toEqual([{ path: '/admin/integrations/accounts/int_old_rts/archive', body: { reason: 'Old account' } }]));
    await waitFor(() => expect(screen.queryByText('Old RTS account')).toBeNull());

    await user.click(await screen.findByRole('button', { name: 'Show archived (1)' }));
    const archived = (await screen.findByText('Old RTS account')).closest('li')!;
    await user.click(within(archived).getByRole('button', { name: 'Unarchive' }));
    await waitFor(() => expect(posts.at(-1)?.path).toBe('/admin/integrations/accounts/int_old_rts/unarchive'));
    // Back in the list, with Add key and Archive again.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Show archived/ })).toBeNull());
    expect(within((await screen.findByText('Old RTS account')).closest('li')!).getByRole('button', { name: 'Add key' })).toBeVisible();
  });
});
