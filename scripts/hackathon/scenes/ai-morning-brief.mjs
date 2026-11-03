/**
 * NeWay AI page: run the Morning brief, then ask a follow-up in chat.
 * Needs hackathon/muse (A1 Muse adapter + A2 tools and the Morning brief card) and META_API_KEY.
 */
export default {
  name: 'Morning brief',
  description: 'NeWay AI page: Run now on the Morning brief, then a follow-up question',
  async run({ page, h }) {
    await h.goto('/ai');
    await h.pause(1200);
    const run = page.getByRole('button', { name: 'Run now' });
    if (await run.count()) {
      await h.click(run);
      // "Running…" while Muse calls the tools: noted so compose.mjs --cut-waits shortens it.
      const from = Date.now();
      await page.getByRole('button', { name: 'Run now' }).waitFor({ timeout: 180_000 }); // back from "Running…"
      h.markWait(from, Date.now());
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await h.pause(3000);
      await h.moveTo({ x: 1500, y: 560 });
      await h.scroll(450);
      await h.pause(2000);
      // Fold the brief so the follow-up answer has the room.
      await h.click(page.getByRole('button', { name: 'Hide the brief' }));
      await h.pause(500);
    }
    await h.askAi('Which loads will miss their appointment today, and what should I tell the broker?', { holdMs: 3500 });
    await h.moveTo({ x: 1100, y: 600 });
    await h.scroll(250);
    await h.pause(2000);
  },
};
