/**
 * Pipeline proof against the UI that exists today: Dashboard -> Daily board -> one load in transit.
 * No AI here (it works without a model key); the real scenes add h.askAi(...).
 */
export default {
  name: 'Placeholder: dashboard, Daily board, a load',
  description: 'Proves record -> compose on the existing UI (no AI needed)',
  async run({ page, h }) {
    await h.goto('/dashboard');
    await h.pause(2500);
    await h.scroll(500);
    await h.pause(1500);

    await h.goto('/dispatch/daily');
    await h.pause(2500);
    await h.moveTo({ x: 900, y: 520 });
    await h.pause(1500);

    // L-4101: Chicago -> Atlanta, in transit, on time.
    await h.goto('/loads/L-4101');
    await h.pause(3000);
    await h.scroll(400);
    await h.pause(1500);
  },
};
