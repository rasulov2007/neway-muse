import { expect, test, type Page } from '@playwright/test';

/**
 * The Update PTI drawer (brief §6), in a real browser against the real API: the §6.4 acceptance
 * criteria, one by one. Runs as the administrator the product ships with; every write lands in
 * PostgreSQL and the workspace, and the spec takes the next clean units on this week's board
 * rather than cleaning up - the inspections it reviews stay reviewed, as they would for a person.
 */

const API = 'http://localhost:3000/api/v1';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

interface Row {
  inspection: { id: string; unitId: string; unitNumber: string; version: number; receiptStatus: string; reviewState: string; receivedAt: string | null };
  openDefects: { id: string; defectNumber: string; state: string }[];
  verdict: { status: string };
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  if (!page.url().includes('/login')) return;
  await page.getByLabel(/Email/).fill('admin@neway.local');
  await page.getByLabel(/^Password/).fill('admin1234!');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
}

async function api(): Promise<<T>(method: string, path: string, body?: unknown) => Promise<T>> {
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@neway.local', password: 'admin1234!' }),
  });
  const { token } = (await login.json()) as { token: string };
  return async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  };
}

/** The next unit nobody has touched this week, received through the API so the drawer starts at the result. */
async function cleanUnit(call: Awaited<ReturnType<typeof api>>, skip: string[] = []): Promise<Row> {
  const board = await call<{ rows: Row[] }>('GET', '/fleet/pti/board');
  const row = board.rows.find(
    (r) => r.inspection.reviewState === 'unreviewed' && r.openDefects.length === 0 && !['exempt_in_shop', 'not_due'].includes(r.inspection.receiptStatus) && !skip.includes(r.inspection.unitId),
  );
  if (!row) throw new Error('no clean unit on the board');
  if (!row.inspection.receivedAt) {
    const received = await call<Row['inspection']>('POST', `/fleet/pti/inspections/${row.inspection.id}/receipt`, {
      version: row.inspection.version,
      receivedAt: new Date().toISOString(),
      source: { chatTitle: 'NWF Drivers', messageUrl: 'https://t.me/c/1234567890/456' },
    });
    row.inspection = received;
  }
  return row;
}

