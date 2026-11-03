#!/usr/bin/env node
/**
 * Record one scene of the hackathon video as a 1920x1080 .webm.
 *
 *   node scripts/hackathon/record.mjs <scene> [--base http://127.0.0.1:5180] [--hq] [--headed]
 *                                             [--login-on-camera] [--theme light|dark]
 *   node scripts/hackathon/record.mjs --list
 *
 * Scenes live in scripts/hackathon/scenes/<name>.mjs and export default { name, description, run }.
 * `run({ page, h })` drives the page with the helpers below (human-like typing, a visible cursor,
 * waiting for NeWay AI's answer, pauses). Output: docs/hackathon/video/raw/<scene>.webm plus
 * <scene>.json (duration, where the useful footage starts, so compose.mjs can trim the blank head).
 *
 * Two capture modes:
 *   default  Playwright recordVideo (1920x1080, deviceScaleFactor 1). Simple; VP8 at ~1 Mbit/s,
 *            a little soft on text.
 *   --hq     CDP screencast frames (JPEG q95) re-timed to 30 fps and encoded with ffmpeg (VP9,
 *            CRF 18). Sharper text; use this for the final takes.
 *
 * Login: by default the scene starts already signed in (the session is made in an unrecorded
 * context first). --login-on-camera makes the scene's h.login() visible instead.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const sceneDir = join(here, 'scenes');
const outDir = resolve(opt('out', join(root, 'docs', 'hackathon', 'video', 'raw')));
const BASE = opt('base', process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:5180').replace(/\/$/, '');
const EMAIL = process.env.DEMO_EMAIL ?? 'demo.admin@silkway-demo.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'MuseDemo-2026!';
const SIZE = { width: 1920, height: 1080 };
// --scale 2 renders at deviceScaleFactor 2 and keeps a 3840x2160 clip, so the film can zoom 200 %
// into a detail and the text stays sharp.
const SCALE = Number(opt('scale', '1')) || 1;
const OUT_SIZE = { width: SIZE.width * SCALE, height: SIZE.height * SCALE };
const FPS = 30;
// Prompt typing speed for askAi (words per minute; ~45 ms a key). A 3-minute film has no time for
// a person typing at 60 wpm.
const TYPE_WPM = Number(process.env.DEMO_TYPE_WPM ?? 260);

if (flag('list')) {
  for (const f of readdirSync(sceneDir).filter((f) => f.endsWith('.mjs'))) {
    const s = (await import(pathToFileURL(join(sceneDir, f)).href)).default;
    console.log(`${basename(f, '.mjs').padEnd(20)} ${s.description ?? ''}`);
  }
  process.exit(0);
}
const VALUE_OPTS = new Set(['--base', '--theme', '--out', '--scale']);
const sceneName = argv.find((a, i) => !a.startsWith('--') && !VALUE_OPTS.has(argv[i - 1]));
if (!sceneName || sceneName.startsWith('--')) {
  console.error('Usage: node scripts/hackathon/record.mjs <scene> [--hq]   (--list shows the scenes)');
  process.exit(1);
}
const scenePath = join(sceneDir, `${sceneName}.mjs`);
if (!existsSync(scenePath)) {
  console.error(`No scene ${scenePath}`);
  process.exit(1);
}
const scene = (await import(pathToFileURL(scenePath).href)).default;
mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.random() * (b - a);

/**
 * A visible cursor for the video (headless recordings have none). Pure overlay: injected into the
 * page, pointer-events none, removed from nothing in the product.
 */
