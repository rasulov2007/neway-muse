import { expect, test, type Page } from '@playwright/test';

/**
 * Trailer parity, in a real browser against the real API:
 * open a trailer → write up a completed work order against it with a vendor created inline from
 * the nested modal → the order sits on the trailer's Maintenance tab and the vendor is a record →
 * the expense summary filtered to trailers returns that trailer's spend.
 *
 * Runs as the administrator the product ships with. The order and the vendor are real records in
 * the workspace and are left there: the vendor name carries a timestamp so a second run creates a
 * new one rather than tripping the duplicate-name refusal.
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

const STAMP = Date.now().toString(36);
const VENDOR = `E2E Trailer Shop ${STAMP}`;
const TITLE = `E2E brake reline ${STAMP}`;
const PRICE = '412.5';

test.describe.configure({ mode: 'serial' });

let trailerUnit = '';

test('writes up a completed trailer work order with a vendor created from the nested modal', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.goto('/fleet/trailers');
  await page.locator('table tbody tr').first().getByRole('link').first().click();
  await page.waitForURL(/\/fleet\/trailers\//);
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toContainText(/^Trailer /);
  trailerUnit = ((await heading.innerText()).match(/^Trailer (\S+)/) ?? [])[1] ?? '';
  expect(trailerUnit).not.toBe('');

  await page.getByRole('button', { name: 'Create work order' }).first().click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Create work order' });
  // The unit is fixed to the trailer the page is about, so the dialog explains the trailer rule
  // and offers the trailer catalog instead of asking for a unit.
  await expect(dialog).toContainText('Moving a trailer into a shop');
  await expect(dialog.getByRole('combobox', { name: 'Type' })).toBeVisible();
  await dialog.getByLabel('Title').fill(TITLE);

  // ---- vendor, created inline ---------------------------------------------------------------
  await dialog.getByRole('button', { name: 'Vendor' }).click();
  await page.keyboard.type(VENDOR);
  await page.locator('[cmdk-item]', { hasText: `Create vendor "${VENDOR}"` }).click();
  const vendorDialog = page.getByRole('dialog').filter({ hasText: 'Create vendor' });
  await expect(vendorDialog.getByLabel('Name')).toHaveValue(VENDOR);
  await vendorDialog.getByLabel('City').fill('Gary');
  await vendorDialog.getByLabel('State').fill('IN');
  await vendorDialog.getByRole('button', { name: 'Create vendor' }).click();
  await expect(vendorDialog).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Vendor' })).toContainText(VENDOR);

  // ---- completed, with the invoice that makes the amount real --------------------------------
  await dialog.getByRole('combobox').filter({ hasText: 'Open' }).click();
  await page.getByRole('option', { name: 'Completed' }).click();
  await dialog
    .locator('input[type="file"]')
    .setInputFiles({ name: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e') });
  await dialog.getByLabel('Price').fill(PRICE);
  await dialog.getByRole('button', { name: 'Create work order' }).click();
  await expect(dialog).toBeHidden();

  // ---- it is a fact about the trailer, and the vendor is a record ---------------------------
  await page.getByRole('tab', { name: 'Maintenance' }).click();
  await expect(page.getByText(TITLE)).toBeVisible();
  await page.goto('/fleet/vendors');
  await expect(page.getByRole('link', { name: VENDOR })).toBeVisible();
});

test('the expense summary filtered to trailers returns the trailer spend', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(trailerUnit === '', 'needs the order written up by the previous test');
  await signIn(page);
  await page.goto('/fleet');
  await page.getByRole('tablist', { name: 'Unit type' }).getByRole('tab', { name: 'Trailers' }).click();
  await expect(page).toHaveURL(/unitType=trailer/);
  await expect(page.getByRole('heading', { name: 'Vehicles', exact: true })).toBeVisible();
  // The trailer's row carries the brake job at a real amount. Earlier runs leave their own orders
  // on the same trailer, so the figure is "at least this run's invoice", not exactly it.
  const row = page.getByRole('row', { name: new RegExp(`^${trailerUnit} Trailer`) });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Brake inspection');
  const spend = Number(((await row.innerText()).match(/\$([\d,]+\.\d{2})/) ?? [])[1]?.replace(/,/g, '') ?? 0);
  expect(spend).toBeGreaterThanOrEqual(Number(PRICE));
  // Trucks are not in a trailer-only answer.
  await expect(page.getByRole('row', { name: / Truck\d{4} / })).toHaveCount(0);
});
