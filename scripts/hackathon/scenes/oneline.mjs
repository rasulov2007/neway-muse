/** One line card, NeWay AI powered by Meta Muse, 8 s. */
export default {
  name: 'oneline',
  description: 'One line card, NeWay AI powered by Meta Muse, 8 s',
  skipLogin: true,
  async run({ h }) {
    await h.card('oneline.html');
    await h.pause(8000);
  },
};