const CURSOR_SCRIPT = `
(() => {
  if (window.__demoCursor) return;
  window.__demoCursor = true;
  const make = () => {
    const c = document.createElement('div');
    c.id = '__demo_cursor';
    c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:transform 40ms linear;';
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 13.8 L10.5 20 L13 19 L10.2 12.8 L16 12.8 Z" fill="black" stroke="white" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    const ring = document.createElement('div');
    ring.style.cssText = 'position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid rgba(20,140,130,.55);z-index:2147483646;pointer-events:none;opacity:0;transition:opacity 220ms;';
    document.documentElement.appendChild(ring);
    // Over an iframe the page stops seeing the mouse: hide this cursor there (the frame draws its own).
    window.addEventListener('mouseout', (e) => { if (!e.relatedTarget || e.relatedTarget.tagName === 'IFRAME') c.style.opacity = '0'; }, true);
    window.addEventListener('mousemove', (e) => { c.style.opacity = '1'; c.style.transform = 'translate(' + (e.clientX - 3) + 'px,' + (e.clientY - 2) + 'px)'; ring.style.left = e.clientX + 'px'; ring.style.top = e.clientY + 'px'; }, true);
    window.addEventListener('mousedown', (e) => {
      ring.style.opacity = '1';
      // Click ripple for the film: a teal ring that grows and fades where the press lands.
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;left:' + e.clientX + 'px;top:' + e.clientY + 'px;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:3px solid rgba(11,122,116,.9);background:rgba(11,122,116,.18);z-index:2147483646;pointer-events:none;transform:scale(1);opacity:1;transition:transform 520ms ease-out,opacity 520ms ease-out;';
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transform = 'scale(4.2)'; r.style.opacity = '0'; }));
      setTimeout(() => r.remove(), 700);
    }, true);
    window.addEventListener('mouseup', () => setTimeout(() => (ring.style.opacity = '0'), 160), true);
  };
  if (document.documentElement) make(); else document.addEventListener('DOMContentLoaded', make);
})();
`;

function helpers(page, state) {
  let mouse = { x: SIZE.width / 2, y: SIZE.height / 2 };
  const h = {
    base: BASE,
    sleep,
    /** Hold the frame (narration time). */
    pause: (ms = 1500) => sleep(ms),
    async goto(path) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
      await h.settle();
    },
    /**
     * Open a local card page (title, diagram) from scripts/hackathon/cards/. Footage starts once
     * its web fonts are in, so the card never flashes in a fallback font.
     */
    /** Footage starts now (after off-camera setup such as a sign-in). */
    markStart() {
      state.firstFrameAt = Date.now();
    },
    async card(file) {
      const url = pathToFileURL(resolve(here, 'cards', file)).href;
      await page.goto(url, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready).catch(() => {});
      await sleep(150);
      if (state.firstFrameAt === null) state.firstFrameAt = Date.now();
      // Cards animate in on the "go" class, so the motion starts with the footage.
      await page.evaluate(() => document.documentElement.classList.add('go'));
    },
    /** Wait for the page to stop saying "Loading…" and the network to calm down. */
    async settle(timeout = 20_000) {
      await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
      await page
        // A route chunk can still be on its way after networkidle: wait for real content too.
        .waitForFunction(() => (document.body?.innerText?.length ?? 0) > 200 && !document.body.innerText.includes('Loading…'), null, { timeout })
        .catch(() => {});
      if (state.firstFrameAt === null) state.firstFrameAt = Date.now();
    },
    /** Glide the cursor to an element (or point) like a hand would. */
    async moveTo(target, { steps = 28 } = {}) {
      let x;
      let y;
      if (typeof target === 'object' && 'x' in target) ({ x, y } = target);
      else {
        const loc = typeof target === 'string' ? page.locator(target).first() : target;
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        const box = await loc.boundingBox();
        if (!box) return;
        x = box.x + box.width * jitter(0.35, 0.6);
        y = box.y + box.height * jitter(0.4, 0.6);
      }
      const from = { ...mouse };
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease in-out
        await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
        await sleep(12);
      }
      mouse = { x, y };
    },
    async click(target, opts) {
      await h.moveTo(target, opts);
      await sleep(jitter(120, 260));
      await page.mouse.down();
      await sleep(70);
      await page.mouse.up();
      await sleep(jitter(250, 450));
    },
    /** Type like a person: 35-110 ms per key, a beat after punctuation, a breath now and then. */
    async type(target, text, { wpm } = {}) {
      if (target) await h.click(target);
      const base = wpm ? 60_000 / (wpm * 5) : null;
      for (const ch of text) {
        await page.keyboard.type(ch);
        let d = base ? base * jitter(0.6, 1.4) : jitter(35, 110);
        if (/[,.?!]/.test(ch)) d += jitter(120, 260);
        else if (ch === ' ' && Math.random() < 0.08) d += jitter(150, 350);
        await sleep(d);
      }
    },
    async login(email = EMAIL, password = PASSWORD) {
      await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
      await h.settle();
      await h.type(page.getByLabel('Email or username'), email);
      await h.type(page.locator('input[type="password"]'), password, { wpm: 140 });
      await h.click(page.getByRole('button', { name: /^Sign in/ }));
      await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
      await h.settle();
    },
    /**
     * Ask NeWay AI on the page in front of us: type the prompt into the "Ask NeWay AI…" box, send
     * it, wait for the answer to finish, then hold.
     */
    async askAi(prompt, { holdMs = 4000, timeoutMs = 240_000, wpm = TYPE_WPM } = {}) {
      const box = page.getByLabel('Message');
      await box.waitFor({ state: 'visible', timeout: 30_000 });
      // Never type into a chat that is still answering: the composer drops a send while busy.
      await h.waitAiIdle(timeoutMs);
      await h.type(box, prompt, { wpm });
      await sleep(jitter(350, 600));
      await page.keyboard.press('Enter');
      // Busy = the composer shows Stop and the thread shows "Working…". Wait for it to start…
      await page
        .waitForFunction(() => document.body.innerText.includes('Working…') || !!document.querySelector('button[aria-label="Stop"]'), null, { timeout: 15_000 })
        .catch(() => {});
      // …and to finish. The wait is noted so compose.mjs can shorten it (--cut-waits).
      const waitFrom = Date.now();
      const idle = await h.waitAiIdle(timeoutMs);
      state.waits.push({ from: waitFrom, to: Date.now() });
      if (!idle) console.warn(`  (NeWay AI still busy after ${timeoutMs / 1000}s: "${prompt}")`);
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await sleep(holdMs);
    },
    /** Note a stretch of waiting (e.g. NeWay AI thinking between screen steps) for compose --cut-waits. */
    markWait(from, to) {
      if (to - from > 500) state.waits.push({ from, to });
    },
    /** True once NeWay AI is not answering (no Stop button, no "Working…"). */
    async waitAiIdle(timeoutMs = 240_000) {
      return page
        .waitForFunction(() => !document.body.innerText.includes('Working…') && !document.querySelector('button[aria-label="Stop"]'), null, { timeout: timeoutMs, polling: 250 })
        .then(() => true)
        .catch(() => false);
    },
    /** Scroll a scroll box (or the page) smoothly by dy pixels. */
    async scroll(dy, steps = 30) {
      for (let i = 0; i < steps; i += 1) {
        await page.mouse.wheel(0, dy / steps);
        await sleep(16);
      }
    },
  };
  return h;
}

