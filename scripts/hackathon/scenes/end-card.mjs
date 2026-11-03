/** End card, logo + impact numbers, 21 s. */
export default {
  name: 'end-card',
  description: 'End card, logo + impact numbers, 21 s',
  skipLogin: true,
  async run({ h }) {
    await h.card('end.html');
    await h.pause(21000);
  },
};
