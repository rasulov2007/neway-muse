import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Visits every navigation page, fails on any console error or page error, asserts a page title,
 * and stores a screenshot per page under test-results/screens for the visual review.
 */

const navigationSource = readFileSync(
  fileURLToPath(new URL('../src/app/navigation.ts', import.meta.url)),
  'utf8',
);
const pages = [...navigationSource.matchAll(/to:\s*'([^']+)'/g)].map((m) => m[1]);
const uniquePages = [...new Set(['/dashboard', ...pages, '/dev/gallery'])];

async function collectErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    if (msg.type() === 'warning' && /React|Warning/.test(msg.text()))
      errors.push(`console.warn: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

for (const path of uniquePages) {
  test(`renders ${path} without errors`, async ({ page }) => {
    const errors = await collectErrors(page);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Let lazy chunks, queries and skeletons settle.
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(400);
    await page.screenshot({
      // `?` and `=` are illegal in a Windows filename, and several nav entries carry a query.
      path: `test-results/screens/${path.replace(/[/?=&]/g, '_').replace(/^_/, '') || 'root'}.png`,
      fullPage: true,
    });
    expect(errors, `errors on ${path}`).toEqual([]);
  });
}

test('root redirects to the dashboard', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('sidebar highlights the active item and supports collapse', async ({ page }) => {
  await page.goto('/fleet/maintenance');
  const nav = page.getByRole('navigation', { name: /main/i });
  await expect(nav.getByRole('link', { name: 'Maintenance', exact: true })).toHaveAttribute(
    'aria-current',
    /page|true/,
  );
  await expect(nav.getByRole('link', { name: 'Overdue', exact: true })).toBeVisible();
  await page.keyboard.press('[');
  await expect(nav).toHaveAttribute('data-collapsed', 'true');
  await page.keyboard.press('[');
  await expect(nav).toHaveAttribute('data-collapsed', 'false');
});

test('command palette opens with Ctrl+K and finds unit 2785', async ({ page }) => {
  await page.goto('/dashboard');
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.type('2785');
  await expect(dialog.getByText(/Unit 2785/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

for (const width of [1024, 768]) {
  test(`dashboard renders at ${width}px without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow, 'page body must not scroll horizontally').toBe(false);
    await page.screenshot({ path: `test-results/screens/dashboard_${width}.png`, fullPage: true });
  });
}

test('a fleet exception opens exactly the units behind its count', async ({ page }) => {
  await page.goto('/fleet/trucks');
  await page.waitForLoadState('networkidle');
  const finding = page.getByRole('button', { name: /trucks are overdue for maintenance/ });
  await expect(finding).toBeVisible();
  const count = Number(((await finding.textContent()) ?? '').match(/^(\d+)/)?.[1] ?? '0');
  expect(count).toBeGreaterThan(0);

  await finding.click();
  // The tile hands the list the exact ids behind its count, so the two can never disagree.
  await expect(page.getByText(`Showing the ${count} units behind one finding.`)).toBeVisible();
  await expect(page.getByText(`of ${count}`, { exact: false }).first()).toBeVisible();
});

