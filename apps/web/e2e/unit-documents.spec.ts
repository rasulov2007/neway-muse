import { expect, test, type Page } from '@playwright/test';

/**
 * Unit documents, in a real browser against the real API:
 * open a truck → attach a registration whose expiry is already past → it is listed with an Expired
 * pill, opens in the viewer, shows as a chip beside the unit's status and is raised on the fleet
 * action queue → delete it, and every trace is gone.
 *
 * Runs as the administrator the product ships with. The document is a real row in the compliance
 * store, so the spec removes it at the end: an expired registration left on a unit would hold it
 * out of dispatch for everyone.
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

/** A 1×1 transparent PNG, so the viewer has an image to show. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const FILE_NAME = `registration-${Date.now().toString(36)}.png`;

test('a registration uploaded with a past expiry is listed, viewable and flagged, then deleted', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.goto('/fleet/trucks');
  await page.locator('table tbody tr').first().getByRole('link').first().click();
  await page.waitForURL(/\/fleet\/trucks\//);
  const truckUrl = page.url();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/^Unit /);

  // ---- upload ---------------------------------------------------------------------------------
  await page.getByRole('tab', { name: 'Documents' }).click();
  await page.getByRole('button', { name: 'Add document' }).first().click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Add document' });
  await expect(dialog.getByRole('combobox').first()).toContainText('Vehicle registration');
  await dialog
    .locator('input[type="file"]')
    .setInputFiles({ name: FILE_NAME, mimeType: 'image/png', buffer: PNG });
  await dialog.getByLabel('Issue date').fill('2025-01-15');
  await dialog.getByLabel('Expiry date').fill('2026-01-15');
  await dialog.getByLabel('Issuing state / authority').fill('Illinois SOS');
  await dialog.getByRole('button', { name: 'Add document' }).click();
  await expect(dialog).toBeHidden();

  // ---- listed with its status, and the unit wears the warning ------------------------------
  // One card per document type; the card that carries the file is the "row".
  const row = page.getByRole('listitem').filter({ hasText: FILE_NAME });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Vehicle registration');
  await expect(row.getByText('Expired', { exact: true })).toBeVisible();
  await expect(row).toContainText('holds dispatch');
  await expect(page.getByTestId('unit-document-chip')).toHaveText(/Vehicle registration expired/);

  // ---- viewable in the app --------------------------------------------------------------------
  await row.getByRole('button', { name: FILE_NAME, exact: true }).click();
  const viewer = page.getByTestId('document-viewer');
  await expect(viewer.locator('img')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText(FILE_NAME);
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();

  // ---- raised on the fleet action queue -------------------------------------------------------
  await page.goto('/fleet/trucks');
  await page.getByRole('button', { name: /^Needs attention \d+$/ }).click();
  const finding = page.getByRole('button', {
    name: /have an expired registration, inspection or other document/,
  });
  await expect(finding).toBeVisible();
  // The finding hands the list exactly the units behind it; this truck is one of them.
  await finding.click();
  await expect(page.getByText(/Showing the \d+ units? behind one finding\./)).toBeVisible();
  await page.keyboard.press('Escape');

  // ---- delete, and every trace is gone --------------------------------------------------------
  await page.goto(truckUrl);
  await page.getByRole('tab', { name: 'Documents' }).click();
  await page.getByRole('listitem').filter({ hasText: FILE_NAME }).getByRole('button', { name: `Delete ${FILE_NAME}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete document' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: FILE_NAME })).toHaveCount(0);
  // With the registration deleted the unit has nothing on file, which the chip now says in its
  // own words (round 3, P2 #12) rather than disappearing.
  await expect(page.getByTestId('unit-document-chip')).toContainText(/No registration|missing/i);
});
