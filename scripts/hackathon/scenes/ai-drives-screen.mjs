/**
 * The wow: NeWay AI drives the app. On load L-4117 (delivered, no POD) ask why it can't be billed,
 * switch the chat from Dry run to Live, then ask Muse to show it on screen and message the driver.
 * Muse opens the Documents tab, presses "Message driver", types the message in the Inbox and, at
 * "Send" (a risky press), stops and asks: the scene presses Allow and the message goes out.
 *
 * Writes one Inbox message to the demo driver in the local demo database (nothing leaves the PC).
 */
const DRIVE_PROMPT = 'Show me on the screen: open the Documents tab, then message the driver asking for the POD, and press Send.';

export default {
  name: 'NeWay AI drives the screen',
  description: 'Load L-4117: why no invoice, then Muse opens Documents, messages the driver, asks Allow before Send',
  async run({ page, h }) {
    await h.goto('/loads/L-4117');
    await h.pause(1200);
    await h.click(page.getByRole('button', { name: 'Open NeWay AI' }));
    await h.pause(800);
    await h.askAi('Why can L-4117 not be invoiced yet?', { holdMs: 2500 });

    // Dry run is on for every new chat; an administrator switches this one to Live.
    await h.click(page.getByRole('switch', { name: 'Dry run' }));
    await page.getByText('Live', { exact: true }).first().waitFor({ timeout: 10_000 });
    await h.pause(900);

    const box = page.getByLabel('Message');
    await h.type(box, DRIVE_PROMPT, { wpm: 260 });
    await h.pause(400);
    await page.keyboard.press('Enter');

    // Muse now works the page with its own cursor. Answer the risky "Send" with Allow.
    const dock = page.getByRole('region', { name: 'NeWay AI at work' });
    const allow = page.getByRole('button', { name: 'Allow' });
    const deadline = Date.now() + 240_000;
    let allowed = false;
    let nudged = false;
    let nudgedAt = 0;
    // Model time between steps ("Thinking…", or the chat's "Working…" before the first step) is
    // noted so compose.mjs --cut-waits can shorten it; the screen steps themselves stay.
    let thinkingFrom = Date.now();
    for (;;) {
      if (Date.now() > deadline) throw new Error('NeWay AI did not finish driving in 4 minutes');
      if (!allowed && (await allow.count())) {
        if (thinkingFrom) h.markWait(thinkingFrom, Date.now());
        thinkingFrom = null;
        await h.pause(1800); // let the viewer read "NeWay AI wants to press 'Send'"
        await h.click(allow);
        allowed = true;
      }
      const text = (await dock.innerText().catch(() => '')) || '';
      // A nudge answered in the chat alone (no screen run) ends the take after a minute.
      if (nudged && !text && Date.now() - nudgedAt > 60_000) break;
      const thinking = !text || text.includes('Thinking…');
      if (thinking && !thinkingFrom) thinkingFrom = Date.now();
      if (!thinking && thinkingFrom) {
        h.markWait(thinkingFrom, Date.now());
        thinkingFrom = null;
      }
      if (text.startsWith('NeWay AI finished')) {
        if (allowed || nudged) break;
        // Muse sometimes types the message and stops short of Send: say yes in the chat once.
        nudged = true;
        nudgedAt = Date.now();
        await h.pause(1500);
        await h.click(dock.getByRole('button', { name: 'Open chat' }));
        await h.pause(600);
        await h.type(page.getByLabel('Message'), 'Yes, press Send.', { wpm: 260 });
        await page.keyboard.press('Enter');
        thinkingFrom = Date.now();
        await dock.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
        await h.sleep(1500);
        continue;
      }
      await h.sleep(200);
    }
    if (!allowed) console.warn('  (no Allow prompt this take: Muse did not press Send)');
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await h.pause(3000);
  },
};
