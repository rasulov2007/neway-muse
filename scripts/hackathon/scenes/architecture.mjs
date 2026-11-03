/** Architecture card: apps -> NeWay API (permission-checked tools) -> Meta Muse. 8 s. */
export default {
  name: 'Architecture',
  description: 'How it works diagram card (local HTML), 8 s',
  skipLogin: true,
  async run({ h }) {
    await h.card('architecture.html');
    await h.pause(8000);
  },
};
