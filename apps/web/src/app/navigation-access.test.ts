import { describe, expect, it } from 'vitest';
import { PERMISSION_CODES, SYSTEM_ROLES } from '@neway/shared';
import { boardNavFor } from '@/features/dispatch/board/chrome';
import { NAVIGATION, allowedPages, homeFor, navVisible, pathForbidden } from './navigation';

/**
 * Who sees what (owner's rule, 2026-09-21): an account sees the pages its permissions open and
 * nothing else - not greyed out, not listed. A typed URL to anything else lands on the first page
 * the account may open.
 */
const fleetOnly = {
  isOwner: false,
  permissions: ['trucks.view', 'trailers.view', 'maintenance.view'],
};

describe('page access follows permissions', () => {
  it('names a permission on every page but Notifications', () => {
    const open = NAVIGATION.flatMap((g) => g.items).filter((i) => i.permission === undefined && !i.anyPermission && !i.platform);
    expect(open.map((i) => i.label)).toEqual(['Notifications']);
  });

  it('Companies is for the platform administrator only, not for a company owner', () => {
    expect(pathForbidden('/platform/companies', { isOwner: true, permissions: [] })).toBe(true);
    expect(pathForbidden('/platform/companies', { isOwner: false, permissions: [], isPlatformAdmin: true })).toBe(false);
  });

  it('every permission a page names is a real code', () => {
    const named = NAVIGATION.flatMap((g) => g.items)
      .map((i) => i.permission)
      .filter((p): p is string => Boolean(p));
    for (const code of named) expect(PERMISSION_CODES).toContain(code);
  });

  it('a fleet-only account gets the fleet pages and Notifications, nothing else', () => {
    const pages = allowedPages(fleetOnly).map((p) => p.to);
    expect(pages).toContain('/fleet/trucks');
    expect(pages).toContain('/notifications');
    expect(pages).not.toContain('/dashboard');
    expect(pages).not.toContain('/accounting');
    expect(pages).not.toContain('/admin/users');
    expect(pages).not.toContain('/hr/employees');
  });

  it('the Accounting overview page needs its own permission; the other accounting pages do not (owner, 2026-10-13)', () => {
    const clerk = { isOwner: false, permissions: ['accounting.view', 'accounting.edit', 'payroll.view'] };
    expect(pathForbidden('/accounting', clerk)).toBe(true);
    expect(pathForbidden('/accounting/invoices', clerk)).toBe(false);
    expect(pathForbidden('/accounting/settlements/stl_1', clerk)).toBe(false);
    expect(pathForbidden('/accounting', { ...clerk, permissions: [...clerk.permissions, 'accounting.overview'] })).toBe(false);
  });

  it('sends a typed URL to the first page the account may open', () => {
    expect(pathForbidden('/dashboard', fleetOnly)).toBe(true);
    expect(pathForbidden('/accounting/invoices', fleetOnly)).toBe(true);
    expect(pathForbidden('/fleet/trucks', fleetOnly)).toBe(false);
    expect(pathForbidden('/fleet/trucks/trk_1', fleetOnly)).toBe(false);
    expect(homeFor(fleetOnly)).toBe('/fleet/today');
  });

  it('the owner sees everything this build shows', () => {
    const owner = { isOwner: true, permissions: [] };
    const all = NAVIGATION.flatMap((g) => g.items).filter(navVisible).length;
    const seen = new Set(allowedPages(owner).filter((p) => !p.parent).map((p) => p.to));
    expect(seen.size).toBeGreaterThanOrEqual(all - 2); // parents sharing a path collapse
    expect(pathForbidden('/admin/settings', owner)).toBe(false);
  });

  it('nobody signed in may open a guarded page', () => {
    expect(pathForbidden('/dashboard', null)).toBe(true);
  });
});

/**
 * What dispatchers earn is not what dispatchers do.
 *
 * The boards, the weekly sheet and Detention & Layover belong to everyone who dispatches; the
 * Weekly Report, the Commission policy and the Salary Report are one person's pay beside
 * another's, and they take `dispatch_pay.view`. A dispatch lead runs the shift and still does not
 * see them — which is why this is its own code and not another use of `dispatch.manage`.
 */
const dispatcher = {
  isOwner: false,
  permissions: ['dispatch.view', 'dispatch.edit', 'dispatch.manage', 'loads.view'],
};
const payAdmin = {
  isOwner: false,
  permissions: ['dispatch.view', 'dispatch.edit', 'dispatch.manage', 'dispatch_pay.view'],
};

describe('the dispatcher pay pages', () => {
  const pagesFor = (viewer: typeof dispatcher) => allowedPages(viewer).map((p) => p.to);

  it('leaves the boards and Detention & Layover open to a dispatch lead', () => {
    const pages = pagesFor(dispatcher);
    expect(pages).toContain('/dispatch/daily');
    expect(pages).toContain('/dispatch/weekly');
    expect(pages).toContain('/dispatch/claims');
  });

  it('keeps the three pay pages out of a dispatch lead is list', () => {
    const pages = pagesFor(dispatcher);
    expect(pages).not.toContain('/dispatch/weekly/report');
    expect(pages).not.toContain('/dispatch/commission');
    expect(pages).not.toContain('/dispatch/salary');
  });

  it('refuses a typed URL to one, which hiding the link alone never did', () => {
    expect(pathForbidden('/dispatch/salary', dispatcher)).toBe(true);
    expect(pathForbidden('/dispatch/commission', dispatcher)).toBe(true);
    expect(pathForbidden('/dispatch/weekly/report', dispatcher)).toBe(true);
    expect(pathForbidden('/dispatch/daily', dispatcher)).toBe(false);
    expect(pathForbidden('/dispatch/claims', dispatcher)).toBe(false);
  });

  it('opens all three to an account that holds the pay code', () => {
    const pages = pagesFor(payAdmin);
    expect(pages).toContain('/dispatch/weekly/report');
    expect(pages).toContain('/dispatch/commission');
    expect(pages).toContain('/dispatch/salary');
    expect(pathForbidden('/dispatch/salary', payAdmin)).toBe(false);
  });
});

