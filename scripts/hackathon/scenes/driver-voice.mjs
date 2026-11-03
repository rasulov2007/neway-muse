/**
 * Driver app, Ask NeWay by voice. The driver app's web build runs in a phone frame
 * (cards/phone.html) beside a caption; Chromium's fake microphone plays the Uzbek sample, so every
 * take hears the same words: the owner asking in Uzbek (uz-owner-next-pickup.wav). The SAPI clip
 * (uz-next-pickup.wav) needs 8 dB more level (uz-next-pickup-loud-48k.wav): at its own level the
 * browser's noise suppression left Meta only the first word.
 *
 * Before recording (local only):
 *   cd apps/mobile && MSYS_NO_PATHCONV=1 EXPO_PUBLIC_API_URL=/api/v1 npx expo export --platform web --output-dir <dist-web>
 *   API_TARGET=http://127.0.0.1:3100 node apps/mobile/scripts/web-demo-server.mjs <dist-web> 8094
 * The seed gives one demo driver an app login (DRIVER_EMAIL below; password = the demo password).
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const APP = process.env.DRIVER_APP_URL ?? 'http://localhost:8094';
const DRIVER_EMAIL = process.env.DEMO_DRIVER_EMAIL ?? 'trevor.gaines@silkway-demo.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'MuseDemo-2026!';
const CLIP = process.env.VOICE_CLIP ?? join(root, 'docs', 'hackathon', 'samples', 'voice', 'uz-owner-next-pickup.wav');
const CLIP_SECONDS = Number(process.env.VOICE_CLIP_SECONDS ?? 3.2);

export default {
  name: 'Driver voice (Uzbek)',
  // Record with --hq: the screencast drops to every 6th frame while the mic records (h.captureRate).
  description: 'Driver app in a phone frame, Uzbek voice question, Muse answers in Uzbek',
  skipLogin: true,
  launchArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${CLIP}`],
  async run({ page, h }) {
    const frameUrl = `${pathToFileURL(join(here, '..', 'cards', 'phone.html')).href}?src=${encodeURIComponent(`${APP}/login`)}`;
    await page.goto(frameUrl, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready).catch(() => {});
    const app = page.frameLocator('#app');

    // Sign in off camera.
    await app.getByPlaceholder('you@company.com').fill(DRIVER_EMAIL, { timeout: 60_000 });
    await app.getByPlaceholder('Your password').fill(PASSWORD);
    await app.getByRole('button', { name: 'Log in' }).click();
    // A fresh session may offer Face ID / notifications: decline whatever appears.
    const ask = app.getByText('Ask NeWay').first();
    for (let i = 0; i < 40 && !(await ask.isVisible().catch(() => false)); i += 1) {
      const notNow = app.getByRole('button', { name: 'Not now' });
      if (await notNow.isVisible().catch(() => false)) await notNow.click();
      await h.sleep(500);
    }
    await h.sleep(1200);
    h.markStart();
    await h.pause(1000);

    await h.click(ask);
    await app.getByRole('button', { name: 'Hold to talk' }).waitFor({ timeout: 20_000 });
    // No Uzbek voice in this browser: show the answer as text only (the voice-over says it).
    const aloud = app.getByRole('switch', { name: 'Read answers aloud' });
    if ((await aloud.count()) && (await aloud.getAttribute('aria-checked', { timeout: 2_000 }).catch(() => null)) === 'true') await aloud.click({ timeout: 2_000 }).catch(() => {});
    await h.pause(1000);

    // Hold the mic for the length of the clip, then let go to send.
    const mic = app.getByRole('button', { name: 'Hold to talk' });
    await h.moveTo(mic);
    await h.sleep(300);
    // Capture fewer frames while the mic records: the full-rate screencast starves the page's
    // audio thread and Meta hears a broken clip.
    await h.captureRate(6);
    await page.mouse.down();
    await h.sleep(CLIP_SECONDS * 1000 - 100); // shorter than the clip: the fake mic loops it
    await page.mouse.up();
    await h.captureRate(1);

    const from = Date.now();
    await app.getByText(/Heard by Meta Muse/).waitFor({ timeout: 90_000 });
    // The answer arrives with the "Heard by" line; let it settle on screen.
    h.markWait(from, Date.now());
    await h.pause(5500);
  },
};
