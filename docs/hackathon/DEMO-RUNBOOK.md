# Hackathon demo runbook (local only)

Everything here runs on this PC. Nothing is deployed and production is never touched: the seed
refuses any database that is not on localhost, and the demo uses its own database `neway_demo`.

Run these from the checkout that holds the AI work (branch `hackathon/muse`, or this branch
`hackathon/a5-demo` once merged into it). On `hackathon/a5-demo` alone, the AI tools and the
Morning brief card are not there yet; the placeholder scene still works.

## Login

| | |
|---|---|
| URL | http://127.0.0.1:5180/ |
| Email | `demo.admin@silkway-demo.test` |
| Password | `MuseDemo-2026!` |
| Company | **Silk Way Demo Lines** (`co_silkway_demo`), role Administrator, light appearance |

The password is set by the seed (override with `DEMO_ADMIN_PASSWORD=...` when seeding). Re-seeding
signs the demo admin out.

## Start

One-time, in the checkout:

```powershell
npm install --prefer-offline
```

Then:

```powershell
npm run db:start                                  # local PostgreSQL on 127.0.0.1:5432 (own terminal, if not already running)
node scripts/hackathon/demo-up.mjs                # creates neway_demo, builds, starts API + web, seeds if empty
```

`demo-up.mjs` does, in order:

1. Checks PostgreSQL on 127.0.0.1:5432 (starts it with `pg_ctl` if it is down) and creates the
   database `neway_demo` owned by `neway` the first time (as the `postgres` superuser, password
   `postgres`; set `PG_SUPERUSER_PASSWORD` if yours differs).
2. Builds `packages/shared` and the API (`--no-build` skips this).
3. Reads `%USERPROFILE%\.neway-secrets\meta-llama.env` (`LLAMA_API_KEY=...`) and passes it to the API
   process only, as `META_API_KEY`. It is never printed, logged or written.
4. Starts the API on **3100** (`node apps/api/dist/main.js`; it runs the migrations on boot) with
   `SEED_DEMO_DATA=false`, the Fleet/PM/Safety/Accidents flags on, and every integration clock off.
5. Seeds Silk Way Demo Lines when the company is not there yet (`--seed` forces a fresh seed);
   otherwise refreshes the ELD positions and load times to "now".
6. Starts the web on **5180** (Vite, `VITE_DATASET=empty`, proxy to the API).

Options: `--api-port 3100 --web-port 5180 --seed --no-build --keep-fresh --pglite`.
Logs: `scripts/hackathon/logs/{api,web,pglite,keep-fresh}.log`.

## Stop

`Ctrl+C` in the `demo-up` window stops the API and the web (and PGlite in `--pglite` mode).
PostgreSQL keeps running; stop it with `npm run db:stop` if you want.

## Before every recording: freshen the data

The late-risk and route checks only trust ELD positions **under 15 minutes old**, and the ETA moves
with the clock. Right before a take:

```powershell
$env:DATABASE_URL = 'postgres://neway:neway@127.0.0.1:5432/neway_demo'
node scripts/hackathon/seed-demo.mjs --positions-only     # positions, ETAs and appointments re-timed to now
```

or keep it fresh during a long session (every 5 minutes):

```powershell
node scripts/hackathon/demo-up.mjs --keep-fresh            # or: node scripts/hackathon/seed-demo.mjs --keep-fresh
```

A full re-seed (`node scripts/hackathon/seed-demo.mjs`) puts every record back exactly (deterministic
data, times relative to now) and also resets the Daily board status words to today.

## What the demo company holds

All of it is invented: people, phones (555-01xx), e-mails (`@silkway-demo.test` / `@example.com`),
brokers, shippers, rates, VINs, unit numbers. No real driver, broker, CDL number or rate.