/**
 * Weekly Report, Salary Report and Commission are for Accounting and Administrator only (owner,
 * 2026-10-26). Accounting holds dispatch_pay.view and no dispatch.view: it reaches the three pay
 * pages and none of the boards it does not hold.
 */
describe('Accounting reaches the dispatcher pay pages', () => {
  const accountingOnly = {
    isOwner: false,
    permissions: ['dispatch_pay.view', 'accounting.view', 'payroll.view', 'loads.view', 'drivers.view_pay'],
  };
  it('lists the three pay pages and not Daily Board and the rest', () => {
    const pages = allowedPages(accountingOnly).map((p) => p.to);
    expect(pages).toContain('/dispatch/weekly/report');
    expect(pages).toContain('/dispatch/salary');
    expect(pages).toContain('/dispatch/commission');
    expect(pages).not.toContain('/dispatch/daily');
    expect(pages).not.toContain('/dispatch/weekly');
    expect(pages).not.toContain('/dispatch/claims');
    expect(pages).not.toContain('/dispatch/roster-match');
  });
  it('the sidebar Dispatch board link lands on the first pay page', () => {
    const board = allowedPages(accountingOnly).find((p) => p.label === 'Dispatch board');
    expect(board?.to).toBe('/dispatch/weekly/report');
  });
  it('opens the three by typed URL and refuses the Daily Board', () => {
    expect(pathForbidden('/dispatch/weekly/report', accountingOnly)).toBe(false);
    expect(pathForbidden('/dispatch/salary', accountingOnly)).toBe(false);
    expect(pathForbidden('/dispatch/commission', accountingOnly)).toBe(false);
    expect(pathForbidden('/dispatch/daily', accountingOnly)).toBe(true);
  });
  it('the board sub-nav shows only the pages it may open', () => {
    expect(boardNavFor(accountingOnly.permissions).map((n) => n.label)).toEqual(['Weekly Report', 'Commission', 'Salary Report']);
  });
  it('the built-in Accounting role holds dispatch_pay.view; Dispatch Lead, Maintenance and Safety Manager do not', () => {
    const role = (code: string) => SYSTEM_ROLES.find((r) => r.code === code)!;
    expect(role('accounting').permissions).toContain('dispatch_pay.view');
    for (const code of ['dispatch_lead', 'dispatcher', 'operations_manager', 'maintenance', 'safety_manager', 'fleet_manager']) {
      expect(role(code).permissions).not.toContain('dispatch_pay.view');
    }
  });
});

describe('one board at a time', () => {
  const accounting = { isOwner: false, permissions: ['dashboard.view', 'accounting.view', 'board_weekly.view'] };
  it('opens the Weekly Board to an account holding only board_weekly.view, and nothing else of dispatch', () => {
    expect(pathForbidden('/dispatch/weekly', accounting)).toBe(false);
    expect(pathForbidden('/dispatch/daily', accounting)).toBe(true);
    expect(pathForbidden('/dispatch/salary', accounting)).toBe(true);
    const board = allowedPages(accounting).find((p) => p.label === 'Dispatch board');
    expect(board?.to).toBe('/dispatch/weekly');
  });
});

/**
 * Analytics and Reports (owner, 2026-10-25): the server now refuses them without the code, so the
 * menu must not offer them either - a link that always answers 403 is the same leak in reverse.
 */
describe('Analytics and Reports follow their own codes', () => {
  const dispatcher = { isOwner: false, permissions: ['loads.view', 'dispatch.view', 'reports.view'] };
  const analyst = { isOwner: false, permissions: ['reports.view', 'analytics.view'] };
  const shop = { isOwner: false, permissions: ['maintenance.view', 'trucks.view'] };

  it('hides Analytics from an account without analytics.view, even when it holds reports.view', () => {
    const pages = allowedPages(dispatcher).map((p) => p.to);
    expect(pages).toContain('/reports');
    expect(pages).not.toContain('/reports/analytics');
    expect(pathForbidden('/reports/analytics', dispatcher)).toBe(true);
  });

  it('hides both from an account holding neither', () => {
    const pages = allowedPages(shop).map((p) => p.to);
    expect(pages).not.toContain('/reports');
    expect(pages).not.toContain('/reports/analytics');
    expect(pathForbidden('/reports', shop)).toBe(true);
    expect(pathForbidden('/reports/analytics', shop)).toBe(true);
  });

  it('shows Analytics to an account holding analytics.view', () => {
    expect(allowedPages(analyst).map((p) => p.to)).toContain('/reports/analytics');
    expect(pathForbidden('/reports/analytics', analyst)).toBe(false);
  });
});
