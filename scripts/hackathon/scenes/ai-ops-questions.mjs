/**
 * Three operations questions in a row, each answered from the live tools:
 * late risk + route deviation, fuel anomalies, billing blocked by missing POD.
 */
export default {
  name: 'Operations questions',
  description: 'Late/off-route trucks, double fuel fills, loads blocked from billing',
  async run({ page, h }) {
    await h.goto('/ai');
    await h.pause(1000);
    // Fold the Morning brief card so the answers get the page.
    const hide = page.getByRole('button', { name: 'Hide the brief' });
    if (await hide.count()) {
      await h.click(hide);
      await h.pause(400);
    }
    await h.askAi('Is any truck off its route right now?', { holdMs: 3500 });
    // Missing PODs are in the Morning brief and the drive scene; the film has no room for a third.
    await h.askAi('Did anyone fuel twice within an hour this week?', { holdMs: 4000 });
  },
};
