/**
 * Fleet › Trucks, then NeWay AI in the side panel: "Which documents is truck 1118 missing?"
 * (seed: no insurance cab card; IFTA licence expiring). Then "Open truck 1118" from the answer.
 */
export default {
  name: 'Truck papers',
  description: 'Trucks list, ask which documents truck 1118 is missing, open the truck',
  async run({ page, h }) {
    await h.goto('/fleet/trucks');
    await h.pause(1500);
    await h.click(page.getByRole('button', { name: 'Open NeWay AI' }));
    await h.pause(600);
    await h.askAi('Which documents is truck 1118 missing?', { holdMs: 3500 });
    const open = page.getByRole('button', { name: /Open truck 1118/ }).or(page.getByRole('link', { name: /Open truck 1118/ })).first();
    if (await open.count()) {
      await h.click(open);
      // The truck page draws skeletons first (no "Loading…" text): wait for real content.
      await page.getByText('Truck information').first().waitFor({ timeout: 20_000 }).catch(() => {});
      await h.pause(1200);
      const docs = page.getByRole('tab', { name: 'Documents' });
      if (await docs.count()) {
        await h.click(docs);
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        await h.pause(3000);
      } else await h.pause(3000);
    }
  },
};
