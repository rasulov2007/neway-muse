#!/usr/bin/env node
/**
 * The final hackathon film (v3 script, HACKATHON-VIDEO-SCRIPT.md) and its 30-second cut.
 *
 *   node scripts/hackathon/final.mjs            -> docs/hackathon/video/neway-muse-final.mp4 + final-subtitles.srt
 *   node scripts/hackathon/final.mjs --short    -> docs/hackathon/video/neway-muse-30s.mp4
 *   options: --only-overlays, --keep (keep docs/hackathon/video/.work), --voice en-US-AndrewNeural
 *
 * Inputs: the 2x clips in docs/hackathon/video/raw2x (record.mjs --hq --scale 2), the 1080p clips
 * in raw/, the voice-over from tts.py (docs/hackathon/video/tts/<voice>/<id>.mp3, lines in
 * vo-lines.json) and the owner's Uzbek recording. Every spoken line is burned in as an English
 * subtitle (and written to the .srt). Overlays (scene titles, subtitles, labels) are rendered by
 * Chromium in Manrope with the Porcelain card tokens, so the film looks like the product.
 *
 * Each segment is a stretch of one clip: speed (typing at 3-4x), freeze holds, and a camera
 * (zoompan keyframes in the 1920x1080 CSS space of the page: centre x/y and zoom, eased) that
 * crops 150-240 % into the 3840x2160 recording so text stays sharp. Music: a soft pad
 * synthesised here with ffmpeg (no downloaded audio), ducked under the voice.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const { chromium } = require('playwright');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const SHORT = flag('short');
const VOICE = opt('voice', 'en-US-AndrewNeural');
const VID = join(root, 'docs', 'hackathon', 'video');
const RAW2 = join(VID, 'raw2x');
const RAW1 = join(VID, 'raw');
const TTS = join(VID, 'tts', VOICE);
const WORK = join(VID, '.work', SHORT ? 'short' : 'full');
const OUT = join(VID, SHORT ? 'neway-muse-30s.mp4' : 'neway-muse-final.mp4');
const OWNER_WAV = join(root, 'docs', 'hackathon', 'samples', 'voice', 'uz-owner-next-pickup-loud-48k.wav');
const FPS = 30;
const LINES = Object.fromEntries(JSON.parse(readFileSync(join(here, 'vo-lines.json'), 'utf8')).lines.map((l) => [l.id, l]));

function run(args, what) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`ffmpeg (${what}) failed: ${r.stderr?.slice(-2000)}`);
}
function duration(file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  const t = [...(r.stderr ?? '').matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].at(-1);
  if (!t) throw new Error(`No duration for ${file}`);
  return Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
}

// ------------------------------------------------------------------------------------ sources

const SRC = {
  hero: { file: join(RAW2, 'ai-drives-screen.webm'), scale: 2 },
  rc: { file: join(RAW2, 'rc-drop.webm'), scale: 2 },
  cdl: { file: join(RAW2, 'cdl-read.webm'), scale: 2 },
  dv: { file: join(RAW2, 'driver-voice.webm'), scale: 2 },
  brief: { file: join(RAW2, 'ai-morning-brief.webm'), scale: 2 },
  pay: { file: join(RAW2, 'ai-driver-pay.webm'), scale: 2 },
  one: { file: join(RAW2, 'oneline.webm'), scale: 1 },
  arch: { file: join(RAW2, 'architecture.webm'), scale: 1 },
  built: { file: join(RAW2, 'built-during.webm'), scale: 1 },
  end: { file: join(RAW2, 'end-card.webm'), scale: 1 },
  board: { file: join(RAW1, 'ai-truck-status.webm'), scale: 1 },
};

// ------------------------------------------------------------------------------------ the plans
// Segment: [src, from, to, { speed, hold (freeze `from` for N s), cam: [[t, cx, cy, z, move?]], blur }]
// Times inside a scene are seconds from the scene's start. vo: [lineId, at]. audio: [file, at, label].

const C = (cx, cy, z) => ({ cx, cy, z });
const FULL = [
  {
    id: 'hook',
    headline: '120 trucks. Too many screens.',
    segs: [
      ['brief', 16.5, 18.6, { blur: true, cam: [[0, 960, 540, 1.0], [2.1, 960, 540, 1.08, 2.1]] }],
      ['rc', 0.4, 2.5, { blur: true, cam: [[0, 900, 600, 1.1], [2.1, 1000, 500, 1.16, 2.1]] }],
      ['board', 10.5, 12.6, { blur: true, cam: [[0, 960, 540, 1.05], [2.1, 960, 540, 1.12, 2.1]] }],
      ['cdl', 0.5, 2.6, { blur: true, cam: [[0, 960, 540, 1.0], [2.1, 1000, 520, 1.08, 2.1]] }],
      ['hero', 0.3, 2.4, { blur: true, cam: [[0, 800, 500, 1.1], [2.1, 760, 520, 1.18, 2.1]] }],
      ['board', 4.0, 6.4, { blur: true, cam: [[0, 960, 540, 1.0], [2.4, 960, 540, 1.08, 2.4]] }],
    ],
    vo: [['hook1', 0.4], ['hook2', 3.4]],
    labels: [
      { at: 3.4, text: 'Typing a rate con by hand: 5–10 min', pos: 'chip1' },
      { at: 7.6, text: 'A CDL: 2–3 min', pos: 'chip2' },
      { at: 9.0, text: 'A missing POD: unnoticed', pos: 'chip3' },
    ],
  },
  { id: 'one', segs: [['one', 0.4, 7.6, { cam: [[0, 960, 540, 1.0], [7.2, 960, 540, 1.04, 7.2]] }]], vo: [['one', 0.5]] },
  {
    id: 'hero',
    title: 'Agent drives the TMS',
    segs: [
      ['hero', 0.0, 3.0, { cam: [[0, 960, 540, 1.0]] }],
      ['hero', 3.0, 8.0, { speed: 3.5, cam: [[0, 1300, 700, 1.2], [0.6, 1640, 880, 1.7, 0.6]] }],
      ['hero', 8.0, 8.9, { cam: [[0, 1640, 300, 1.7]] }],
      ['hero', 22.9, 27.0, { cam: [[0, 1640, 290, 1.8]] }],
      ['hero', 27.0, 28.6, { cam: [[0, 1560, 110, 2.4]] }],
      ['hero', 28.6, 37.3, { speed: 4, cam: [[0, 1560, 110, 2.4], [0.5, 1640, 880, 1.7, 0.5]] }],
      ['hero', 37.3, 38.1, { cam: [[0, 1640, 880, 1.7], [0.8, 1100, 600, 1.2, 0.8]] }],
      ['hero', 43.3, 43.9, { cam: [[0, 1100, 600, 1.2]] }],
      ['hero', 48.2, 49.7, { cam: [[0, 900, 560, 1.3], [0.7, 640, 600, 1.6, 0.7]] }],
      ['hero', 49.7, 50.6, { cam: [[0, 640, 600, 1.6]] }],
      ['hero', 51.4, 52.9, { cam: [[0, 1000, 400, 1.4], [0.5, 1400, 250, 1.6, 0.5]] }],
      ['hero', 58.3, 62.6, { speed: 2, cam: [[0, 1250, 330, 1.7]] }],
      ['hero', 66.3, 69.6, { cam: [[0, 1250, 600, 1.4], [0.5, 1560, 900, 2.0, 0.5]] }],
      ['hero', 69.6, 72.0, { cam: [[0, 1560, 900, 2.0], [0.6, 1250, 330, 1.7, 0.6]] }],
      ['hero', 73.1, 76.5, { cam: [[0, 1250, 330, 1.7], [1.0, 960, 540, 1.0, 1.0]] }],
    ],
    vo: [['hero1', 0.6], ['hero2', 5.6], ['hero3', 9.43], ['hero4', 14.0], ['hero5', 20.9], ['hero6', 23.7], ['hero7', 26.2]],
  },
  {
    id: 'rc',
    title: 'Reads a rate con in 7 s',
    segs: [
      ['rc', 0.8, 3.6, { cam: [[0, 960, 540, 1.0]] }],
      ['rc', 3.6, 6.6, { cam: [[0, 960, 540, 1.0], [0.6, 960, 250, 1.5, 0.6]] }],
      ['rc', 11.8, 12.4, { cam: [[0, 960, 250, 1.5]] }],
      ['rc', 12.4, 15.0, { cam: [[0, 960, 250, 1.5], [0.5, 960, 330, 1.8, 0.5]] }],
      ['rc', 15.0, 19.0, { cam: [[0, 960, 330, 1.8], [0.6, 960, 640, 1.5, 0.6]] }],
      ['rc', 19.0, 23.0, { cam: [[0, 960, 640, 1.5], [0.6, 960, 760, 2.0, 0.6]] }],
    ],
    vo: [['vis1', 0.4], ['vis2', 4.2]],
    labels: [{ from: 5.6, to: 7.6, text: 'Muse reading the PDF · 6.5 s real time, shortened here', pos: 'note' }],
  },
  {
    id: 'cdl',
    title: 'Catches a bad CDL',
    segs: [
      ['cdl', 0.0, 10.9, { speed: 2.5, cam: [[0, 960, 540, 1.0]] }],
      ['cdl', 10.9, 11.5, { cam: [[0, 960, 540, 1.0], [0.6, 960, 420, 1.4, 0.6]] }],
      ['cdl', 15.6, 21.6, { cam: [[0, 960, 420, 1.4], [0.7, 960, 420, 2.0, 0.7]] }],
    ],
    vo: [['vis3', 0.4]],
  },
  {
    id: 'voice',
    title: 'Drivers ask in Uzbek',
    segs: [
      ['dv', 0.0, 5.2, { cam: [[0, 960, 540, 1.0], [5.2, 1100, 540, 1.2, 5.2]] }],
      ['dv', 5.2, 8.6, { cam: [[0, 1100, 540, 1.2], [0.6, 1300, 560, 2.1, 0.6]] }],
      ['dv', 8.6, 11.0, { cam: [[0, 1300, 560, 2.1]] }],
      // The answer stays on screen while it is read aloud: played at 0.4x (the screen is still but
      // the voice waveform keeps moving), with a slow push-in.
      ['dv', 17.9, 24.1, { speed: 0.4, cam: [[0, 1300, 560, 2.1], [0.8, 1300, 520, 2.2, 0.8], [15.5, 1300, 520, 2.3, 14.0]] }],
      ['dv', 24.1, 24.1, { hold: 2.2, cam: [[0, 1300, 520, 2.3]] }],
    ],
    // While the camera is on the phone, a plain band hides the sliver of the side card.
    masks: [{ from: 5.8, to: 99, x: 0, w: 440 }],
    vo: [['voice1', 0.2], ['voice2', 8.8], ['uzans', 17.4]],
    audio: [{ file: OWNER_WAV, at: 5.4, id: 'owner', sub: 'When is my next pickup? How many miles are left?', speaker: 'Driver, in Uzbek' }],
    labels: [
      { from: 5.3, to: 8.8, text: 'Real recording · our owner asking in Uzbek', pos: 'note' },
      { from: 17.3, to: 28.9, text: 'Answer read aloud for the video (Uzbek neural voice) · the app shows it as text', pos: 'note' },
    ],
  },
  {
    id: 'pay',
    title: 'Driver pay in seconds',
    segs: [
      ['pay', 3.0, 9.2, { speed: 4, cam: [[0, 1195, 880, 1.7]] }],
      ['pay', 9.2, 9.9, { cam: [[0, 1195, 880, 1.7], [0.7, 1200, 300, 1.6, 0.7]] }],
      ['pay', 34.6, 38.4, { cam: [[0, 1210, 390, 1.9]] }],
      ['pay', 38.4, 41.4, { cam: [[0, 1210, 390, 1.9], [0.8, 1210, 650, 1.6, 0.8]] }],
    ],
    vo: [['pay', 0.3]],
  },
  {
    id: 'brief',
    title: 'Finds problems before you do',
    segs: [
      ['brief', 0.3, 2.7, { cam: [[0, 1200, 400, 1.3], [0.8, 1700, 200, 1.8, 0.8]] }],
      ['brief', 2.7, 3.4, { cam: [[0, 1700, 200, 1.8]] }],
      ['brief', 15.7, 18.6, { cam: [[0, 1200, 400, 1.4], [0.6, 780, 270, 2.2, 0.6]] }],
      ['brief', 18.6, 18.6, { hold: 4.6, cam: [[0, 780, 270, 2.2], [0.7, 1530, 400, 2.0, 0.7]] }],
    ],
    vo: [['brief', 0.3]],
  },
  { id: 'how', segs: [['arch', 0.4, 8.85, { cam: [[0, 960, 540, 1.0], [8.45, 960, 520, 1.05, 8.45]] }], ['arch', 8.85, 8.85, { hold: 2.9, cam: [[0, 960, 520, 1.05]] }]], vo: [['how', 0.6]] },
  { id: 'built', segs: [['built', 0.4, 9.8, { cam: [[0, 960, 540, 1.0]] }]], vo: [['end1', 1.2]] },
  { id: 'end', segs: [['end', 0.5, 21.4, { cam: [[0, 960, 540, 1.0]] }]], vo: [['end2', 0.6], ['end3', 10.3]] },
];

const SHORT_PLAN = [
  { id: 's-hook', headline: '120 trucks. One agent.', segs: [['brief', 16.5, 18.6, { blur: true, cam: [[0, 960, 540, 1.0], [2.1, 960, 540, 1.08, 2.1]] }], ['hero', 0.3, 1.9, { blur: true, cam: [[0, 800, 500, 1.1]] }]], vo: [['s1', 0.1]] },
  {
    id: 's-hero',
    title: 'Agent drives the TMS',
    segs: [
      ['hero', 24.4, 26.4, { cam: [[0, 1640, 290, 1.8]] }],
      ['hero', 48.2, 49.7, { cam: [[0, 640, 600, 1.6]] }],
      ['hero', 58.3, 62.6, { speed: 4, cam: [[0, 1250, 330, 1.7]] }],
      ['hero', 66.6, 69.6, { cam: [[0, 1560, 900, 2.0]] }],
      ['hero', 69.6, 71.6, { cam: [[0, 1560, 900, 2.0], [0.5, 1250, 330, 1.7, 0.5]] }],
    ],
    vo: [['s2', 0.2]],
  },
  {
    id: 's-rc',
    title: 'Reads a rate con in 7 s',
    segs: [
      ['rc', 4.6, 6.4, { cam: [[0, 960, 250, 1.5]] }],
      ['rc', 12.0, 15.0, { cam: [[0, 960, 330, 1.8]] }],
      ['rc', 20.5, 22.0, { cam: [[0, 960, 760, 2.0]] }],
    ],
    vo: [['s3', 0.2]],
  },
  {
    id: 's-voice',
    title: 'Drivers ask in Uzbek',
    segs: [
      ['dv', 5.2, 8.6, { cam: [[0, 1300, 560, 2.1]] }],
      ['dv', 18.0, 22.0, { cam: [[0, 1300, 520, 2.2]] }],
    ],
    masks: [{ from: 0, to: 99, x: 0, w: 440 }],
    vo: [['s4', 3.6]],
    audio: [{ file: OWNER_WAV, at: 0.2, id: 'owner', sub: 'When is my next pickup? How many miles are left?', speaker: 'Driver, in Uzbek' }],
    labels: [{ from: 0.1, to: 3.5, text: 'Real recording · our owner asking in Uzbek', pos: 'note' }],
  },
  { id: 's-end', segs: [['end', 2.0, 5.0, { cam: [[0, 960, 540, 1.0]] }]], vo: [['s5', 0.3]] },
];

// Lines only the short cut speaks (written to vo-lines.json by --short on first run).
const SHORT_LINES = [
  { id: 's1', text: 'A hundred and twenty trucks. Meet the agent inside our TMS.', sub: '120 trucks. Meet the agent inside our TMS.' },
  { id: 's2', text: 'Muse finds the missing POD, messages the driver, and asks before it presses Send.', sub: 'Muse finds the missing POD, messages the driver,|and asks before it presses Send.' },
  { id: 's3', text: 'A rate confirmation in, the load filled in seven seconds.', sub: 'A rate confirmation in — the load filled in 7 seconds.' },
  { id: 's4', text: 'Drivers ask in Uzbek. Muse understands.', sub: 'Drivers ask in Uzbek. Muse understands.' },
  { id: 's5', text: 'NeWay AI, powered by Meta Muse.', sub: 'NeWay AI, powered by Meta Muse.' },
];

const PLAN = SHORT ? SHORT_PLAN : FULL;

// ------------------------------------------------------------------------------------ camera

const ease = (p) => `(${p})*(${p})*(3-2*(${p}))`;
/** Piecewise eased value of one camera channel over the segment time `it`. */
function channel(kfs, key) {
  let expr = String(kfs.at(-1)[key]);
  for (let i = kfs.length - 1; i >= 1; i -= 1) {
    const a = kfs[i - 1];
    const b = kfs[i];
    const m = Math.max(0.05, b.move ?? 0.7);
    const t0 = Math.max(a.t, b.t - m);
    const p = `((it-${t0.toFixed(3)})/${(b.t - t0).toFixed(3)})`;
    expr = `if(lt(it,${t0.toFixed(3)}),${a[key]},if(lt(it,${b.t.toFixed(3)}),${a[key]}+(${b[key] - a[key]})*${ease(p)},${expr}))`;
  }
  return expr;
}
function zoompan(cam, scale) {
  const kfs = (cam ?? [[0, 960, 540, 1]]).map(([t, cx, cy, z, move]) => ({ t, cx, cy, z, move }));
  const Z = channel(kfs, 'z');
  const X = channel(kfs, 'cx');
  const Y = channel(kfs, 'cy');
  // Commas inside the expressions are escaped for the filter graph.
  const esc = (s) => s.replace(/,/g, '\\,');
  return `zoompan=z='${esc(Z)}':x='${esc(`clip((${X})*${scale}-iw/zoom/2,0,iw-iw/zoom)`)}':y='${esc(`clip((${Y})*${scale}-ih/zoom/2,0,ih-ih/zoom)`)}':d=1:s=1920x1080:fps=${FPS}`;
}

