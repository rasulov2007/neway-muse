import { expect, test, type Page } from '@playwright/test';

/**
 * Every document in this product opens in the same viewer, in a real browser against the real API.
 *
 * The bug this covers: a document row was an `<a href="/api/v1/…/file">`, and a browser navigation
 * carries no `Authorization` header — the API answered 401 and the click did nothing. So each flow
 * here uploads a file, sees it listed without a reload, opens it in the shared viewer and saves it,
 * which is exactly the path that was broken.
 *
 * Three kinds of paperwork, because they come from two different stores: a driver's compliance
 * document, a load's rate confirmation and a work order's invoice.
 *
 * Runs as the administrator the product ships with. Everything uploaded is a real record and is
 * stamped, so a repeat run never collides with the last one.
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

/** A 1×1 transparent PNG, so the viewer has a real image to show. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const STAMP = Date.now().toString(36);
let nth = 0;
/** A file name nothing else in this workspace can have, so a repeat run never collides. */
const FILE = (what: string) => ({
  name: `${what}-${STAMP}-${(nth += 1).toString(36)}.png`,
  mimeType: 'image/png',
  buffer: PNG,
});

/** Chooses a file for the hidden input a button opens. */
async function choose(page: Page, open: () => Promise<void>, file: ReturnType<typeof FILE>) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), open()]);
  await chooser.setFiles(file);
}

/** Opens the viewer's image, saves the file, and closes. One assertion set for all three flows. */
async function viewAndDownload(page: Page, fileName: string) {
  const viewer = page.getByTestId('document-viewer');
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('img')).toBeVisible({ timeout: 30_000 });

  const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('document-viewer') });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Download' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(fileName);

  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(viewer).toBeHidden();
}

test('a driver compliance document opens in the viewer and downloads', async ({ page }) => {
  test.setTimeout(180_000);
  const file = FILE('driver-doc');
  await signIn(page);

  await page.goto('/safety/compliance');
  const table = page.getByTestId('compliance-driver-table');
  await expect(table.locator('table tbody tr').first()).toBeVisible({ timeout: 60_000 });
  await table.locator('table tbody tr').first().click();

  const drawer = page.getByRole('dialog').first();
  await expect(drawer).toBeVisible();

  // Every unsatisfied requirement can be answered with a document; the first one will do.
  await drawer.getByRole('button', { name: 'Attach…' }).first().click();
  // The drawer behind it also says "Attach…", so the dialog is found by its own action.
  const upload = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: 'Attach document' }) });
  await choose(page, () => upload.getByRole('button', { name: 'Choose file…' }).click(), file);
  await expect(upload).toContainText(file.name);
  // A requirement that expires refuses a document with no expiry date.
  await upload.getByRole('textbox', { name: 'Expires on' }).fill('12/31/2030');
  await upload.getByRole('button', { name: 'Attach document' }).click();
  await expect(upload).toBeHidden();

  // Listed in the driver's own Documents tab, with no reload.
  await drawer.getByRole('tab', { name: 'Documents' }).click();
  const row = drawer.getByRole('listitem').filter({ hasText: file.name });
  await expect(row).toBeVisible({ timeout: 30_000 });

  await row.getByRole('button', { name: 'View' }).click();
  await viewAndDownload(page, file.name);
});

test('a load rate confirmation opens in the viewer and downloads', async ({ page }) => {
  test.setTimeout(180_000);
  const file = FILE('rate-con');
  await signIn(page);

  await page.goto('/loads');
  // The load number is not a link; the row opens the load — clicked on the number's own cell,
  // because the customer and broker cells are buttons of their own.
  await page.locator('table tbody tr').first().getByRole('cell').nth(1).click();
  await page.waitForURL(/\/loads\/L-/, { timeout: 60_000 });
  await page.getByRole('tab', { name: 'Documents' }).click();

  // The rate confirmation always has a row, filed or not: Upload when it is missing, Replace when
  // something is already on file. Either button opens the same picker.
  const rcRow = page.getByRole('listitem').filter({ hasText: 'Rate con' }).first();
  const attach = rcRow.getByRole('button', { name: /^Upload$|^Replace / }).first();
  await choose(page, () => attach.click(), file);

  await expect(rcRow).toContainText(file.name, { timeout: 60_000 });
  // The thumbnail and the eye both open it; the eye is the one a person aims at.
  await rcRow.getByRole('button', { name: /^View / }).last().click();
  await viewAndDownload(page, file.name);
});

test('a work order invoice opens in the viewer and downloads', async ({ page }) => {
  test.setTimeout(180_000);
  const file = FILE('invoice');
  await signIn(page);

  await page.goto('/fleet/maintenance');
  await page.locator('table tbody tr').first().getByRole('link').first().click();
  await page.waitForURL(/\/fleet\/maintenance\/.+/, { timeout: 60_000 });
  await page.getByRole('tab', { name: 'Documents' }).click();

  await page.getByRole('button', { name: 'Add an invoice' }).first().click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Attach an invoice' });
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await dialog.getByRole('button', { name: 'Attach', exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  const row = page.getByRole('listitem').filter({ hasText: file.name });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole('button', { name: file.name, exact: true }).click();
  await viewAndDownload(page, file.name);
});