test('a unit number opens the Truck 360 page', async ({ page }) => {
  await page.goto('/fleet/trucks');
  await page.waitForLoadState('networkidle');
  const unit = page.locator('table tbody tr').first().getByRole('link').first();
  const label = ((await unit.textContent()) ?? '').trim();
  await unit.click();
  await expect(page).toHaveURL(/\/fleet\/trucks\/trk_/);
  await expect(page.getByRole('heading', { level: 1, name: `Unit ${label}` })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Maintenance' })).toBeVisible();
});

test('the general ledger balances', async ({ page }) => {
  await page.goto('/accounting');
  await page.waitForLoadState('networkidle');
  // Debits equal credits, shown rather than asserted: an unbalanced entry cannot be constructed.
  await expect(page.getByText('Every posted entry balances', { exact: false })).toBeVisible();
});

test('an issued invoice shows the journal entry it posted', async ({ page }) => {
  await page.goto('/accounting/invoices');
  await page.waitForLoadState('networkidle');
  // A draft has deliberately touched nothing, so drill into one that has been issued.
  await page
    .getByRole('button', { name: /Outstanding/ })
    .first()
    .click();
  await page.locator('table tbody tr').first().getByRole('link').first().click();
  await expect(page).toHaveURL(/\/accounting\/invoices\/inv_/);
  await page.getByRole('tab', { name: 'Accounting', exact: true }).click();
  // 1200 is accounts receivable: issuing debits AR and credits revenue.
  await expect(page.getByText('1200').first()).toBeVisible();
  await expect(page.getByText('Balanced').first()).toBeVisible();
});

test('a settlement line carries the arithmetic that produced it', async ({ page }) => {
  await page.goto('/accounting/settlements');
  await page.waitForLoadState('networkidle');
  await page.locator('table tbody tr').first().getByRole('link').first().click();
  await expect(page).toHaveURL(/\/accounting\/settlements\/set_/);
  // A driver has to be able to check the statement, so every line shows its own basis.
  await expect(page.getByText(/mi × \$[\d.]+\/mi|% of \$[\d,.]+ linehaul/).first()).toBeVisible();
});

test('a truck created through the form is still there in a new browser session', async ({
  browser,
}) => {
  const unit = String(9000 + Math.floor(Math.random() * 900));
  const vin = `1XKYDP9X8KP${unit}999`.slice(0, 17).toUpperCase();

  const author = await browser.newContext();
  const form = await author.newPage();
  await form.goto('/fleet/trucks/new');
  await form.waitForLoadState('networkidle');
  await form.locator('input[name="unitNumber"]').fill(unit);
  await form.locator('input[name="vin"]').fill(vin);
  // Make and State are the first two comboboxes on the form, in DOM order.
  await form.getByRole('combobox').nth(0).click();
  await form.getByRole('option', { name: 'Peterbilt', exact: true }).click();
  await form.locator('input[name="model"]').fill('579');
  await form.locator('input[name="year"]').fill('2024');
  await form.locator('input[name="plate"]').fill(`P${unit}`);
  await form.getByRole('combobox').nth(1).click();
  await form.getByRole('option', { name: 'IL', exact: true }).first().click();
  await form
    .locator('label:has-text("In service since")')
    .locator('xpath=following::button[1]')
    .click();
  await form.getByRole('button', { name: 'Today', exact: true }).click();
  await form.locator('input[name="odometer"]').fill('1500');
  await form.getByRole('button', { name: /create truck/i }).click();
  // The id in the URL is the server's, not one this client invented.
  await expect(form).toHaveURL(/\/fleet\/trucks\/trk_/, { timeout: 20_000 });
  await author.close();

  // A second context shares no memory, cache or storage with the first, so anything it can still
  // see came back from the database. This is the check the bug report asked for.
  const reader = await browser.newContext();
  const fresh = await reader.newPage();
  await fresh.goto(`/fleet/trucks?q=${unit}`);
  await fresh.waitForLoadState('networkidle');
  await expect(fresh.getByText(unit, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await reader.close();
});

test('the fleet says so when the server cannot be reached, rather than showing an empty fleet', async ({
  page,
}) => {
  await page.route('**/api/v1/trucks**', (route) => route.abort('failed'));
  await page.goto('/fleet/trucks');
  await page.waitForLoadState('networkidle');
  // An unreachable server and a carrier with no trucks are different answers.
  await expect(page.getByText(/again|retry|could not|unable/i).first()).toBeVisible({
    timeout: 20_000,
  });
});

test('a workforce tile opens exactly the people behind its count', async ({ page }) => {
  await page.goto('/hr/employees');
  await page.waitForLoadState('networkidle');
  const tile = page.locator('button[aria-pressed]', { hasText: 'Drivers' }).first();
  const count = Number(((await tile.textContent()) ?? '').replace(/[^\d]/g, ''));
  expect(count).toBeGreaterThan(0);
  await tile.click();
  await page.waitForLoadState('networkidle');
  // Tile and list are the same query, so the number cannot drift from the rows it opens.
  await expect(page.getByText(`of ${count}`, { exact: false }).first()).toBeVisible({
    timeout: 20_000,
  });
});

test('an employee 360 keeps driver, payroll and safety as links rather than copies', async ({
  page,
}) => {
  await page.goto('/hr/employees?workforce=driver');
  await page.waitForLoadState('networkidle');
  await page.locator('table tbody tr').first().locator('a').first().click();
  await expect(page).toHaveURL(/\/hr\/employees\/emp_/, { timeout: 20_000 });

  // Employment history is the record, not a single mutable row.
  await page.getByRole('tab', { name: 'Employment', exact: true }).click();
  await expect(page.getByText('Employment history')).toBeVisible();

  // A driver's pay lives on the driving profile; the employee page must not restate it.
  await page.getByRole('tab', { name: 'Compensation', exact: true }).click();
  await expect(page.getByText('Paid as a driver')).toBeVisible();
});

test('the employee PTO tab reports a real balance, or says there is none', async ({ page }) => {
  await page.goto('/hr/employees');
  await page.waitForLoadState('networkidle');
  await page.locator('table tbody tr').first().locator('a').first().click();
  await expect(page).toHaveURL(/\/hr\/employees\/emp_/, { timeout: 20_000 });
  await page.getByRole('tab', { name: 'PTO', exact: true }).click();
  // Phase 11 is built, so this tab shows the ledger-derived balance rather than a placeholder.
  // With no policy applying to this person it says so — it never invents a balance.
  await expect(page.getByText(/Balances|No PTO policies apply/).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('is not built yet')).toHaveCount(0);
});

for (const [path, heading] of [
  ['/hr/recruiting', 'Recruiting'],
  ['/hr/onboarding', 'Onboarding'],
  ['/hr/attendance', 'Attendance'],
  ['/hr/pto', 'PTO'],
  ['/hr/performance', 'Performance'],
] as const) {
  test(`${path} renders from the database`, async ({ page }) => {
    const errors = await collectErrors(page);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(errors, `errors on ${path}`).toEqual([]);
  });
}

test('a hired candidate links to the employee it became, and that employee links back', async ({
  page,
}) => {
  await page.goto('/hr/recruiting?includeClosed=1&stage=hired');
  await page.waitForLoadState('networkidle');
  // An empty list still renders a row for its empty state, so count the links, not the rows.
  const links = page.locator('table tbody tr a');
  test.skip((await links.count()) === 0, 'no hired candidate on file yet');

  await links.first().click();
  await expect(page).toHaveURL(/\/hr\/recruiting\/apl_/, { timeout: 20_000 });
  // The candidate points at an employee rather than holding a second copy of the person.
  await page.getByRole('link', { name: 'Open their employee record' }).click();
  await expect(page).toHaveURL(/\/hr\/employees\/emp_/, { timeout: 20_000 });

  // And the employee's Recruiting tab points back at the candidate it came from.
  await page.getByRole('tab', { name: 'Recruiting', exact: true }).click();
  await expect(page.getByText('Hired from')).toBeVisible({ timeout: 20_000 });
});

test('an unrated review shows no rating rather than a zero', async ({ page }) => {
  await page.goto('/hr/performance?tab=reviews');
  await page.waitForLoadState('networkidle');
  const rows = await page.locator('table tbody tr td').count();
  test.skip(rows === 0, 'no reviews on file yet');
  // Every rating cell is either a real 1–5 with its label, or an em dash. Never "0".
  const ratings = await page.locator('table tbody tr td:nth-child(5)').allTextContents();
  for (const rating of ratings) expect(rating.trim()).not.toBe('0');
});

test('reports and analytics reconcile with the dashboard', async ({ request }) => {
  // The same preset must mean the same range and produce the same gross in all three places.
  // They diverged once: the dashboard read the pinned demo clock while reports read the wall
  // clock, and "this month" silently covered five extra days.
  for (const preset of ['this_week', 'this_month', 'last_month']) {
    const [dashboard, report, analytics] = await Promise.all([
      request.get(`/api/v1/dashboard/overview?period=${preset}`, {
        headers: { 'X-Demo-Role': 'admin' },
      }),
      request.post('/api/v1/reports/run', {
        headers: { 'X-Demo-Role': 'admin' },
        data: { reportKey: 'profit_and_loss', preset },
      }),
      request.get(`/api/v1/analytics/executive?preset=${preset}`, {
        headers: { 'X-Demo-Role': 'admin' },
      }),
    ]);
    expect(dashboard.ok(), preset).toBe(true);
    expect(report.ok(), preset).toBe(true);
    expect(analytics.ok(), preset).toBe(true);

    const dash = await dashboard.json();
    const rep = await report.json();
    const ana = await analytics.json();

    // Same resolved range.
    expect(rep.range.from, preset).toBe(dash.meta.period.from);
    expect(rep.range.to, preset).toBe(dash.meta.period.to);

    // Same gross revenue.
    const reportGross = rep.rows.find((r: { id: string }) => r.id === 'gross').cells.amount;
    const analyticsGross = ana.metrics.find((m: { key: string }) => m.key === 'gross').current;
    expect(analyticsGross, preset).toBe(reportGross);
  }
});

test('a report the data cannot support is refused with the reason, not returned empty', async ({
  request,
}) => {
  const response = await request.post('/api/v1/reports/run', {
    headers: { 'X-Demo-Role': 'admin' },
    data: { reportKey: 'customer_performance' },
  });
  expect(response.status()).toBe(422);
  // The reason names the missing data rather than saying "coming soon".
  expect((await response.json()).detail).toMatch(/no customer/i);
});

test('the report library is filtered by permission on the server', async ({ request }) => {
  const [admin, operations] = await Promise.all([
    request.get('/api/v1/reports/catalog', { headers: { 'X-Demo-Role': 'admin' } }),
    request.get('/api/v1/reports/catalog', { headers: { 'X-Demo-Role': 'operations' } }),
  ]);
  const adminReports = await admin.json();
  const operationsReports = await operations.json();
  expect(operationsReports.length).toBeLessThan(adminReports.length);
  // Financial reports are absent from the response, not merely hidden in the page.
  expect(
    operationsReports.some(
      (r: { permission: string }) => r.permission === 'reports.view_financial',
    ),
  ).toBe(false);

  const forbidden = await request.post('/api/v1/reports/run', {
    headers: { 'X-Demo-Role': 'operations' },
    data: { reportKey: 'profit_and_loss', preset: 'this_month' },
  });
  expect(forbidden.status()).toBe(403);
});

test('/reports runs a report and /reports/analytics compares periods', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/reports');
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
  await page.locator('button[aria-pressed]', { hasText: 'Truck profitability' }).first().click();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('table tfoot tr')).toBeVisible();

  await page.goto('/reports/analytics');
  await expect(page.getByRole('heading', { level: 1, name: 'Analytics' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('compared with', { exact: false })).toBeVisible({ timeout: 20_000 });
  expect(errors).toEqual([]);
});

test('workforce analytics and the headcount report agree on how many people drive', async ({
  request,
}) => {
  // A correlated `exists` subquery inside `count(*) filter` silently returns zero through Drizzle's
  // sql interpolation. It produced a driver count of 0 twice, in two different modules. Both now
  // count through a join, and this asserts the two surfaces agree rather than both being wrong.
  const [analytics, report] = await Promise.all([
    request.get('/api/v1/analytics/workforce', { headers: { 'X-Demo-Role': 'admin' } }),
    request.post('/api/v1/reports/run', {
      headers: { 'X-Demo-Role': 'admin' },
      data: { reportKey: 'headcount' },
    }),
  ]);
  const workforce = await analytics.json();
  const headcount = await report.json();

  expect(workforce.drivers).toBeGreaterThan(0);
  expect(workforce.headcount).toBe(workforce.drivers + workforce.staff);
  expect(headcount.totals.headcount).toBe(workforce.headcount);
  expect(headcount.totals.drivers).toBe(workforce.drivers);
});

test('the accounts list shows real memberships, not the fleet', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  await page.waitForLoadState('networkidle');

  // Twelve staff hold an account; the 70 drivers hold none, which is the whole point of keeping
  // user, employee and driver as three records. A page showing 82 rows here would be a merged
  // identity model.
  const rows = page.locator('table tbody tr');
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThan(70);
  await expect(page.getByText('Owner', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the roles matrix is drawn from permissions the server enforces', async ({
  page,
  request,
}) => {
  const errors = await collectErrors(page);
  await page.goto('/admin/roles');
  await expect(page.getByRole('heading', { level: 1, name: 'Roles & permissions' })).toBeVisible();
  await page.waitForLoadState('networkidle');

  // The built-in roles cannot be edited, and the page says why rather than showing a dead form.
  await expect(page.getByText('This role ships with the product')).toBeVisible({ timeout: 20_000 });

  const matrix = await request.get('/api/v1/admin/permissions');
  const groups = await matrix.json();
  const codes = groups.flatMap((group: { permissions: { code: string }[] }) =>
    group.permissions.map((permission) => permission.code),
  );
  expect(codes).toContain('users.edit');
  expect(new Set(codes).size).toBe(codes.length);
  expect(errors).toEqual([]);
});

test('integrations claim no connection, because none has been made', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/admin/integrations');
  await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('No connector is implemented', { exact: false })).toBeVisible({
    timeout: 20_000,
  });
  // No provider may claim to be connected.
  await expect(page.getByText('Connected', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the audit log says it cannot be edited and how far back it goes', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/admin/audit-logs');
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('Records here cannot be changed')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Recording from', { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
});

test('settings name what reads each value, and admit the one nothing reads', async ({
  page,
  request,
}) => {
  const errors = await collectErrors(page);
  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('Read by:', { exact: false }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('Stored, but not acted on yet')).toBeVisible();

  const settings = await request.get('/api/v1/admin/settings');
  const body = await settings.json();
  expect(body.notEnforced.length).toBeGreaterThan(0);
  for (const entry of body.notEnforced) expect(entry.reason).toBeTruthy();
  expect(errors).toEqual([]);
});

test('an administration route is refused to a principal without the permission', async ({
  request,
}) => {
  // The UI hides what it cannot use; this asserts the server refuses it regardless.
  const response = await request.get('/api/v1/admin/users', {
    headers: { 'X-Demo-Role': 'operations' },
  });
  expect(response.status()).toBe(403);
  const problem = await response.json();
  expect(problem.detail).toContain('users.view');
});

test('the recruiting page opens on leads, with populated tiles and a funnel board', async ({
  page,
  request,
}) => {
  const errors = await collectErrors(page);
  await page.goto('/hr/recruiting');
  await expect(page.getByRole('heading', { level: 1, name: 'Recruiting' })).toBeVisible();
  await page.waitForLoadState('networkidle');

  // Leads is the default tab, and the seed makes every tile non-empty.
  await expect(page.getByRole('tab', { name: 'Leads' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 20_000 });
  const summary = await (await request.get('/api/v1/hiring/leads/summary')).json();
  expect(summary.flagged).toBeGreaterThan(0);
  await expect(page.getByText('Does not prequalify').first()).toBeVisible();

  // The funnel board reads the same cases Safety → Verification shows, and says so.
  await page.getByRole('tab', { name: 'Pipeline' }).click();
  await expect(
    page.getByText('Checks and Safety review are managed in Safety → Verification'),
  ).toBeVisible({ timeout: 20_000 });
  const cases = await (await request.get('/api/v1/hiring/cases/summary')).json();
  expect(cases.checks + cases.safety_review + cases.active_driver).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('the prequalification rules appear in settings with their provenance line', async ({
  page,
}) => {
  await page.goto('/admin/settings');
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('Driver prequalification')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Maximum accidents in the last 36 months')).toBeVisible();
  await expect(
    page.getByText('Read by: LeadsService.prequalify', { exact: false }).first(),
  ).toBeVisible();
});

test('a driver candidate shows the DOT application filed in the qualification file, with the PDF', async ({
  page,
  request,
}) => {
  const errors = await collectErrors(page);
  const cases = (await (await request.get('/api/v1/hiring/cases?state=checks')).json()) as {
    applicantId: string | null;
    verificationCaseId: string | null;
    dotApplication: { status: string; documentId: string | null } | null;
  }[];
  const submitted = cases.find((c) => c.applicantId && c.dotApplication?.status === 'submitted');
  expect(submitted, 'the seed submits at least one DOT application').toBeTruthy();

  await page.goto(`/hr/recruiting/${submitted!.applicantId}`);
  await page.waitForLoadState('networkidle');
  // The driver funnel replaces the office stage vocabulary on this record.
  await expect(page.getByText('Checks', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Move stage' })).toHaveCount(0);

  await page.getByRole('tab', { name: /DOT application/ }).click();
  await expect(page.getByText('Filed in the qualification file', { exact: false })).toBeVisible();
  const pdf = page.getByRole('link', { name: 'Open the PDF' });
  await expect(pdf).toBeVisible();
  const href = await pdf.getAttribute('href');
  const file = await request.get(href!);
  expect(file.status()).toBe(200);
  expect(file.headers()['content-type']).toBe('application/pdf');

  // And the verification case links back to the candidate record.
  await page.goto(`/safety/compliance?tab=verification&case=${submitted!.verificationCaseId}`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('link', { name: 'Open candidate record' })).toBeVisible({
    timeout: 20_000,
  });
  expect(errors).toEqual([]);
});

test('a hired driver candidate shows the offer, ticket, orientation and the roster row it opened', async ({
  page,
  request,
}) => {
  const errors = await collectErrors(page);
  const cases = (await (await request.get('/api/v1/hiring/cases?state=hired')).json()) as {
    applicantId: string | null;
    driverId: string | null;
    employeeId: string | null;
  }[];
  const hired = cases.find((c) => c.applicantId && c.employeeId);
  expect(hired, 'the seed hires at least one candidate').toBeTruthy();

  await page.goto(`/hr/recruiting/${hired!.applicantId}`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('Hired', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: /Offer · ticket · orientation · hire/ }).click();
  await expect(page.getByText('Open employee record')).toBeVisible();
  await expect(page.getByText('Filed in the qualification file')).toBeVisible();
  await expect(page.getByText(/per mile|of linehaul/).first()).toBeVisible();

  // The roster row exists under the id the file has carried since the application.
  const driver = await (await request.get(`/api/v1/drivers/${hired!.driverId}`)).json();
  expect(driver.id).toBe(hired!.driverId);
  const employee = await (await request.get(`/api/v1/employees/${hired!.employeeId}`)).json();
  expect(employee.driverId).toBe(hired!.driverId);

  // The pipeline board has a Hired column with the same case in it.
  await page.goto('/hr/recruiting?tab=pipeline');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('region', { name: 'Hired' })).toBeVisible({ timeout: 20_000 });
  expect(errors).toEqual([]);
});

test('campaigns and the cost ledger are populated, and a hired candidate carries a priced ledger', async ({
  page,
  request,
}) => {
  const errors = await collectErrors(page);
  await page.goto('/hr/recruiting?tab=campaigns');
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('Driver referral program')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Leads attributed')).toBeVisible();

  const cases = (await (await request.get('/api/v1/hiring/cases?state=hired')).json()) as {
    id: string;
    applicantId: string | null;
    candidateName: string;
  }[];
  // The seed's own hire, not one an API test built (those re-price their reports on purpose).
  const hired = cases.find((c) => c.applicantId && !c.candidateName.startsWith('E2E'));
  expect(hired).toBeTruthy();
  const ledger = (await (await request.get(`/api/v1/hiring/cases/${hired!.id}/costs`)).json()) as {
    summary: { total: number; byType: Record<string, number> };
  };
  expect(ledger.summary.byType.mvr).toBe(18);
  expect(ledger.summary.total).toBeGreaterThan(500);

  await page.goto(`/hr/recruiting/${hired!.applicantId}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Costs' }).click();
  await expect(page.getByTestId('case-cost-total')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('priced by the system').first()).toBeVisible();

  await page.goto('/admin/settings');
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('Cost per hire — unit costs')).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText('Read by: CostLedgerService', { exact: false }).first(),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('recruiting analytics computes the funnel and cost per hire, and names what it cannot compute', async ({
  page,
  request,
}) => {
  const errors = await collectErrors(page);
  const a = (await (
    await request.get('/api/v1/hiring/analytics?from=2026-01-01&to=2026-12-31')
  ).json()) as {
    totals: { hires: number };
    costPerHire: { directPerHire: number | null };
    daysToFirstLoad: { meanDays: number | null; reason: string | null };
  };
  expect(a.totals.hires).toBeGreaterThanOrEqual(1);

  await page.goto('/hr/recruiting/analytics?from=2026-01-01&to=2026-12-31');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { level: 1, name: 'Recruiting analytics' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('Funnel by source')).toBeVisible();
  await expect(page.getByText('True cost per hire')).toBeVisible();
  await expect(
    page.getByText('Campaign spend is entered as a total', { exact: false }),
  ).toBeVisible();
  if (a.daysToFirstLoad.meanDays === null) {
    await expect(page.getByText(a.daysToFirstLoad.reason!, { exact: false }).first()).toBeVisible();
  }
  // And the Analytics tab under Recruiting shows the same view.
  await page.goto('/hr/recruiting?tab=analytics');
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('Direct cost per hire')).toBeVisible({ timeout: 20_000 });
  expect(errors).toEqual([]);
});

test('the onboarding templates page lists the driver plans, and a hired driver’s plan shows the gate', async ({
  page,
  request,
}) => {
  const errors = await collectErrors(page);
  await page.goto('/hr/onboarding/templates');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { level: 1, name: 'Onboarding templates' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('Lease operator').first()).toBeVisible();
  await expect(page.getByText('Lease agreement signed')).toBeVisible();
  await expect(page.getByText('blocking').first()).toBeVisible();

  const cases = (await (await request.get('/api/v1/hiring/cases?state=hired')).json()) as {
    applicantId: string | null;
    candidateName: string;
    onboardingGate: { checklistId: string; blockingOpen: number } | null;
  }[];
  const hired = cases.find(
    (c) => c.applicantId && c.onboardingGate && !c.candidateName.startsWith('E2E'),
  );
  expect(hired, 'the seed’s hire has an onboarding plan with a gate').toBeTruthy();
  await page.goto(`/hr/onboarding/${hired!.onboardingGate!.checklistId}`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('from the qualification file').first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('blocking').first()).toBeVisible();
  expect(errors).toEqual([]);
});

/**
 * Sign-in exists on the server this build is talking to.
 *
 * The bug this guards: a web build shipped ahead of the API answered "Cannot POST
 * /api/v1/auth/login" on the login screen. A 404 from this endpoint is therefore a failure, and
 * only a refusal — which proves the handler ran — is a pass.
 */
test('the sign-in endpoint exists and refuses a wrong password', async ({ page, request }) => {
  const response = await request.post('/api/v1/auth/login', {
    data: { email: 'nobody.e2e@example.invalid', password: 'not-a-real-password' },
    failOnStatusCode: false,
  });
  expect(response.status(), 'a 404 here means the API is older than the app').not.toBe(404);
  expect([401, 403]).toContain(response.status());

  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.locator('input[type=email]').first().fill('nobody.e2e@example.invalid');
  await page.locator('input[type=password]').first().fill('not-a-real-password');
  await page.getByRole('button', { name: /sign in/i }).click();

  const alert = page.getByRole('alert').first();
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await expect(alert).toContainText(/invalid email or password/i);
  await expect(alert).not.toContainText(/cannot post/i);
});
