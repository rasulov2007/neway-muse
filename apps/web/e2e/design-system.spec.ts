import { expect, test } from '@playwright/test';

/**
 * The v3 design contract, asserted against the running app.
 *
 * These are the Phase 4 QA items that can be checked mechanically. They live here rather than in a
 * checklist because a checklist is true on the day it is ticked: the filled table header came back
 * twice during this restyle, and a grep cannot see a computed background.
 */

test('the UI family is Geist, not a system fallback', async ({ page }) => {
  await page.goto('/dashboard');
  const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(family).toContain('Geist');
});

test('tables use the v3 recipe: no filled header, 10.5px tracked labels, 44px rows', async ({
  page,
}) => {
  await page.goto('/loads');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('table tbody tr').first()).toBeVisible();

  const shape = await page.evaluate(() => {
    const th = document.querySelector('table thead th') as HTMLElement;
    const td = document.querySelector('table tbody td') as HTMLElement;
    const tr = document.querySelector('table tbody tr') as HTMLElement;
    const thStyle = getComputedStyle(th);
    return {
      headerBg: thStyle.backgroundColor,
      headerSize: thStyle.fontSize,
      headerTransform: thStyle.textTransform,
      headerTracking: thStyle.letterSpacing,
      rowHeight: tr.getBoundingClientRect().height,
      dense: tr.className.includes('dense'),
      cellNumerals: getComputedStyle(td).fontVariantNumeric,
    };
  });

  // Transparent, or painted by the surface behind it — never its own grey band.
  expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(shape.headerBg);
  expect(shape.headerSize).toBe('10.5px');
  expect(shape.headerTransform).toBe('uppercase');
  expect(parseFloat(shape.headerTracking)).toBeGreaterThan(0.5);
  // 44px standard, 40px on a table that opted into `dense` — both are v3 row heights.
  expect([40, 44]).toContain(Math.round(shape.rowHeight));
  expect(shape.cellNumerals).toContain('tabular-nums');
});

test('numeric columns are right-aligned', async ({ page }) => {
  await page.goto('/fleet/trucks');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  const rightAligned = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('table tbody td')] as HTMLElement[];
    // A cell whose text is purely numeric must not be left-aligned.
    const numeric = cells.filter((c) => /^[\d,.$%\s-]+$/.test(c.textContent?.trim() ?? '') && c.textContent?.trim());
    return {
      total: numeric.length,
      wrong: numeric.filter((c) => getComputedStyle(c).textAlign === 'left').length,
    };
  });
  expect(rightAligned.total).toBeGreaterThan(0);
  expect(rightAligned.wrong).toBe(0);
});

test('keyboard focus is visible on interactive elements', async ({ page }) => {
  await page.goto('/loads');
  await page.waitForLoadState('networkidle');

  // Tab into the page and confirm whatever holds focus paints a ring rather than nothing.
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const s = getComputedStyle(el);
    return { outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle, tag: el.tagName };
  });
  expect(focus).not.toBeNull();
  expect(focus?.outlineStyle).not.toBe('none');
  expect(parseFloat(focus?.outlineWidth ?? '0')).toBeGreaterThanOrEqual(2);
});

test('status values render as pills, never as bare text', async ({ page }) => {
  await page.goto('/loads');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('table tbody tr').first()).toBeVisible();

  // Every cell in the Status column must contain a fully-rounded chip.
  const statusCells = await page.evaluate(() => {
    const headers = [...document.querySelectorAll('table thead th')].map((h) =>
      h.textContent?.trim().toLowerCase(),
    );
    const index = headers.indexOf('status');
    if (index < 0) return { checked: 0, bare: 0 };
    const rows = [...document.querySelectorAll('table tbody tr')];
    let bare = 0;
    let checked = 0;
    for (const row of rows) {
      const cell = row.children[index] as HTMLElement | undefined;
      if (!cell?.textContent?.trim()) continue;
      checked += 1;
      const chip = cell.querySelector('span');
      const radius = chip ? parseFloat(getComputedStyle(chip).borderRadius) : 0;
      if (radius < 100) bare += 1;
    }
    return { checked, bare };
  });
  expect(statusCells.checked).toBeGreaterThan(0);
  expect(statusCells.bare).toBe(0);
});

test('page padding, section gap and card radius match the v3 layout tokens', async ({ page }) => {
  await page.goto('/dashboard');
  const layout = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      pagePadding: root.getPropertyValue('--page-padding').trim(),
      sectionGap: root.getPropertyValue('--section-gap').trim(),
      sidebar: root.getPropertyValue('--sidebar-width').trim(),
      topbar: root.getPropertyValue('--topbar-height').trim(),
      cardRadius: root.getPropertyValue('--radius-lg').trim(),
      controlRadius: root.getPropertyValue('--radius-md').trim(),
    };
  });
  expect(layout).toEqual({
    pagePadding: '28px',
    sectionGap: '20px',
    sidebar: '232px',
    topbar: '56px',
    cardRadius: '12px',
    controlRadius: '8px',
  });
});
