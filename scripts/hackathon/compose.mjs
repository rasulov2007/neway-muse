#!/usr/bin/env node
/**
 * Build the final hackathon video: scene clips -> one 1920x1080, 30 fps, H.264 MP4 with the
 * voice-over (and optional quiet music), never longer than 3:00.
 *
 *   node scripts/hackathon/compose.mjs --voice docs/hackathon/video/voiceover.m4a \
 *        [--music docs/hackathon/video/music.mp3] [--music-volume 0.12] \
 *        [--scenes intro,brief,late-risk] [--out docs/hackathon/video/neway-muse.mp4] [--max 180]
 *
 *   --scenes      comma list of scene names, in order (default: every raw/*.webm by name)
 *   --raw         where the clips are (default docs/hackathon/video/raw)
 *   --voice       wav / m4a / mp3 voice-over; omit for a silent cut
 *   --music       optional background track, looped, ducked under the voice (sidechain)
 *   --music-volume 0..1 (default 0.12)
 *   --fade        seconds of crossfade between clips (default 0.4; 0 = hard cuts)
 *   --max         hard length cap in seconds (default 180); video and audio both fade out at the end
 *   --until-voice end the video when the voice-over ends (+1.5 s) instead of at the last clip
 *   --cut-waits N shorten every NeWay AI wait recorded by record.mjs to N seconds (e.g. 1.5);
 *                 the answer still appears, the minute of "Working…" does not
 *   --cut         drop stretches of a clip, in the clip's own seconds:
 *                 --cut ai-drives-screen:66-75,ai-morning-brief:40.5-44
 *
 * Each clip's <scene>.json (written by record.mjs) says where its useful footage starts; that
 * head is trimmed. Uses ffmpeg-static (no system ffmpeg needed).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const ffprobe = (() => {
  try {
    return require('ffprobe-static').path;
  } catch {
    return null;
  }
})();

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const flag = (n) => argv.includes(`--${n}`);

const rawDir = resolve(opt('raw', join(root, 'docs/hackathon/video/raw')));
const out = resolve(opt('out', join(root, 'docs/hackathon/video/neway-muse.mp4')));
const voice = opt('voice', null);
const music = opt('music', null);
const musicVolume = Number(opt('music-volume', '0.12'));
const fade = Number(opt('fade', '0.4'));
const maxSeconds = Number(opt('max', '180'));
const cutWaits = opt('cut-waits', null) === null ? null : Number(opt('cut-waits', '1.5'));
/** --cut scene:from-to,... -> { scene: [[from, to], ...] } */
const manualCuts = {};
for (const item of (opt('cut', '') ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
  const m = /^([\w-]+):(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(item);
  if (!m) {
    console.error(`--cut: cannot read "${item}" (scene:from-to)`);
    process.exit(1);
  }
  (manualCuts[m[1]] ??= []).push([Number(m[2]), Number(m[3])]);
}
const FPS = 30;
const W = 1920;
const H = 1080;

const scenes = (opt('scenes', null)?.split(',').map((s) => s.trim()).filter(Boolean)) ??
  readdirSync(rawDir).filter((f) => f.endsWith('.webm')).map((f) => basename(f, '.webm')).sort();
if (!scenes.length) {
  console.error(`No clips in ${rawDir}`);
  process.exit(1);
}
for (const f of [voice, music].filter(Boolean)) {
  if (!existsSync(f)) {
    console.error(`Not found: ${f}`);
    process.exit(1);
  }
}

/** Duration in seconds, from ffmpeg's own banner (ffprobe is not bundled). */
function durationOf(file) {
  if (ffprobe) {
    const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    const d = Number(r.stdout.trim());
    if (Number.isFinite(d) && d > 0) return d;
  }
  // WebM from a recorder often has no duration in the header: decode to null and read the last time=.
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  const text = r.stderr ?? '';
  const times = [...text.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const last = times.at(-1);
  if (last) return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  throw new Error(`Cannot read the duration of ${file}`);
}

const clips = scenes.map((name) => {
  const file = join(rawDir, `${name}.webm`);
  if (!existsSync(file)) throw new Error(`Missing clip ${file} (record it with record.mjs ${name})`);
  const metaFile = join(rawDir, `${name}.json`);
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};
  const total = durationOf(file);
  const start = Math.min(Math.max(0, meta.startSeconds ?? 0), Math.max(0, total - 1));
  // The footage to keep: [start, total] minus the AI waits (each shortened to cutWaits seconds).
  let segments = [[start, total]];
  if (cutWaits !== null) {
    for (const w of meta.waits ?? []) {
      const from = w.from + cutWaits / 2;
      const to = w.to - cutWaits / 2;
      if (to - from < 1) continue;
      segments = segments.flatMap(([a, b]) => (to <= a || from >= b ? [[a, b]] : [[a, from], [to, b]].filter(([x, y]) => y - x > 0.05)));
    }
  }
  for (const [from, to] of manualCuts[name] ?? []) {
    segments = segments.flatMap(([a, b]) => (to <= a || from >= b ? [[a, b]] : [[a, from], [to, b]].filter(([x, y]) => y - x > 0.05)));
  }
  const length = segments.reduce((n, [a, b]) => n + (b - a), 0);
  return { name, file, start, segments, length };
});

// ------------------------------------------------------------------------------------ the graph

const inputs = [];
const filters = [];
clips.forEach((c, i) => {
  inputs.push('-i', c.file);
  // Same size, rate, pixel format and timebase for every clip so xfade/concat accept them.
  const norm = `fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,format=yuv420p`;
  if (c.segments.length === 1) {
    const [a, b] = c.segments[0];
    filters.push(`[${i}:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=PTS-STARTPTS,${norm}[v${i}]`);
  } else {
    const parts = c.segments.map((_, k) => `[s${i}_${k}]`);
    filters.push(`[${i}:v]split=${c.segments.length}${parts.join('')}`);
    c.segments.forEach(([a, b], k) => filters.push(`[s${i}_${k}]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=PTS-STARTPTS[p${i}_${k}]`));
    // Normalise after the join: xfade needs one frame rate and timebase on both sides.
    filters.push(`${c.segments.map((_, k) => `[p${i}_${k}]`).join('')}concat=n=${c.segments.length}:v=1:a=0,${norm}[v${i}]`);
  }
});
let videoLabel = 'v0';
let videoLength = clips[0].length;
/** Where each clip starts in the film (for writing the voice-over to the picture). */
const timeline = [{ name: clips[0].name, at: 0 }];
for (let i = 1; i < clips.length; i += 1) {
  const label = `x${i}`;
  timeline.push({ name: clips[i].name, at: fade > 0 ? Math.max(0, videoLength - fade) : videoLength });
  if (fade > 0) {
    const offset = Math.max(0, videoLength - fade);
    filters.push(`[${videoLabel}][v${i}]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}[${label}]`);
    videoLength = offset + clips[i].length;
  } else {
    filters.push(`[${videoLabel}][v${i}]concat=n=2:v=1:a=0[${label}]`);
    videoLength += clips[i].length;
  }
  videoLabel = label;
}

let audioLabel = null;
let voiceLength = null;
let nextInput = clips.length;
if (voice) {
  voiceLength = durationOf(voice);
  inputs.push('-i', voice);
  filters.push(`[${nextInput}:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-16:TP=-1.5:LRA=11[voice]`);
  audioLabel = 'voice';
  nextInput += 1;
}
if (music) {
  inputs.push('-stream_loop', '-1', '-i', music);
  filters.push(`[${nextInput}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${musicVolume}[music]`);
  if (audioLabel) {
    // Duck the music under the voice, then mix (voice stays at full level).
    filters.push('[voice]asplit=2[voice1][voicekey]');
    filters.push('[music][voicekey]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked]');
    filters.push('[voice1][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]');
    audioLabel = 'mix';
  } else audioLabel = 'music';
  nextInput += 1;
}

let finalLength = videoLength;
if (flag('until-voice') && voiceLength) finalLength = voiceLength + 1.5;
finalLength = Math.min(finalLength, maxSeconds);
if (finalLength > videoLength) {
  // Hold the last frame while the voice finishes.
  filters.push(`[${videoLabel}]tpad=stop_mode=clone:stop_duration=${(finalLength - videoLength + 0.1).toFixed(3)}[vhold]`);
  videoLabel = 'vhold';
}
const fadeOut = Math.min(1.0, finalLength / 4);
filters.push(`[${videoLabel}]trim=duration=${finalLength.toFixed(3)},fade=t=in:st=0:d=0.4,fade=t=out:st=${(finalLength - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[vout]`);
if (audioLabel) {
  filters.push(`[${audioLabel}]apad,atrim=duration=${finalLength.toFixed(3)},afade=t=out:st=${(finalLength - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[aout]`);
}

mkdirSync(dirname(out), { recursive: true });
const args = [
  '-y', '-hide_banner', '-loglevel', 'error', '-stats',
  ...inputs,
  '-filter_complex', filters.join(';'),
  '-map', '[vout]',
  ...(audioLabel ? ['-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000'] : ['-an']),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS),
  '-movflags', '+faststart',
  '-t', finalLength.toFixed(3),
  out,
];

console.log(`Composing ${clips.length} clip(s): ${clips.map((c) => `${c.name} ${c.length.toFixed(1)}s`).join(', ')}`);
const mmss = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
console.log(`Timeline: ${timeline.map((t) => `${mmss(t.at)} ${t.name}`).join(' · ')}`);
console.log(`Video ${videoLength.toFixed(1)}s${voiceLength ? `, voice ${voiceLength.toFixed(1)}s` : ''}${music ? ', music ducked under the voice' : ''} -> ${finalLength.toFixed(1)}s (cap ${maxSeconds}s)`);
const r = spawnSync(ffmpeg, args, { stdio: ['ignore', 'inherit', 'inherit'] });
if (r.status !== 0) {
  console.error('ffmpeg failed');
  process.exit(1);
}
console.log(`\nSaved ${out} (${durationOf(out).toFixed(2)}s, ${W}x${H} ${FPS} fps H.264)`);
