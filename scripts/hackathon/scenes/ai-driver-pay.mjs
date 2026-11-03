/**
 * NeWay AI page: payroll. Muse previews the company drivers' pay statements for the pay week
 * (driver_statements_preview, a tool from before the hackathon) and flags what looks wrong.
 * Dry run stays on: nothing is generated or paid.
 */
const PROMPT = process.env.PAY_PROMPT ?? "Prepare last week's pay statements for our company drivers and flag anything unusual.";

export default {
  name: 'Driver pay',
  description: 'NeWay AI: preview the week\'s driver pay statements and flag anything unusual',
  async run({ page, h }) {
    await h.goto('/ai');
    await h.pause(800);
    const hide = page.getByRole('button', { name: 'Hide the brief' });
    if (await hide.count()) {
      await h.click(hide);
      await h.pause(400);
    }
    await h.askAi(PROMPT, { holdMs: 1500 });
    // The answer lands scrolled to its cards: go back up to the flags first, then down to the table.
    await h.moveTo({ x: 1200, y: 520 });
    await h.scroll(-1600, 40);
    await h.pause(4000);
    await h.scroll(700, 40);
    await h.pause(3000);
  },
};