| Area | What is there | Where it lives |
|---|---|---|
| Fleet | 25 trucks (1101-1125), 27 trailers (5301-5327), 25 drivers, 3 dispatchers (Nadia Reyes, Colin Avery, Priya Raman), safety, recruiter, fleet manager, billing | `trucks`, `trailers`, `drivers`, `truck_driver_assignments`, `employees`, `dispatch_roster` |
| Loads | 38: 11 in transit, 1 at pickup, 1 loaded, 1 at delivery, 1 dispatched, 1 assigned, 12 delivered, 6 closed, 2 booked, 1 cancelled, 1 TONU | `loads.record` |
| ELD | live positions (1-6 min old) for every moving truck; parked trucks at home | `trucks.location` |
| Late risk | **L-4107** truck 1108 Atlanta -> Harrisburg: **late** (ETA ~95 min past the window). **L-4105** truck 1106 Houston -> Kansas City: **at risk** (ETA 22 min before the window closes). The other 8 in transit are on time | load stops + position |
| Off route | **L-4102** truck 1102 Dallas -> Atlanta is near Little Rock, AR: ~118 mi off the line | position |
| Fuel | 78 fills over two weeks; **truck 1103** fueled twice in 38 min (Memphis, 4 mi apart); **truck 1120** twice in 52 min (Phoenix, 11 mi apart, 320 gal together, more than the tanks hold) | `app_state` `t.co_silkway_demo.ws2-fueltransactions` |
| Billing | **L-4117, L-4118, L-4119** delivered 2-4 days ago with no POD; 9 more delivered with full paperwork (ready to bill) | `loads.record.documents` |
| Compliance | Omar Haddad medical card **expired** (driver on HOLD); Gavin Lund medical card expires in 9 days; Shane Kowalski CDL in 21 days; Luis Arredondo MVR review in 11 days; truck 1119 registration **expired**; truck 1112 registration in 12 days; truck 1107 annual inspection in 6 days; trailer 5309 registration **expired**; trucks 1118 and 1123 have **no insurance cab card** on file; company insurance filing in 24 days | `qualification_items` + `compliance_documents` |
| Hiring | 13 leads / 8 candidates: new lead stuck 3 days (Brody Kessler), contacted lead stuck 6 days (Dmitri Volkov), Felix Navarro and Hugo Lambert in Safety review **waiting on MVR and PSP** (stuck), Gideon Hart waiting on PSP, Ivan Rusu stuck in application, Jonah Whitley offer, Kofi Mensah orientation, Milo Draper hired, Leon Brandt disqualified | `hiring_leads`, `hiring_cases`, `hiring_safety_reviews`, `hiring_safety_checks` |
| Shop / PTI | trucks 1105 (brakes, waiting parts), 1115 (turbo, in repair), 1121 (coolant leak, diagnosing) in the shop; 4 completed repairs; this week's PTI received for most, late for 1108/1114, awaiting for 1112/1124/1125; 5 open defects (DEF-0301..0305) incl. an OOS-risk brake defect on 1105 | `work_orders`, `work_order_lines`, `pti_inspections`, `pti_defects` |
| Daily board | today's STATUS words (ENROUTE, AT PU, UNLOADING, DISPATCHED, COVERED, SHOP, HOME, VACATION, READY) under three dispatcher teams | `dispatch_board_cells` |

The Morning brief on this data (checked against hackathon/muse d5939201): 5 urgent, 7 warning,
11 info — late L-4107, expired medical card / registrations, truck 1120 double fill; at-risk L-4105,
inspection in 6 days, truck 1102 off route, truck 1103 double fill, three loads missing POD; then
expiring papers, 2 missing cab cards and 6 stuck candidates.

## Prompts that land on this data

| Tool | Prompt |
|---|---|
| morning_brief | "Good morning. What needs my attention today?" (or **Run now** on the Morning brief card) |
| late_risk | "Which loads will miss their appointment today?" |
| route_deviation | "Is any truck off its route right now?" |
| fuel_anomalies | "Did anyone fuel twice within an hour this week?" |
| billing_missing_docs | "Which delivered loads can I not invoice yet, and why?" |
| expiring_compliance | "Whose papers expire in the next 30 days? Anything already expired?" |
| hiring_pipeline | "Which candidates are stuck, and who is waiting on MVR or PSP?" |
| truck_status | "What is wrong with truck 1105 and when is it back?" |

## Record a scene

```powershell
node scripts/hackathon/record.mjs --list                    # the scenes
node scripts/hackathon/record.mjs placeholder               # -> docs/hackathon/video/raw/placeholder.webm (+ .json)
node scripts/hackathon/record.mjs ai-morning-brief --hq     # sharper text (CDP frames -> VP9 CRF 18)
```

- 1920x1080, deviceScaleFactor 1, light theme (`--theme dark` for dark), US Eastern browser clock.
- Signs in off camera first (`--login-on-camera` to show the sign-in), then runs the scene.
- A drawn cursor glides between targets; typing is human speed (35-110 ms per key, beats after
  punctuation); `h.askAi()` waits until NeWay AI has answered, then holds the frame.
- `--base http://127.0.0.1:5181` points at another web port; `--headed` shows the browser.

Scenes are `scripts/hackathon/scenes/<name>.mjs`:

```js
export default {
  name: 'Late loads',
  description: 'one line for --list',
  async run({ page, h }) {
    await h.goto('/ai');                         // waits for the page to settle ("Loading…" gone)
    await h.askAi('Which loads will miss their appointment today?', { holdMs: 5000 });
    await h.click(page.getByRole('link', { name: 'L-4107' }));
    await h.pause(3000);
  },
};
```