// ------------------------------------------------------------------------------------ overlays

const TOKENS = `
:root{--nw-bg:#F3F5F4;--nw-panel:#FFFFFF;--nw-border:#E2E7E5;--nw-text:#16201F;--nw-text-2:#4B5856;--nw-text-3:#66736F;--nw-accent:#0B7A74;--nw-accent-tint:#E0F1EF;--nw-accent-ink:#075C57;--nw-shadow-menu:0 1px 2px rgba(22,32,31,.05),0 6px 20px rgba(22,32,31,.07);}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1920px;height:1080px;background:transparent;font-family:'Manrope',system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow:hidden}
.title{position:absolute;left:40px;top:34px;display:inline-flex;align-items:center;gap:14px;padding:12px 24px 12px 14px;background:var(--nw-panel);border:1px solid var(--nw-border);border-radius:999px;box-shadow:var(--nw-shadow-menu);font-size:30px;font-weight:800;color:var(--nw-text);letter-spacing:-.01em}
.title i{width:36px;height:36px;border-radius:50%;background:var(--nw-accent);display:inline-flex;align-items:center;justify-content:center}
.title i svg{width:20px;height:20px}
.sub{position:absolute;left:0;right:0;bottom:46px;display:flex;justify-content:center}
.sub div{max-width:1560px;padding:14px 30px 16px;border-radius:10px;background:rgba(22,32,31,.86);color:#FFFFFF;font-size:40px;line-height:1.3;font-weight:600;text-align:center;letter-spacing:-.005em}
.sub b{display:block;font-size:22px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#9FD6D1;margin-bottom:4px}
.note{position:absolute;right:40px;top:36px;display:flex;justify-content:flex-end}
.note span{padding:9px 20px;border-radius:999px;background:var(--nw-accent-tint);border:2px solid var(--nw-accent);color:var(--nw-accent-ink);font-size:26px;font-weight:700}
.head{position:absolute;left:0;right:0;top:250px;text-align:center}
.head span{display:inline-block;padding:26px 54px;border-radius:18px;background:rgba(255,255,255,.92);border:1px solid var(--nw-border);box-shadow:var(--nw-shadow-menu);font-size:96px;font-weight:800;letter-spacing:-.035em;color:var(--nw-text)}
.chip{position:absolute;left:0;right:0;display:flex;justify-content:center}
.chip span{padding:14px 30px;border-radius:999px;background:var(--nw-panel);border:2px solid var(--nw-accent);color:var(--nw-accent-ink);font-size:38px;font-weight:800;box-shadow:var(--nw-shadow-menu)}
.chip1{top:470px}.chip2{top:572px}.chip3{top:674px}
`;
const SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/></svg>';
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

