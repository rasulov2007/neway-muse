import { expect, test, type Page } from '@playwright/test';

/**
 * A record created through the UI is on its list at once - no reload, ever.
 *
 * Regression for the round-3 P0: a broker created in the app took minutes and a refresh to
 * appear. Each test creates one record and reads the list in the same page session; nothing
 * here calls `page.reload()`. Names carry a stamp so repeated runs do not collide.
 */
const STAMP = Date.now().toString(36);
/** VINs forbid I, O and Q, so their suffix is digits only. */
const DIGITS = Date.now().toString();

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  if (!page.url().includes('/login')) return;
  await page.getByLabel(/Email/).fill('admin@neway.local');
  await page.getByLabel(/^Password/).fill('admin1234!');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
}

/** Picks an option from one of the app's Radix selects, by its accessible label. */
async function choose(page: Page, label: string, option: string | RegExp): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option }).first().click();
  // The list is portalled; the next field is not reachable until it has gone.
  await expect(page.getByRole('listbox')).toBeHidden();
}

test('a broker created on the form is on the brokers list without a reload', async ({ page }) => {
  test.setTimeout(120_000);
  const NAME = `E2E Broker ${STAMP}`;
  const MC = `${(Date.now() % 900_000) + 100_000}`;
  await signIn(page);
  await page.goto('/brokers/new');
  await page.getByLabel('Broker name').fill(NAME);
  await page.getByLabel('MC number').fill(MC);
  await page.getByLabel('USDOT').fill(`${Number(MC) + 1}`);
  await page.getByLabel('Street').fill('1 Test Way');
  await page.getByLabel('City').fill('Chicago');
  await page.getByLabel('State').fill('IL');
  await page.getByLabel('ZIP').fill('60601');
  await page.getByLabel('Contact name').fill('E2E Contact');
  await page.getByLabel('Email').fill(`e2e-${STAMP}@example.com`);
  await page.getByLabel('Phone').fill('+1 312 555 0100');
  const started = Date.now();
  await page.getByRole('button', { name: 'Add broker' }).click();
  await page.waitForURL(/\/brokers(\?|$)/);
  await expect(page.getByText(NAME).first()).toBeVisible();
  console.log(`broker create → visible in ${Date.now() - started} ms`);
});

test('a truck added from the trucks page is in the fleet list without a reload', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const UNIT = `E${STAMP.slice(-5).toUpperCase()}`;
  await signIn(page);
  await page.goto('/fleet/trucks');
  await page.getByRole('button', { name: 'Add truck' }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Add truck' });
  await dialog.getByLabel('Unit number').fill(UNIT);
  await dialog.getByLabel('VIN').fill(`1FUJGLDR5LLA${DIGITS.slice(-5)}`);
  await choose(page, 'Make', /Freightliner/);
  await dialog.getByLabel('Model').fill('Cascadia');
  await dialog.getByLabel('Year').fill('2024');
  // Nothing else is required: a unit exists before every detail is known (P1 #5).
  const started = Date.now();
  await dialog.getByRole('button', { name: 'Create truck' }).click();
  // The form goes to the new unit's page; the list must already know it on the way back, which
  // is an in-app navigation, not a reload.
  await page.waitForURL(/\/fleet\/trucks\//);
  await page.getByRole('link', { name: 'Trucks', exact: true }).first().click();
  await page.waitForURL(/\/fleet\/trucks(\?|$)/);
  await page.getByPlaceholder(/Search unit/).fill(UNIT);
  await expect(page.getByRole('link', { name: UNIT, exact: true })).toBeVisible();
  console.log(`truck create → visible in ${Date.now() - started} ms`);
});

test('a trailer added from the trailers page is in the list without a reload', async ({ page }) => {
  test.setTimeout(120_000);
  const UNIT = `T${STAMP.slice(-5).toUpperCase()}`;
  await signIn(page);
  await page.goto('/fleet/trailers');
  await page.getByRole('button', { name: 'Add trailer' }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Add trailer' });
  await dialog.getByLabel('Trailer number').fill(UNIT);
  await dialog.getByLabel('VIN').fill(`1GRAA0623KJ${DIGITS.slice(-6)}`);
  await dialog.getByLabel('Year').fill('2022');
  await dialog.getByLabel('Make').fill('Utility');
  await choose(page, 'Type', /Dry van/i);
  // Length, ownership, plate and the inspection date are optional (P1 #5).
  const started = Date.now();
  await dialog.getByRole('button', { name: /Add trailer|Create trailer/ }).click();
  await expect(dialog).toBeHidden();
  // Same as the truck: the new trailer's page, then back to the list in-app.
  await page.waitForURL(/\/fleet\/trailers\//);
  await page.getByRole('link', { name: 'Trailers', exact: true }).first().click();
  await page.waitForURL(/\/fleet\/trailers(\?|$)/);
  await page.getByPlaceholder(/Search trailer/).fill(UNIT);
  await expect(page.getByRole('link', { name: UNIT, exact: true }).first()).toBeVisible();
  console.log(`trailer create → visible in ${Date.now() - started} ms`);
});

test('a work order created from a unit is on the work orders list without a reload', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const TITLE = `E2E visible ${STAMP}`;
  await signIn(page);
  await page.goto('/fleet/trucks');
  await page.locator('table tbody tr').first().getByRole('link').first().click();
  await page.waitForURL(/\/fleet\/trucks\//);
  await page
    .getByRole('button', { name: /Create (repair|work order)/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Create work order' });
  await dialog.getByLabel('Title').fill(TITLE);
  const started = Date.now();
  await dialog.getByRole('button', { name: 'Create work order' }).click();
  await expect(dialog).toBeHidden();
  // In-app navigation, not a reload: the list must know the order from the write, not a refetch.
  await page.getByRole('link', { name: 'Maintenance', exact: true }).first().click();
  await page.waitForURL(/\/fleet\/maintenance/);
  await page.getByPlaceholder(/Search WO/).fill(TITLE);
  await expect(page.getByText(TITLE).first()).toBeVisible();
  console.log(`work order create → visible in ${Date.now() - started} ms`);
});