Helpers: `goto(path)`, `settle()`, `click(locatorOrSelector)`, `moveTo(target)`, `type(target, text)`,
`askAi(prompt, { holdMs })`, `scroll(dy)`, `pause(ms)`, `login()`.

Scenes in the box: `placeholder` (dashboard -> Daily board -> load L-4101; works on any branch),
`ai-morning-brief`, `ai-ops-questions`, `ai-compliance-hiring`, `ai-truck-status` (need hackathon/muse).

## Compose the final video

ffmpeg comes from the `ffmpeg-static` dev dependency (no install, no admin rights).

```powershell
node scripts/hackathon/compose.mjs `
  --scenes placeholder,ai-morning-brief,ai-ops-questions `
  --voice docs/hackathon/video/voiceover.m4a `
  --music docs/hackathon/video/music.mp3 --music-volume 0.12 --cut-waits 1.5 `
  --out docs/hackathon/video/neway-muse.mp4
```

- Clips in the order given (default: every `raw/*.webm`), blank head trimmed (from each clip's
  `.json`), 0.4 s crossfades (`--fade 0` for cuts), scaled to 1920x1080, 30 fps.
- H.264 High (CRF 18, `+faststart`) + AAC 192k. Voice is loudness-normalised (-16 LUFS); music is
  looped and ducked under the voice.
- `--cut-waits 1.5` shortens every NeWay AI "Working…" wait that `record.mjs` noted (in the clip's
  `.json`) to 1.5 s, so a 60-second model call does not eat the 3 minutes.
- Hard cap 3:00 (`--max 180`), with a 1 s fade out. `--until-voice` ends the video with the
  voice-over (holding the last frame if the clips are shorter).
- Media files under `docs/hackathon/video/` are git-ignored.

## When it does not work

| Symptom | Fix |
|---|---|
| `PostgreSQL is not listening` | `npm run db:start` in your own terminal. If PostgreSQL cannot start at all, `node scripts/hackathon/demo-up.mjs --pglite` (PGlite comes with `npm install`; Postgres-in-WebAssembly on 127.0.0.1:5433, data in `scripts/hackathon/.data/pglite`, API pool of 1) |
| Late risk / route says positions are too old | `node scripts/hackathon/seed-demo.mjs --positions-only` (or run with `--keep-fresh`) |
| L-4105 shows late instead of at risk | more than ~20 min passed since the last refresh: refresh positions |
| Port in use | `--api-port` / `--web-port` |
| NeWay AI says it is not set up | the Meta key file is missing; check `%USERPROFILE%\.neway-secrets\meta-llama.env` |
| Vite: `spawn EPERM` | only where cmd.exe is blocked; `demo-up` already starts Vite through `scripts/hackathon/vite-launch.mjs`, which handles it |
| Seed says `No schema here` | start the API once against the database (it migrates on boot), then seed |

## Final film (v3) and the 30-second cut

```powershell
# 2x takes (3840x2160, so the film can zoom 150-240 % and text stays sharp); cards at 1x
node scripts/hackathon/record.mjs ai-drives-screen --hq --scale 2 --out docs/hackathon/video/raw2x
node scripts/hackathon/record.mjs rc-drop          --hq --scale 2 --out docs/hackathon/video/raw2x
node scripts/hackathon/record.mjs cdl-read         --hq --scale 2 --out docs/hackathon/video/raw2x
node scripts/hackathon/record.mjs driver-voice     --hq --scale 2 --out docs/hackathon/video/raw2x   # driver web app on :8094
node scripts/hackathon/record.mjs ai-driver-pay    --hq --scale 2 --out docs/hackathon/video/raw2x   # after seed-pay.mjs
node scripts/hackathon/record.mjs ai-morning-brief --hq --scale 2 --out docs/hackathon/video/raw2x
node scripts/hackathon/record.mjs oneline      --hq --out docs/hackathon/video/raw2x   # also architecture, built-during, end-card

node scripts/hackathon/seed-pay.mjs          # demo payroll set-up through the API (local only; one $1.62/mi typo to flag)
python scripts/hackathon/tts.py              # voice-over, one mp3 per line of vo-lines.json (edge-tts, en-US-AndrewNeural; Uzbek uz-UZ-SardorNeural)
node scripts/hackathon/final.mjs             # -> video/neway-muse-final.mp4 + video/final-subtitles.srt
node scripts/hackathon/final.mjs --short     # -> video/neway-muse-30s.mp4
```

The scene plan (clip stretches, speed-ups, camera keyframes, voice timings, labels) is at the top of
`final.mjs`. Overlays (titles, subtitles, labels) are rendered by Chromium in Manrope; the music is a
pad synthesised by ffmpeg (no downloaded audio), ducked under the voice. `--reuse` keeps the last
render's video pieces and redoes only overlays and sound.
