/**
 * Loads › Add load › Browse files › a broker's rate confirmation (fictional sample PDF). Muse reads
 * it and the form fills itself. Needs the API started with RC_READER_PROVIDER=muse (demo-up does).
 * Nothing is created: the scene stops before "Create load".
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RC = join(root, 'docs', 'hackathon', 'samples', process.env.RC_SAMPLE ?? 'rc-sample-2-example-logistics-reefer.pdf');

export default {
  name: 'Rate confirmation read by Muse',
  description: 'Add load, choose an RC PDF, the form fills itself',
  async run({ page, h }) {
    await h.goto('/loads');
    await h.pause(1200);
    await h.click(page.getByRole('button', { name: 'New load' }).first());
    const dialog = page.getByRole('dialog', { name: 'Add load' });
    await dialog.waitFor({ timeout: 15_000 });
    await h.pause(1200);

    const rcBox = dialog.getByRole('region', { name: 'Rate confirmation' });
    const chooser = page.waitForEvent('filechooser', { timeout: 15_000 });
    await h.click(rcBox.getByRole('button', { name: 'Browse files' }));
    await (await chooser).setFiles(RC);

    // "Reading the RC…" while Muse reads; noted so compose.mjs --cut-waits can shorten it.
    const reading = dialog.getByText('Reading the RC…');
    await reading.waitFor({ timeout: 10_000 }).catch(() => {});
    const from = Date.now();
    await reading.waitFor({ state: 'hidden', timeout: 180_000 });
    h.markWait(from, Date.now());
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await h.pause(2000);
    // Show the filled form: stops, rate, broker.
    await h.moveTo({ x: 960, y: 640 });
    await h.scroll(500);
    await h.pause(2000);
    await h.scroll(600);
    await h.pause(2500);
  },
};
