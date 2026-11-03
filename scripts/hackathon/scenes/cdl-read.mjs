/**
 * Recruiting › Jordan Sampleton (fictional; DOT application submitted with date of birth
 * 1988-03-15) › Qualification file › CDL — front › Upload › the sample licence (born 1988-03-14).
 * Muse reads the card; the fields come back marked Sure / Check / Mismatch, and the date of birth
 * is flagged against the application. Nothing is uploaded: the scene stops before Upload.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CDL = join(root, 'docs', 'hackathon', 'samples', process.env.CDL_SAMPLE ?? 'cdl-sample-jordan-sampleton.png');
const CANDIDATE = process.env.CDL_CANDIDATE ?? 'apl_swd_jordan';

export default {
  name: 'CDL read by Muse',
  description: 'Recruiting candidate, upload CDL front, Muse fills the fields and flags the DOB mismatch',
  async run({ page, h }) {
    await h.goto('/hr/recruiting');
    await h.pause(1200);
    const card = page.getByText('Jordan Sampleton').first();
    if (await card.count()) {
      await h.click(card);
      await h.settle();
      await h.pause(1500);
    }
    // The qualification file (documents) view of the candidate.
    const open = page.getByRole('button', { name: 'Open the qualification file' });
    if (await open.isVisible().catch(() => false)) await h.click(open);
    else await h.goto(`/hr/recruiting/${CANDIDATE}?tab=documents`);
    await page.getByTestId('missing-cdl').waitFor({ timeout: 20_000 });
    await h.pause(1200);

    await h.click(page.getByTestId('missing-cdl').getByRole('button', { name: 'Upload' }));
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ timeout: 10_000 });
    await h.pause(800);
    const chooser = page.waitForEvent('filechooser', { timeout: 15_000 });
    await h.click(dialog.getByRole('button', { name: 'Choose file' }));
    await (await chooser).setFiles(CDL);

    const reading = dialog.getByText('Reading…').first();
    await reading.waitFor({ timeout: 10_000 }).catch(() => {});
    const from = Date.now();
    await reading.waitFor({ state: 'hidden', timeout: 120_000 });
    h.markWait(from, Date.now());
    // The dialog fits the screen: point at the flagged date of birth and hold.
    await h.moveTo(dialog.getByText('Mismatch').first());
    await h.pause(4500);
  },
};
