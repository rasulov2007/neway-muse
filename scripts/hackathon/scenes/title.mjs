/** Title card: NeWay TMS × Meta Muse, the two companies that run on it. 5 s. */
export default {
  name: 'Title',
  description: 'Title card (local HTML, Porcelain look), 5 s',
  skipLogin: true,
  async run({ h }) {
    await h.card('title.html');
    await h.pause(5000);
  },
};