async function renderOverlays(specs) {
  mkdirSync(join(WORK, 'ov'), { recursive: true });
  const page0 = join(WORK, 'ov', 'page.html');
  writeFileSync(page0, `<!doctype html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet"><style>${TOKENS}</style></head><body><div id="o"></div></body></html>`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(pathToFileURL(page0).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  for (const s of specs) {
    let html = '';
    if (s.kind === 'title') html = `<div class="title"><i>${SPARK}</i>${escHtml(s.text)}</div>`;
    else if (s.kind === 'sub') html = `<div class="sub"><div>${s.speaker ? `<b>${escHtml(s.speaker)}</b>` : ''}${escHtml(s.text)}</div></div>`;
    else if (s.kind === 'note') html = `<div class="note"><span>${escHtml(s.text)}</span></div>`;
    else if (s.kind === 'head') html = `<div class="head"><span>${escHtml(s.text)}</span></div>`;
    else if (s.kind === 'mask') html = `<div style="position:absolute;top:0;left:${s.x}px;width:${s.w}px;height:1080px;background:var(--nw-bg)"></div>`;
    else if (s.kind === 'chip') html = `<div class="chip ${s.pos}"><span>${escHtml(s.text)}</span></div>`;
    await page.evaluate((h) => { document.getElementById('o').innerHTML = h; }, html);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: s.png, omitBackground: true });
  }
  await browser.close();
}