test.describe('the Update PTI drawer (§6.4)', () => {
  test('a clean review saves in two clicks from drawer open, with no matrix expanded', async ({ page }) => {
    const call = await api();
    const row = await cleanUnit(call);
    await signIn(page);
    await page.goto(`/fleet/pti?review=${row.inspection.unitId}`);
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('heading', { name: `Unit ${row.inspection.unitNumber}` })).toBeVisible();
    await expect(drawer.getByText(/\d+ of \d+/)).toBeVisible();
    // The receipt is a chip, not a form: it arrived.
    await expect(drawer.getByText('Open in Telegram')).toBeVisible();
    await expect(drawer.getByRole('group', { name: /rating/ })).toHaveCount(0);

    await drawer.getByRole('tab', { name: 'No issues' }).click(); // 1
    await expect(drawer.getByText('Leaves every component rating untouched, with its original date')).toBeVisible();
    await expect(drawer.getByRole('group', { name: /rating/ })).toHaveCount(0);
    await drawer.getByRole('button', { name: 'Save', exact: true }).click(); // 2
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(/\/fleet\/pti$/);

    const after = await call<Row['inspection'] & { reviewResult: string }>('GET', `/fleet/pti/inspections/${row.inspection.id}`);
    expect(after.reviewState).toBe('reviewed');
    expect(after.reviewResult).toBe('no_issues');
  });

  test('two defects on one inspection, nothing retyped; Save & next moves the queue and the URL', async ({ page }) => {
    test.setTimeout(120_000);
    const call = await api();
    const row = await cleanUnit(call);
    await signIn(page);
    await page.goto(`/fleet/pti?review=${row.inspection.unitId}`);
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('heading', { name: `Unit ${row.inspection.unitNumber}` })).toBeVisible();

    await drawer.getByRole('tab', { name: /Issue found/ }).click();
    await drawer.getByRole('button', { name: 'Add the issue' }).click();
    await drawer.getByLabel('Issue 1 component').click();
    await page.getByRole('option', { name: 'Brakes' }).click();
    await drawer.getByRole('button', { name: 'Out of stroke' }).click();
    await drawer.getByLabel(/Issue 1 · Brakes description/).fill('Out of stroke — slack adjuster on axle 3, driver side');
    await drawer.getByRole('button', { name: 'OOS risk' }).click();
    // Refused without a screenshot, in words; accepted with one.
    await expect(drawer.getByText(/needs a screenshot from the video/)).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await drawer.getByLabel('Screenshot files').setInputFiles({ name: 'brakes-04-18.png', mimeType: 'image/png', buffer: PNG });
    await expect(drawer.getByText('brakes-04-18.png')).toBeVisible();

    await drawer.getByRole('button', { name: 'Add another issue' }).click();
    // The first card folds to one line; the unit, the week and the link are not asked again.
    await expect(drawer.getByRole('button', { name: /Expand Issue 1/ })).toBeVisible();
    await expect(drawer.getByLabel('Telegram message link')).toHaveCount(0);
    await drawer.getByLabel('Issue 2 component').click();
    await page.getByRole('option', { name: 'Lights & reflectors' }).click();
    await drawer.getByRole('button', { name: 'Marker lamp dark' }).click();
    await drawer.getByLabel(/Issue 2 · Lights & reflectors description/).fill('Marker lamp dark, driver side rear');

    await expect(drawer.getByText(/Puts unit .* out of service/)).toBeVisible();
    await expect(drawer.getByText(/Rates 2 components/)).toBeVisible();
    const next = drawer.getByRole('button', { name: /Save & next/ });
    await expect(next).toBeEnabled();
    await next.click();

    // The drawer stayed open on the next unit; the URL followed it.
    await expect(drawer.getByRole('heading', { name: `Unit ${row.inspection.unitNumber}` })).toBeHidden();
    await expect(drawer.getByRole('heading', { name: /^Unit / })).toBeVisible();
    await expect(page).not.toHaveURL(new RegExp(`review=${row.inspection.unitId}$`));
    await expect(page).toHaveURL(/review=/);

    const defects = await call<{ defectNumber: string; severity: string; component: string; state: string }[]>('GET', `/fleet/pti/defects?unitId=${row.inspection.unitId}&open=true`);
    expect(defects.map((d) => [d.component, d.severity]).sort()).toEqual([
      ['brakes', 'oos_risk'],
      ['lights_reflectors', 'monitor'],
    ]);
    const status = await call<{ verdict: { status: string; reason: string } }>('GET', `/fleet/pti/units/${row.inspection.unitId}/status`);
    expect(status.verdict.status).toBe('out_of_service');
  });

  test('No issues on a unit with an open defect blocks save until dispositioned, and no disposition closes it', async ({ page }) => {
    const call = await api();
    // A unit that carries a defect into this week: raise one directly, dated before the review.
    const row = await cleanUnit(call);
    const defect = await call<{ id: string; defectNumber: string; version: number }>('POST', '/fleet/pti/defects', {
      unitId: row.inspection.unitId,
      component: 'body_mudflaps',
      description: 'Mud flap torn, passenger side',
      severity: 'monitor',
    });
    await signIn(page);
    await page.goto(`/fleet/pti?review=${row.inspection.unitId}`);
    const drawer = page.getByRole('dialog');
    await drawer.getByRole('tab', { name: 'No issues' }).click();
    await expect(drawer.getByText(`Say what this video showed for ${defect.defectNumber}`)).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

    await drawer.getByRole('group', { name: defect.defectNumber }).getByRole('button', { name: 'Looks fixed' }).click();
    await expect(drawer.getByText(/proposed for verification; the hold stays/)).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toBeHidden();

    const after = await call<{ state: string }>('GET', `/fleet/pti/defects/${defect.id}`);
    expect(after.state).toBe('fixed_pending_verify');
    expect(after.state).not.toBe('verified');
  });

  test('a work order opened from an issue is linked both ways, and closing it does not release the truck (WP6)', async ({ page }) => {
    test.setTimeout(120_000);
    const call = await api();
    const row = await cleanUnit(call);
    await signIn(page);
    await page.goto(`/fleet/pti?review=${row.inspection.unitId}`);
    const drawer = page.getByRole('dialog');
    await drawer.getByRole('tab', { name: /Issue found/ }).click();
    await drawer.getByRole('button', { name: 'Add the issue' }).click();
    await drawer.getByLabel('Issue 1 component').click();
    await page.getByRole('option', { name: 'Brakes' }).click();
    await drawer.getByLabel(/Issue 1 · Brakes description/).fill('Air leak at the treadle valve, audible at idle');
    await drawer.getByRole('button', { name: 'OOS risk' }).click();
    await drawer.getByLabel('Screenshot files').setInputFiles({ name: 'brakes-01-02.png', mimeType: 'image/png', buffer: PNG });
    await expect(drawer.getByText('brakes-01-02.png')).toBeVisible();
    await drawer.getByLabel('Issue 1 · Brakes next action').click();
    await page.getByRole('option', { name: 'Open a work order' }).click();
    await drawer.getByLabel('Issue 1 · Brakes vendor').fill('TA Truck Service');
    await expect(drawer.getByText(/opens a work order at TA Truck Service/)).toBeVisible();
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toBeHidden();

    // The defect points at the order; the order points at the defect.
    const [defect] = await call<{ id: string; defectNumber: string; state: string; workOrderId: string | null; workOrderNumber: string | null }[]>(
      'GET',
      `/fleet/pti/defects?unitId=${row.inspection.unitId}&open=true`,
    );
    if (!defect?.workOrderId) throw new Error('the defect has no work order');
    expect(defect.state).toBe('in_repair');
    const order = await call<{ defectId: string | null; number: string }>('GET', `/fleet/work-orders/${defect.workOrderId}`);
    expect(order.defectId).toBe(defect.id);
    expect(order.number).toBe(defect.workOrderNumber);

    // From the board to the order, and the order names the defect.
    await page.goto('/fleet/pti');
    const boardRow = page.locator(`tr[data-unit="${row.inspection.unitNumber}"]`);
    await boardRow.getByRole('link', { name: `Open ${order.number}` }).click();
    await expect(page).toHaveURL(new RegExp(`/fleet/shop/${defect.workOrderId}$`));
    await expect(page.getByRole('link', { name: new RegExp(`${defect.defectNumber} · Brakes`) })).toBeVisible();

    // The shop closes it: the defect awaits verification, the truck stays out of service.
    await page.getByLabel('What was done').fill('Treadle valve replaced, system leak-tested');
    await page.getByRole('button', { name: /Complete work order|Mark completed|Complete/ }).first().click();
    await expect(page.getByText(/Completed/).first()).toBeVisible({ timeout: 15_000 });
    const after = await call<{ state: string }>('GET', `/fleet/pti/defects/${defect.id}`);
    expect(after.state).toBe('fixed_pending_verify');
    const status = await call<{ verdict: { status: string } }>('GET', `/fleet/pti/units/${row.inspection.unitId}/status`);
    expect(status.verdict.status).toBe('out_of_service');

    // The unit page agrees, and offers the one action that would release it.
    await page.goto(`/fleet/trucks/${row.inspection.unitId}?tab=maintenance`);
    await expect(page.getByText('Out of service').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Verify & clear' })).toBeVisible();
  });

  test('rating a component Replace now flips the result and opens a card for it', async ({ page }) => {
    const call = await api();
    const row = await cleanUnit(call);
    await signIn(page);
    await page.goto(`/fleet/pti?review=${row.inspection.unitId}`);
    const drawer = page.getByRole('dialog');
    await drawer.getByRole('tab', { name: 'No issues' }).click();
    await drawer.getByRole('button', { name: 'Rate one by one' }).click();
    // A single-column list, never a grid: one group per component, stacked.
    const groups = drawer.getByRole('group', { name: /rating$/ });
    await expect(groups.first()).toBeVisible();
    const first = await groups.first().boundingBox();
    const second = await groups.nth(1).boundingBox();
    expect(second?.y ?? 0).toBeGreaterThan(first?.y ?? 0);
    expect(Math.abs((second?.x ?? 0) - (first?.x ?? 0))).toBeLessThan(2);

    await drawer.getByRole('group', { name: 'Brakes rating' }).getByRole('button', { name: 'Replace now', exact: true }).click();
    await expect(drawer.getByRole('tab', { name: /Issue found/ })).toHaveAttribute('aria-selected', 'true');
    await expect(drawer.getByRole('heading', { name: 'Issue 1 · Brakes' })).toBeVisible();
    await expect(drawer.getByRole('group', { name: 'Issue 1 · Brakes severity' }).getByRole('button', { name: 'Replace now' })).toHaveAttribute('aria-pressed', 'true');
    // Not saved: Escape leaves, after a word about the draft.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /Leave without saving/ })).toBeVisible();
  });
});