// ------------------------------------------------------------------------------------ hq capture

async function startScreencast(page) {
  const frameDir = join(outDir, `.frames-${sceneName}`);
  rmSync(frameDir, { recursive: true, force: true });
  mkdirSync(frameDir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => {
    const file = join(frameDir, `${String(frames.length).padStart(6, '0')}.jpg`);
    frames.push({ file, t: f.metadata.timestamp, wall: Date.now() / 1000 });
    writeFileSync(file, Buffer.from(f.data, 'base64'));
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: OUT_SIZE.width, maxHeight: OUT_SIZE.height, everyNthFrame: 1 });
  return {
    frameDir,
    /** Fewer frames for a while (1 = every frame): leaves the page CPU for e.g. microphone capture. */
    async rate(n) {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: OUT_SIZE.width, maxHeight: OUT_SIZE.height, everyNthFrame: n });
    },
    async stop() {
      await cdp.send('Page.stopScreencast').catch(() => {});
      return frames;
    },
  };
}

/** Frames arrive only when the screen changes: hold each one until the next, at a constant 30 fps. */
function encodeFrames(frames, frameDir, target, endT) {
  const ffmpeg = require('ffmpeg-static');
  const list = join(frameDir, 'frames.ffconcat');
  const lines = ['ffconcat version 1.0'];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : endT;
    // Real gaps, not at least 1/FPS each: a burst of 60 fps frames padded to 1/30 s stretched
    // the clip (a 79 s take came out 2:03). The fps filter below drops the extra frames instead.
    lines.push(`file '${basename(f.file)}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
  });
  lines.push(`file '${basename(frames.at(-1).file)}'`);
  writeFileSync(list, lines.join('\n'));
  const r = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `fps=${FPS},scale=${OUT_SIZE.width}:${OUT_SIZE.height}:flags=lanczos,format=yuv420p`,
    '-c:v', 'libvpx-vp9', '-crf', SCALE > 1 ? '20' : '18', '-b:v', '0', '-row-mt', '1', '-deadline', SCALE > 1 ? 'realtime' : 'good', '-cpu-used', SCALE > 1 ? '8' : '4', target], { cwd: frameDir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr || r.error}`);
}

