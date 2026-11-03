/** Closing card: the next big update (load marketplace) and two smaller ones. 6 s. */
export default {
  name: 'Next: load marketplace',
  description: 'What is next card (local HTML), 6 s',
  skipLogin: true,
  async run({ h }) {
    await h.card('marketplace.html');
    await h.pause(6000);
  },
};
