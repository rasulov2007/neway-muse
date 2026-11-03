# NeWay TMS × Meta Muse

**NeWay is a transportation management system (TMS) for trucking companies, and for the Meta Muse
hackathon we made Meta Muse the model behind its assistant, NeWay AI.**

This is not a mock-up. NeWay runs the daily work of two real carriers:

- **USA Silk Way**: 120 trucks, about 2,000 loads a month
- **A&J Silk Road**: 4 trucks

(Owner's figures. This public snapshot has no data from either company. Every person, phone,
broker, rate and load you can see here is made up.)

Video: **[3-minute demo on YouTube](https://youtu.be/ZWak2C1-mnc)**

---

## The problem

A dispatcher at a 120-truck carrier has too many screens and too much typing:

- Typing up one broker **rate confirmation** (RC) takes **5 to 10 minutes**: the broker, every
  stop, the times, the rate, the equipment and the reefer temperature.
- Typing in a new driver's **CDL** takes **2 to 3 minutes**, and an error such as a wrong date of
  birth is easy to miss.
- A missing **proof of delivery** can go unnoticed for days, and the load can't be invoiced
  until it turns up.
- Most drivers speak **Uzbek or Russian** first. They call dispatch to ask "when is my next pickup?"

## What we built during the hackathon (Nov 3–4, 2026)

| | What | Where |
|---|---|---|
| 1 | **Muse Spark is NeWay AI's model.** It runs the chat, the tool calls and the **screen agent**. The screen agent drives the TMS UI itself: it opens tabs, types, and presses buttons. Before a risky press such as *Send*, it stops and asks a person. | `apps/api/src/modules/ai-assistant/muse-client.ts` (adapter), `apps/api/scripts/muse-smoke.mjs` |
| 2 | **8 new read-only fleet tools + the Morning brief.** The tools are `truck_status`, `expiring_compliance`, `fuel_anomalies`, `late_risk`, `route_deviation`, `hos_status`, `billing_missing_docs` and `hiring_pipeline`. `morning_brief` runs them all and ranks what it finds (urgent / warning / info). | `apps/api/src/modules/ai-assistant/insights/` (`insight-tools.ts`, `detect.ts`, `geo.ts`), `apps/web/src/features/ai-assistant/MorningBrief.tsx` |
| 3 | **Reading RCs and CDLs with Muse vision.** A PDF or a phone photo goes in and the form fills itself. Each field is marked *Sure*, *Check* or *Mismatch*. The CDL is checked against the driver's DOT application, for example a date of birth that doesn't match. | `apps/api/src/modules/muse-vision/muse-vision.service.ts`, `apps/api/src/modules/loads/rate-confirmation-reader.service.ts` (`RC_READER_PROVIDER=muse`), `apps/web/src/features/hr/CdlMuseReading.tsx` |
| 4 | **Voice questions from drivers in Uzbek, Russian and English.** The driver holds the mic and asks. Muse Spark listens to the audio directly, checks the driver's own load, and answers in the language the driver spoke. | `apps/api/src/modules/mobile/meta-transcribe.client.ts`, `apps/api/src/modules/mobile/driver-assistant.service.ts`, `apps/api/src/modules/mobile/wav.ts`, driver app in `apps/mobile/` |

**Already there before the hackathon** (we don't claim these as new): the NeWay TMS itself
(dispatch, loads, fleet, safety, accounting, HR, driver app), the NeWay AI chat panel, the
screen-driving mechanism (October 2026), and an older RC reader (templates plus a small local
model).

### Where the Meta models are used

| Model | Used for | Code |
|---|---|---|
| `muse-spark-1.3` | NeWay AI chat + tool calling + screen agent; Morning brief | `apps/api/src/modules/ai-assistant/muse-client.ts` (translates the assistant loop's messages to Meta's OpenAI-compatible `POST /v1/chat/completions`, including tools and images) |
| `muse-spark-1.3` (vision, strict `json_schema` output) | Reading rate confirmations and CDLs from PDFs and photos | `apps/api/src/modules/muse-vision/muse-vision.service.ts` |
| `muse-spark-1.3` (audio input) | Hearing a driver's spoken question. This is the main path because the transcribe model doesn't know Uzbek | `apps/api/src/modules/mobile/meta-transcribe.client.ts` |
| `muse-voice-transcribe-1.0` | Fallback speech-to-text (`POST /v1/asr/transcribe`) | `apps/api/src/modules/mobile/meta-transcribe.client.ts` |

All calls go to `https://api.meta.ai/v1` with the key from the `META_API_KEY` environment variable
(`apps/api/src/config/env.ts`). Interactive calls use `reasoning_effort: "low"`.

## How it works

```
 Web app (dispatch, fleet, HR)        Driver app (Expo)
          │  chat / screen agent              │  voice question (WAV)
          ▼                                   ▼
 ┌──────────────────────── NeWay API (NestJS) ────────────────────────┐
 │  NeWay AI loop ── muse-client.ts ───────────────► Meta Muse Spark  │
 │     │ tool calls run as the signed-in user, with their permissions │
 │     ▼                                                              │
 │  read-only tools (insights/*)    screen_* tools → the user's       │
 │  existing service doors (audit)   browser presses (asks first)     │
 │  muse-vision (RC / CDL)  ───────────────────────► Muse vision      │
 │  driver voice ───────────────────────────────────► Muse audio      │
 └───────────────────────────── PostgreSQL ───────────────────────────┘
```

- **Muse never touches the database.** It can only call NeWay's own tools, and those run with
  the permissions of the person who is signed in. Every query is filtered by `company_id`.
- **Dry run is on by default.** Risky screen presses (send, save, delete, pay) stop and wait for
  the person to press *Allow*. Every write goes through the existing service code, with version
  checks and an audit entry.
- Monorepo: `apps/api` (NestJS + Fastify + Drizzle + PostgreSQL), `apps/web` (React 19 + Vite +
  TanStack), `apps/mobile` (Expo driver app), `packages/shared` (Zod schemas and business rules).
  More detail: [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/AI_ARCHITECTURE.md](docs/AI_ARCHITECTURE.md).

## Measured results

Measured against the live Meta Model API on made-up sample documents
([docs/hackathon/vision-results.md](docs/hackathon/vision-results.md),
[docs/hackathon/voice-results.md](docs/hackathon/voice-results.md)):

| | By hand (owner's figure) | With Muse | Accuracy on the samples |
|---|---|---|---|
| Rate confirmation | 5–10 min | **~7 s** (6.5 s average) | 266 / 268 fields (99.3%), 4 RCs incl. a phone photo |
| CDL | 2–3 min | **~6 s** (5.2 s average) | 66 / 66 fields (100%), 3 cards incl. a tilted photo |
| Driver voice question | a phone call to dispatch | **5–10 s** from speech to answer | answered in the language spoken (uz / ru / en) |

The sample documents are in [docs/hackathon/samples/](docs/hackathon/samples/), and the right
answers are in `truth.json`. The voice samples are synthetic (Windows voices), except
`uz-owner-next-pickup*.wav`: that is the **real recording** used in the demo, the owner asking in
Uzbek *"Keyingi pikap qachon? Necha mil qoldi?"* ("When is my next pickup? How many miles are
left?").

## Run it locally with the demo data

You need Node.js 24 and npm 11 (see `.nvmrc`). You also need a Meta Model API key for the AI parts.
Everything else still works without one.

```bash
git clone <this repo> neway && cd neway
npm install                      # installs everything and builds packages/shared

# Meta key for NeWay AI, the Muse readers and driver voice (bash; in PowerShell: $env:META_API_KEY="...")
export META_API_KEY=your-meta-model-api-key

# Database + API + web + demo company, in one command.
# --pglite runs Postgres in WebAssembly (no install needed); leave it out to use a local PostgreSQL 16 on 127.0.0.1:5432.
node scripts/hackathon/demo-up.mjs --pglite --seed
```

Then open **http://127.0.0.1:5180/** and sign in as `demo.admin@silkway-demo.test` with password
`MuseDemo-2026!`. This is a local demo account created by the seed, and you can change it with
`DEMO_ADMIN_PASSWORD`. The company is **Silk Way Demo Lines**, a made-up carrier with 25 trucks,
38 loads, fuel, compliance, hiring and shop data that the AI tools can work with.

Prompts to try (on the NeWay AI page):

- "Good morning. What needs my attention today?" (or **Run now** on the Morning brief card)
- "Why can't load L-4117 be invoiced?", then switch **Dry run** off and ask Muse to fix it on screen
- "Did anyone fuel twice within an hour this week?"
- "Which loads will miss their appointment today?"
- Loads › Add load › upload `docs/hackathon/samples/rc-sample-2-example-logistics-reefer.pdf`

The full runbook covers the ports, keeping the data fresh, recording the scenes and composing
the video with `ffmpeg-static`: [docs/hackathon/DEMO-RUNBOOK.md](docs/hackathon/DEMO-RUNBOOK.md).
For normal development (`npm run dev`, your own PostgreSQL), copy `.env.example` to `.env`.

Tests: `npm test -w packages/shared`, `npm test -w apps/api` (unit; the `test/*.e2e.spec.ts`
files need a PostgreSQL in `TEST_DATABASE_URL`), `npm test -w apps/web`.

## What this snapshot leaves out

This is a clean snapshot of the private repository, made for the hackathon. It has no git
history. The following were removed: production deployment and server configuration, operational
scripts (backups, data migrations, production maintenance), internal reports and screenshots,
company-specific document templates, and broker-specific RC templates built from real documents.
Real names, phone numbers and identifiers in tests and comments were replaced with made-up ones.

## License

[MIT](LICENSE) © 2026 NeWay.