// ------------------------------------------------------------------------------------ run

const browser = await chromium.launch({ headless: !flag('headed'), args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', ...(scene.launchArgs ?? [])] });
const theme = opt('theme', 'light');
const contextBase = { viewport: SIZE, deviceScaleFactor: SCALE, colorScheme: theme, locale: 'en-US', timezoneId: 'America/New_York' };

let storageState;
// Scenes that are not the web TMS (cards, the driver app) set skipLogin.
if (!flag('login-on-camera') && !scene.skipLogin) {
  const pre = await browser.newContext(contextBase);
  const p = await pre.newPage();
  await helpers(p, { firstFrameAt: 0 }).login();
  storageState = await pre.storageState();
  await pre.close();
}

const hq = flag('hq');
const tmpVideoDir = join(outDir, `.tmp-${sceneName}`);
const context = await browser.newContext({
  ...contextBase,
  storageState,
  ...(hq ? {} : { recordVideo: { dir: tmpVideoDir, size: SIZE } }),
});
await context.addInitScript(CURSOR_SCRIPT);
const page = await context.newPage();
const state = { firstFrameAt: null, waits: [] };
const startedAt = Date.now();
const cast = hq ? await startScreencast(page) : null;
const h = helpers(page, state);
/** hq only: capture every n-th frame until called again with 1. */
h.captureRate = async (n) => {
  if (cast) await cast.rate(n);
};
// The cursor starts mid-screen so the first glide has somewhere to come from.
await page.mouse.move(SIZE.width / 2, SIZE.height / 2);

console.log(`Recording "${scene.name ?? sceneName}" at ${BASE} (${hq ? 'hq screencast' : 'playwright video'})…`);
let failed = null;
try {
  await scene.run({ page, h });
} catch (error) {
  failed = error;
  console.error(`Scene failed: ${error instanceof Error ? error.message : error}`);
}
const endedAt = Date.now();
const target = join(outDir, `${sceneName}.webm`);

if (hq) {
  const frames = await cast.stop();
  // Frames come only when the screen changes, so a still hold at the end has none: place the end
  // (and the head) on the frame clock from the wall clock, not from the last frame.
  const offset = frames.length ? Math.max(...frames.map((f) => f.t - f.wall)) : 0;
  const endT = frames.length ? Math.max(frames.at(-1).t + 1 / FPS, endedAt / 1000 + offset + 0.3) : 0;
  await context.close();
  if (!frames.length) throw new Error('No frames captured');
  // Trim the head in the encode: frames from before the first settled page are dropped.
  const headT = (state.firstFrameAt ?? startedAt) / 1000 + offset;
  const kept = frames.filter((f, i) => f.t >= headT || (i + 1 < frames.length && frames[i + 1].t > headT));
  encodeFrames(kept, cast.frameDir, target, endT);
  rmSync(cast.frameDir, { recursive: true, force: true });
} else {
  const video = page.video();
  await context.close();
  await video.saveAs(target);
  rmSync(tmpVideoDir, { recursive: true, force: true });
}
await browser.close();

const meta = {
  scene: sceneName,
  title: scene.name ?? sceneName,
  base: BASE,
  mode: hq ? 'hq' : 'video',
  scale: SCALE,
  recordedAt: new Date(startedAt).toISOString(),
  durationSeconds: +((endedAt - startedAt) / 1000).toFixed(2),
  // Where the useful footage starts (after the first page settled); hq clips are already trimmed.
  startSeconds: hq ? 0 : +(((state.firstFrameAt ?? startedAt) - startedAt) / 1000).toFixed(2),
  // AI thinking time, seconds from the start of this file's footage (compose.mjs --cut-waits).
  waits: state.waits.map((w) => {
    const zero = hq ? (state.firstFrameAt ?? startedAt) : startedAt;
    return { from: +((w.from - zero) / 1000).toFixed(2), to: +((w.to - zero) / 1000).toFixed(2) };
  }),
  failed: failed ? String(failed instanceof Error ? failed.message : failed) : null,
};
writeFileSync(join(outDir, `${sceneName}.json`), JSON.stringify(meta, null, 2));
console.log(`Saved ${target} (${meta.durationSeconds}s${meta.startSeconds ? `, footage from ${meta.startSeconds}s` : ''})`);
if (failed) process.exit(1);
