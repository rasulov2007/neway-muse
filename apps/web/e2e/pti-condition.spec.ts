import { expect, test, type Page } from '@playwright/test';

/**
 * The PTI condition loop, in a real browser against the real API:
 * open the general modal → search a unit → file a No-issues PTI with three component ratings →
 * the board shows the Condition pill and the window → "Due soon" finds it → open a work order from
 * a Replace-now rating → completing it resets the component.
 *
 * Runs as the administrator the product ships with. Every write lands in the workspace, so the
 * spec picks the first unit on the board and cleans nothing up: a second run re-rates the same
 * unit, which the append-only history is designed for.
 */

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  if (!page.url().includes('/login')) return;
  await page.getByLabel(/Email/).fill('admin@neway.local');
  await page.getByLabel(/^Password/).fill('admin1234!');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
}

/** Presses a segment unless it is already the choice — pressing it again clears it (by design). */
async function rate(page: Page, component: string, rating: string): Promise<void> {
  const segment = page
    .getByRole('group', { name: `${component} rating` })
    .getByRole('button', { name: rating, exact: true });
  if ((await segment.getAttribute('aria-pressed')) !== 'true') await segment.click();
}

/*
 * The general modal this spec drives is the pre-fleet_v2 path. With the flag on - which it is
 * in development, where this suite runs - "Update PTI" opens the review drawer instead, covered
 * by pti-drawer.spec.ts. The condition loop's rating and work-order steps are exercised there
 * and in the vitest suites; this spec is kept for the day the flag is off in a test run.
 */
test.skip(true, 'Pre-fleet_v2 modal; the flag is on in development. See pti-drawer.spec.ts.');

test('files ratings through the general modal, plans from them, and closes the loop', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.goto('/fleet/pti');
  const dialogTitle = page.getByRole('dialog').getByRole('heading', { level: 2 });

  // ---- the general action, with unit search ------------------------------------------------
  await page.getByRole('button', { name: 'Update PTI' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Unit' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Unit' }).click();
  const firstOption = page.locator('[cmdk-item]').first();
  const unit = ((await firstOption.innerText()).split(/\r?\n/)[0] ?? '').trim();
  await page.keyboard.press('Enter');
  await expect(dialogTitle).toContainText(`Unit ${unit}`);

  // ---- a No-issues review with three ratings --------------------------------------------------
  await dialog
    .getByRole('combobox')
    .filter({ hasText: /NOT REVIEWED YET|NO ISSUES|ISSUE FOUND/ })
    .click();
  await page.getByRole('option', { name: 'NO ISSUES' }).click();
  await expect(dialog.getByText('Condition', { exact: true })).toBeVisible();
  await rate(page, 'Steer tyres', 'Good');
  await rate(page, 'Brakes', 'Monitor');
  // A previous run leaves the lights on Replace now; rating them Good makes this pass's worst
  // rating the one it files below, whatever the history holds.
  await rate(page, 'Lights & reflectors', 'Good');
  await rate(page, 'Drive tyres', 'Replace soon');
  await dialog.getByLabel('Drive tyres expected window').fill('2');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  // ---- the board shows the pill and the window, and Due soon finds it ------------------------
  const row = page
    .getByRole('row')
    .filter({ has: page.getByText(unit, { exact: true }) })
    .first();
  await expect(row.getByText('Replace soon')).toBeVisible();
  await expect(row.getByText(/Drive tyres · \d+d left/)).toBeVisible();
  const dueSoonTile = page.getByRole('button', { name: /^\d+ Due soon$/ });
  await dueSoonTile.click();
  await expect(
    page.getByRole('row').filter({ has: page.getByText(unit, { exact: true }) }),
  ).toHaveCount(1);
  await dueSoonTile.click();

  // ---- Replace now opens a work order carrying the component -------------------------------
  await row.getByRole('button', { name: 'Update PTI' }).click();
  await rate(page, 'Lights & reflectors', 'Replace now');
  await dialog.getByRole('button', { name: /Open a work order for lights/ }).click();
  await expect(dialog).toBeHidden();
  const opened = page.getByText(/Work order RO-\d+ opened/).first();
  await expect(opened).toBeVisible();
  const roNumber = (await opened.innerText()).match(/RO-\d+/)?.[0] ?? '';
  expect(roNumber).not.toBe('');

  // ---- the shop finishes it: attaching the invoice completes the order and resets the component
  // A full navigation reloads the workspace from the server; the write above is saved on a short
  // debounce, so give it the moment it needs rather than racing it.
  await page.waitForTimeout(2_500);
  await page.goto(`/fleet/maintenance?q=${roNumber}`);
  await page.getByRole('link', { name: roNumber, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(roNumber);
  await expect(page.getByText(/Lights & reflectors: rated Replace now/).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Documents' }).click();
  await page.getByRole('button', { name: 'Add an invoice' }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'invoice.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 e2e'),
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Attach', exact: true }).click();
  await expect(page.getByText(/completed/i).first()).toBeVisible();

  // ---- the truck page reads Good again ---------------------------------------------------------
  const truckLink = page.getByRole('link', { name: new RegExp(`^(Unit )?${unit}$`) }).first();
  await truckLink.click();
  await page.getByRole('tab', { name: 'Maintenance' }).click();
  const lights = page
    .getByRole('tabpanel')
    .locator('li')
    .filter({ hasText: 'Lights & reflectors' })
    .first();
  await expect(lights).toBeVisible();
  await expect(lights.getByText('Good')).toBeVisible();
  await expect(lights.getByText(/completed/)).toBeVisible();
});
