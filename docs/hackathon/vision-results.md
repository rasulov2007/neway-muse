# Muse vision — CDL and RC reading results

Measured 2026-11-03 against the live Meta Model API (`muse-spark-1.3`, `reasoning_effort: "low"`,
strict `json_schema` output), two runs per document, from a developer laptop. Raw numbers:
[vision-results.json](vision-results.json). All documents are fictional samples in
[samples/](samples/) (right answers in [samples/truth.json](samples/truth.json)); no real driver,
broker or rate is used anywhere.

How it was run (the key is read from the secrets file at runtime, never printed):

```
cd apps/api
MUSE_LIVE=1 META_KEY_FILE=~/.neway-secrets/meta-llama.env \
  npx vitest run src/modules/muse-vision/vision-bench.live.spec.ts
```

The benchmark goes through the same code the product uses: `MuseVisionService` +
`cdlReadingFromAnswer` for licences, `RateConfirmationReaderService.read` with
`RC_READER_PROVIDER=muse` (then `tidyRcExtract`) for rate confirmations.

## CDL reader — 11 fields per card

Fields: first, middle, last name, date of birth, licence number, state, class, endorsements,
restrictions, issued, expires.

| Sample | Kind | Fields right | Seconds (run 1 / run 2) |
|---|---|---|---|
| `cdl-sample-jordan-sampleton.png` | clean PNG | 11 / 11 | 4.9 / 4.4 |
| `cdl-sample-alex-rivera-photo.jpg` | phone photo: tilted, dim, noisy, expired card | 11 / 11 | 6.0 / 4.6 |
| `cdl-sample-jordan-sampleton.pdf` | the card scanned into a PDF | 11 / 11 | 6.1 / 5.3 |
| **Total** | | **66 / 66 (100%)** | **5.2 s average** |

- No field was marked for review on any card: Muse gave every field ≥ 0.8 confidence.
- The expired card (EXP 10/15/2026) came back with the urgent warning "The licence expired on
  2026-10-15." — the read is checked against today's Eastern date on the server.
- About 2,000–3,600 prompt tokens and 520–620 output tokens per card (275–390 of them reasoning).

## RC reader — header + every stop field

Fields: broker name, MC, load number, total, linehaul, commodity, weight, equipment, hazmat,
temperature, miles, then kind / facility / street / city / state / ZIP / date / time / window end /
reference for every stop.

| Sample | Kind | Fields right | Seconds (run 1 / run 2) |
|---|---|---|---|
| `rc-sample-1-demo-freight.pdf` | PDF, 2 stops, dry van, window | 31 / 31 | 5.5 / 6.0 |
| `rc-sample-2-example-logistics-reefer.pdf` | PDF, 3 stops, reefer -5°F, 12-hour times, decimal weight | 41 / 41 | 7.1 / 5.4 |
| `rc-sample-3-sample-haul-flatbed.pdf` | PDF, 2 stops, flatbed, FCFS, no street | 31 / 31 | 5.9 / 7.2 |
| `rc-sample-3-sample-haul-flatbed-photo.jpg` | the same RC as a tilted phone photo (no text layer) | 30 / 31 | 9.0 / 5.9 |
| **Total** | | **266 / 268 (99.3%)** | **6.5 s average** |

The one miss, both runs: on the flat-rate RC (one line "Flat rate $1,975.00") the photo read put
$1,975 into linehaul as well as total. Total, the number pay runs on, was right.

## Compared with today's RC reader

| Reader | Time per RC | Scans / photos | Notes |
|---|---|---|---|
| Templates (known brokers) | instant | no | still first; Muse never sees a known broker's RC |
| Fine-tuned 0.5B `neway-rc` in Ollama (production) | ~3 min | via OCR (v2) | 88.5% on its own held-out set (project notes, 2026-10-01) |
| **Muse (`RC_READER_PROVIDER=muse`)** | **~6.5 s** | **yes, directly** | 99.3% on the 4 samples here |

The 88.5% and ~3 min come from the production notes, measured on real RCs that cannot be used
here; the Muse numbers come from 4 fictional RCs, so this is a speed comparison more than an
accuracy one. No RC sample files exist in the repo's specs (they test with inline text only), so
nothing else was measured.

## Not measured

- The CDL mismatch warnings (name / DOB / licence number against the DOT application) are covered
  by unit tests, not by this benchmark: the benchmark has no application to compare with.
- The screens were not exercised end-to-end in a browser here: this agent's sandbox could not
  start processes (dev server, Postgres container, Playwright browser).