// ------------------------------------------------------------------------------------ build

function ensureShortLines() {
  const file = join(here, 'vo-lines.json');
  const j = JSON.parse(readFileSync(file, 'utf8'));
  let changed = false;
  for (const l of SHORT_LINES) if (!j.lines.some((x) => x.id === l.id)) { j.lines.push(l); LINES[l.id] = l; changed = true; }
  if (changed) writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
  const missing = SHORT_LINES.filter((l) => !existsSync(join(TTS, `${l.id}.mp3`)));
  if (missing.length) {
    const r = spawnSync('python', [join(here, 'tts.py'), '--voice', VOICE, '--only', missing.map((l) => l.id).join(',')], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('tts.py failed');
  }
}

if (SHORT) ensureShortLines();
const REUSE = flag('reuse') && existsSync(join(WORK, 'joined.mp4'));
if (!flag('keep') && !REUSE) rmSync(WORK, { recursive: true, force: true });
mkdirSync(join(WORK, 'seg'), { recursive: true });

// 1. Timeline: scene starts from frame-exact segment lengths.
let at = 0;
const timeline = [];
for (const scene of PLAN) {
  const segs = scene.segs.map(([src, from, to, o = {}]) => {
    const len = o.hold ? o.hold : (to - from) / (o.speed ?? 1);
    return { src, from, to, ...o, frames: Math.round(len * FPS) };
  });
  const frames = segs.reduce((n, s) => n + s.frames, 0);
  timeline.push({ ...scene, segs, start: at, length: frames / FPS });
  at += frames / FPS;
}
const total = at;

// 2. Audio items + subtitles (absolute times).
const audio = [];
const subs = [];
for (const sc of timeline) {
  for (const [id, rel] of sc.vo ?? []) {
    const file = join(TTS, `${id}.mp3`);
    if (!existsSync(file)) throw new Error(`Missing voice line ${file} (run tts.py)`);
    const d = duration(file);
    const t0 = sc.start + rel;
    audio.push({ id, file, at: t0, length: d });
    const line = LINES[id];
    const parts = line.sub.split('|');
    const chars = parts.reduce((n, p) => n + p.length, 0);
    let t = t0;
    for (const p of parts) {
      const len = (d * p.length) / chars;
      subs.push({ from: t, to: t + len + (p === parts.at(-1) ? 0.25 : 0), text: p.trim(), speaker: line.lang === 'uz' ? 'NeWay AI, in Uzbek' : null });
      t += len;
    }
    if (t0 + d > sc.start + sc.length + 0.6 && sc !== timeline.at(-1)) console.warn(`  voice line ${id} runs ${(t0 + d - sc.start - sc.length).toFixed(2)}s past scene ${sc.id}`);
  }
  for (const a of sc.audio ?? []) {
    const d = duration(a.file);
    audio.push({ id: a.id, file: a.file, at: sc.start + a.at, length: d, owner: true });
    subs.push({ from: sc.start + a.at, to: sc.start + a.at + d + 0.3, text: a.sub, speaker: a.speaker });
  }
}

// 3. Overlay specs.
const overlays = [];
const ov = (kind, text, from, to, extra = {}) => overlays.push({ kind, text, from, to, png: join(WORK, 'ov', `${String(overlays.length).padStart(3, '0')}-${kind}.png`), ...extra });
for (const sc of timeline) {
  for (const m of sc.masks ?? []) ov('mask', '', sc.start + m.from, Math.min(sc.start + m.to, sc.start + sc.length), { x: m.x, w: m.w });
  if (sc.title) ov('title', sc.title, sc.start, sc.start + sc.length);
  if (sc.headline) ov('head', sc.headline, sc.start + 0.3, sc.start + sc.length);
  for (const l of sc.labels ?? []) {
    if (l.pos?.startsWith('chip')) ov('chip', l.text, sc.start + l.at, sc.start + sc.length, { pos: l.pos });
    else ov('note', l.text, sc.start + l.from, sc.start + l.to);
  }
}
// Subtitles never overlap: each ends where the next starts.
subs.sort((a, b) => a.from - b.from);
subs.forEach((s, i) => { if (subs[i + 1] && s.to > subs[i + 1].from) s.to = subs[i + 1].from; });
for (const s of subs) ov('sub', s.text, s.from, s.to, { speaker: s.speaker });

console.log(`${SHORT ? '30-second cut' : 'Final film'}: ${total.toFixed(1)} s, ${timeline.length} scenes, ${audio.length} voice items, ${subs.length} subtitles`);
for (const sc of timeline) console.log(`  ${mmss(sc.start)}  ${sc.id.padEnd(8)} ${sc.length.toFixed(1)}s  ${sc.title ?? sc.headline ?? ''}`);
function mmss(t) { return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`; }

await renderOverlays(overlays);
if (flag('only-overlays')) process.exit(0);

// 4. Segments -> uniform 1080p30 H.264 pieces (--reuse keeps the last render's pieces).
const pieces = [];
let n = 0;
for (const sc of REUSE ? [] : timeline) {
  for (const s of sc.segs) {
    const src = SRC[s.src];
    const out = join(WORK, 'seg', `${String(n).padStart(3, '0')}.mp4`);
    n += 1;
    const zp = zoompan(s.cam, src.scale);
    const tail = `${zp}${s.blur ? ',boxblur=9:2,eq=saturation=0.75' : ''},format=yuv420p`;
    let args;
    if (s.hold) {
      src.real ??= duration(src.file);
      const from = Math.min(s.from, src.real - 0.1);
      args = ['-ss', from.toFixed(3), '-i', src.file, '-filter_complex', `[0:v]trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${(s.hold + 0.2).toFixed(3)},fps=${FPS},${tail}[v]`];
    } else {
      const len = s.to - s.from;
      args = ['-ss', s.from.toFixed(3), '-t', (len + 0.2).toFixed(3), '-i', src.file, '-filter_complex', `[0:v]setpts=(PTS-STARTPTS)/${s.speed ?? 1},fps=${FPS},tpad=stop_mode=clone:stop_duration=${(s.frames / FPS + 1).toFixed(2)},${tail}[v]`];
    }
    run([...args, '-map', '[v]', '-frames:v', String(s.frames), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-r', String(FPS), '-pix_fmt', 'yuv420p', out], `segment ${n} ${s.src} ${s.from}`);
    pieces.push(out);
    process.stdout.write(`\r  segments ${n}/${timeline.reduce((k, t) => k + t.segs.length, 0)}`);
  }
}
console.log();
const list = join(WORK, 'pieces.txt');
writeFileSync(list, pieces.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
const joined = join(WORK, 'joined.mp4');
if (!REUSE) run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined], 'concat');

// 5. Audio: each voice item levelled on its own, placed, mixed; a synthesised pad ducked under it.
const vInputs = [];
const vFilters = [];
mkdirSync(join(WORK, 'aud'), { recursive: true });
audio.forEach((a, i) => {
  // Each item levelled on its own first (short files, one pass), then placed by adelay.
  const lev = join(WORK, 'aud', `${String(i).padStart(2, '0')}-${a.id}.wav`);
  run(['-i', a.file, '-af', `aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=${a.owner ? -17 : -16}:TP=-1.5:LRA=11,aresample=48000`, '-c:a', 'pcm_s16le', lev], `level ${a.id}`);
  vInputs.push('-i', lev);
  const ms = Math.round(a.at * 1000);
  vFilters.push(`[${i}:a]adelay=${ms}|${ms}[a${i}]`);
});
vFilters.push(`${audio.map((_, i) => `[a${i}]`).join('')}amix=inputs=${audio.length}:duration=longest:dropout_transition=0:normalize=0,apad[voice]`);
const voiceWav = join(WORK, 'voice.wav');
run([...vInputs, '-filter_complex', vFilters.join(';'), '-map', '[voice]', '-t', total.toFixed(3), '-c:a', 'pcm_s16le', voiceWav], 'voice mix');

const notes = (fs) => fs.map((f) => `sin(2*PI*${f}*t)+0.6*sin(2*PI*${(f * 1.004).toFixed(3)}*t)`).join('+');
const am = [110, 164.81, 220, 261.63, 329.63];
const fmaj = [87.31, 130.81, 174.61, 220, 261.63];
const pad = `0.045*(0.5*(1+sin(2*PI*t/24))*(${notes(am)})+0.5*(1-sin(2*PI*t/24))*(${notes(fmaj)}))*(1+0.25*sin(2*PI*t/7))`;
const musicWav = join(WORK, 'music.wav');
run(['-f', 'lavfi', '-i', `aevalsrc='${pad}':s=48000:d=${(total + 1).toFixed(2)}`, '-af', `lowpass=f=1300,aecho=0.8:0.6:180|320:0.35|0.25,afade=t=in:d=2.5,afade=t=out:st=${(total - 3).toFixed(2)}:d=3,aformat=channel_layouts=stereo,volume=0.5`, '-c:a', 'pcm_s16le', musicWav], 'music');

const mixWav = join(WORK, 'mix.wav');
run(['-i', voiceWav, '-i', musicWav, '-filter_complex',
  `[1:a]volume=1.6[m];[0:a]asplit=2[v1][key];[m][key]sidechaincompress=threshold=0.015:ratio=6:attack=40:release=700[duck];[v1][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[out]`,
  '-map', '[out]', '-t', total.toFixed(3), '-c:a', 'pcm_s16le', mixWav], 'final mix');

// 6. Overlays burned in, audio muxed, one H.264 + AAC file.
const oInputs = ['-i', joined, '-i', mixWav];
const oFilters = [];
let last = '0:v';
overlays.forEach((o, i) => {
  oInputs.push('-i', o.png);
  const label = `o${i}`;
  oFilters.push(`[${last}][${i + 2}:v]overlay=0:0:enable='between(t,${o.from.toFixed(3)},${o.to.toFixed(3)})'[${label}]`);
  last = label;
});
oFilters.push(`[${last}]fade=t=in:st=0:d=0.4,format=yuv420p[vout]`);
const graph = join(WORK, 'overlay.txt');
writeFileSync(graph, oFilters.join(';\n'));
run([...oInputs, '-filter_complex_script', graph, '-map', '[vout]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-t', total.toFixed(3), OUT], 'overlay + mux');

// 7. Subtitles file.
if (!SHORT) {
  const ts = (t) => { const ms = Math.round(t * 1000); const h = Math.floor(ms / 3.6e6); const m = Math.floor((ms % 3.6e6) / 6e4); const s = Math.floor((ms % 6e4) / 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  writeFileSync(join(VID, 'final-subtitles.srt'), subs.map((s, i) => `${i + 1}\n${ts(s.from)} --> ${ts(s.to)}\n${s.speaker ? `[${s.speaker}] ` : ''}${s.text}\n`).join('\n'));
}
writeFileSync(join(WORK, 'timeline.json'), JSON.stringify({ total, scenes: timeline.map((s) => ({ id: s.id, start: +s.start.toFixed(2), length: +s.length.toFixed(2), title: s.title ?? s.headline ?? null })), audio: audio.map((a) => ({ id: a.id, at: +a.at.toFixed(2), length: +a.length.toFixed(2) })), subs }, null, 2));
console.log(`Saved ${OUT} (${duration(OUT).toFixed(2)} s)`);
