/** Built during the hackathon card (honest scope), 9 s. */
export default {
  name: 'built-during',
  description: 'Built during the hackathon card (honest scope), 9 s',
  skipLogin: true,
  async run({ h }) {
    await h.card('built.html');
    await h.pause(9000);
  },
};
