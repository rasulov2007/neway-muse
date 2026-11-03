import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSION_CODES, type Role } from '@neway/shared';
import { renderPage } from '@/features/common/test-router';
import { RolesPage } from './RolesPage';

/**
 * Every role opens read-only and changes through "Edit" — built-in ones too, which save as this
 * company's own version rather than as a "(copy)" nobody asked for. A custom role can be archived.
 */
const role = (over: Partial<Role>): Role => ({
  id: 'rol_x',
  code: 'x',
  name: 'X',
  description: null,
  isSystem: false,
  status: 'active',
  permissions: [],
  accountCount: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

let roles: Role[] = [];
let patches: { id: string; body: Record<string, unknown> }[] = [];
const original = globalThis.fetch;

beforeEach(() => {
  roles = [
    role({ id: 'rol_sys_fleet', code: 'fleet_manager', name: 'Fleet Manager', isSystem: true, permissions: ['dashboard.view', 'trucks.view'], accountCount: 4 }),
    role({ id: 'rol_copy', code: 'fleet_manager_copy', name: 'Fleet Manager (copy)', permissions: ['trucks.view'] }),
  ];
  patches = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, 'http://localhost').pathname.replace(/^\/api\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/admin/me') return reply({ permissions: [...PERMISSION_CODES] });
    if (path === '/admin/roles' && method === 'GET') return reply(roles.filter((r) => r.status === 'active'));
    if (path === '/admin/permissions' || path === '/admin/roles/matrix' || path === '/admin/permission-matrix') {
      return reply([
        { module: 'Fleet', group: 'Units', permissions: [{ code: 'dashboard.view', description: 'See the dashboard' }, { code: 'trucks.view', description: 'See trucks' }] },
      ]);
    }
    const edit = /^\/admin\/roles\/([^/]+)$/.exec(path);
    if (edit && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      patches.push({ id: edit[1]!, body });
      // The server answers an edit of a built-in with the company's own version.
      const saved = role({ id: 'rol_own_fleet', code: 'fleet_manager', name: String(body.name), permissions: body.permissions as string[], accountCount: 4 });
      roles = [saved, ...roles.filter((r) => r.id !== edit[1])];
      return reply(saved);
    }
    return inner(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = original;
});

describe('roles', () => {
  it('a built-in role opens read-only, with Edit', async () => {
    renderPage(<RolesPage />, { routePath: '/', path: '/' });
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it('editing a built-in role saves that role — no "(copy)" is created', async () => {
    const user = userEvent.setup();
    renderPage(<RolesPage />, { routePath: '/', path: '/' });
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByText(/Saving makes this company's own version/)).toBeVisible();
    await user.click(await screen.findByRole('checkbox', { name: /See the dashboard/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ id: 'rol_sys_fleet', body: { name: 'Fleet Manager', permissions: ['trucks.view'] } });
  });

  it('a custom role can be archived', async () => {
    const user = userEvent.setup();
    renderPage(<RolesPage />, { routePath: '/', path: '/' });
    await user.click(await screen.findByRole('button', { name: /Fleet Manager \(copy\)/ }));
    expect(await screen.findByRole('button', { name: 'Archive' })).toBeEnabled();
  });
});
