/** Papers that expire soon, then the hiring pipeline (stuck candidates, MVR/PSP waits). */
export default {
  name: 'Compliance and hiring',
  description: 'Expiring CDL / medical / registration, then stuck candidates waiting on MVR/PSP',
  async run({ page, h }) {
    await h.goto('/ai');
    await h.pause(1200);
    await h.askAi('Whose papers expire in the next 30 days? Anything already expired?', { holdMs: 4000 });
    await h.askAi('Which candidates are stuck in hiring, and who is waiting on MVR or PSP?', { holdMs: 4500 });
  },
};
