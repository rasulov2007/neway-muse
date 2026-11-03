# Ask NeWay by voice — Meta Muse results (2026-11-03)

Driver app → **hold the mic, ask in Uzbek, Russian or English** → `POST /driver/assistant/voice` →
Meta **muse-voice-transcribe-1.0** hears it → the existing Ask NeWay answer path (NeWay AI `complete()`
with the driver's own facts) answers **in the language the driver spoke** → the phone shows the words
heard and the answer, and reads the answer aloud with its own voice.

## What Meta's API does and does not do (tested, not guessed)

| Question | Finding |
|---|---|
| Speech → text endpoint | `POST https://api.meta.ai/v1/asr/transcribe`, multipart with two parts: `request` (JSON `{"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV"}`) and `audio` (the bytes). Answer `{ transcript, audioDurationMs, turns }`. `/audio/transcriptions` (OpenAI style) is 404. |
| Audio formats | **WAV only**, and only "mono s16le at 16000 or 24000 Hz" (Meta's own error text). MP3, M4A/AAC, WebM, Opus, FLAC are "Malformed request"; 44.1/48 kHz or stereo WAV is refused. The server therefore converts any PCM WAV (any rate, stereo, float) to 16 kHz mono before the call (`apps/api/src/modules/mobile/wav.ts`). |
| Language hint | `language` / `languages` fields are accepted but made no difference; it detects the language itself. |
| Uzbek | Heard, but written in **Russian letters** ("Кинги пикап качон. Нича мил колди." for "Keyingi pikap qachon? Necha mil qoldi?"). The server recognises Cyrillic-written Uzbek words and the prompt tells Muse to answer in Uzbek (Latin script) — it did. |
| Text → speech | **None.** `/audio/speech`, `/tts`, `/tts/synthesize` … are all 404 and the model list has no TTS model. Answers are read by the device (`expo-speech`; in the browser, the Web Speech API). The server's key-less `/ai/tts` (Azure) path is untouched. |
| muse-spark-1.3 with audio | Also transcribes `input_audio` (wav/mp3) in chat completions, but slower (~3 s, reasoning tokens) — not used. |

## Sample clips

`docs/hackathon/samples/voice/` — generated with Windows SAPI (`System.Speech`), 16 kHz mono WAV:

| Clip | Voice | Question |
|---|---|---|
| `en-next-pickup.wav` | Microsoft Zira (en-US) | "When is my next pickup, and how many miles are left?" |
| `en-next-delivery-48khz.wav` | default SAPI voice (en-US), **48 kHz** | "When is my next delivery?" — proves the 48 kHz → 16 kHz conversion |
| `ru-next-pickup.wav` | Microsoft Irina (ru-RU) | "Когда у меня следующая погрузка и сколько миль осталось?" |
| `uz-next-pickup.wav` | Microsoft Irina (ru-RU) reading Uzbek | "Кейинги пикап качон? Неча мил колди?" (= "Keyingi pikap qachon? Necha mil qoldi?") |

**Honest note on Uzbek:** this PC has no Uzbek SAPI voice (installed: David, Zira, Mark en-US; Irina,
Pavel ru-RU). The Uzbek clip is Uzbek words read by the Russian voice, i.e. a strong accent. For the
video, record a real Uzbek speaker: in the web build just hold the mic and speak; or record a WAV on
any phone and drop it in this folder (any rate — the server converts it).

## Results — real Meta API, two runs

Run with `apps/api/test/voice-eval.spec.ts` (real Meta transcription; answer model `muse-spark-1.3`,
`reasoning_effort: "low"`, through the same `DriverAssistantService.voice` prompt). The driver is a
made-up demo driver: load L-24817, pickup Demo Foods DC, Joliet IL (Wed 2 PM ET / 1 PM CT), delivery
Demo Grocers, Atlanta GA, 717 loaded miles. Seconds measured from this PC.

### Run 1

| Clip | Heard (Meta) | Lang | Answer (Muse) | Hear s | Answer s | Total s |
|---|---|---|---|---|---|---|
| en-next-delivery-48khz | When is my next delivery? | en | Your next delivery is Friday 9 AM Eastern in Atlanta for load L-24817. The facility is Demo Grocers. | 2.2 | 3.1 | 5.3 |
| en-next-pickup | When is my next pickup and how many miles are left? | en | Your next pickup is Wednesday 2 PM Eastern in Joliet for load L-24817. The load is 717 loaded miles. Your live miles left are on the truck navigation. | 1.8 | 3.8 | 5.6 |
| ru-next-pickup | Когда у меня следующая погрузка и сколько миль осталось? | ru | Следующая погрузка в среду в 2 часа дня по восточному времени в Джолиет, груз L-24817. По системе всего 717 миль с грузом. Сколько осталось сейчас смотри в навигации грузовика. | 1.9 | 5.5 | 7.4 |
| uz-next-pickup | Кинги пикап качон. Нича милколди. | uz | Keyingi pikapingiz L-24817 Jolietda Chorshanba 2 PM Eastern. Yuk 717 mil, jonli qolgan mil mashina navigatsiyasida. | 2.4 | 6.2 | 8.5 |

### Run 2

| Clip | Heard (Meta) | Lang | Answer (Muse) | Hear s | Answer s | Total s |
|---|---|---|---|---|---|---|
| en-next-delivery-48khz | when is my next delivery? | en | Your next delivery is Friday 9 AM Eastern in Atlanta. It is load L-24817 to Demo Grocers. Your next stop is a pickup Wednesday 2 PM Eastern in Joliet. | 3.4 | 5.1 | 8.6 |
| en-next-pickup | when is my next pick up and how many miles are left? | en | Your next pickup is Wednesday 2 PM Eastern in Joliet at Demo Foods DC for load L-24817. The load is 717 loaded miles. Live miles left are on your truck navigation. | 2.2 | 3.9 | 6.1 |
| ru-next-pickup | Когда у меня меня следующая погрузка и и сколько миль осталось? | ru | Ваша следующая погрузка L-24817 в Joliet в среду 2 PM Eastern. По системе там 717 миль груза. Точный остаток смотрите в навигации трака. | 2.0 | 7.7 | 9.6 |
| uz-next-pickup | Кенги пикап качон. Нича милколди. | uz | Keyingi pikapingiz L-24817, ertaga chorshanba 2 PM Eastern, Jolietda Demo Foods DCda. Bu yuk 717 mil. Jonli qolgan mil yuk mashinasi navigatsiyasida korinadi. | 2.3 | 3.8 | 6.2 |

Observations

- Hearing takes ~2 s for a 3–5 s clip; the answer 3–8 s at `reasoning_effort: "low"`. Total 5–10 s.
- Every answer came back in the language spoken, used only the facts given (load number, city,
  Eastern time, loaded miles), and said honestly that live miles left are on the truck's navigation
  (the TMS has no live position in the driver's facts).
- The synthetic Russian voice sometimes gets a doubled word ("меня меня"); Muse ignores it.
- Uzbek with an accented synthetic voice was still understood in both runs.

## Re-running

```bash
cd apps/api
META_API_KEY=<your Meta Model API key> \
VOICE_EVAL=1 VOICE_EVAL_OUT=/some/file.jsonl npx vitest run test/voice-eval.spec.ts
```

(On this PC cmd.exe spawns are refused, so vitest needs a `--require` shim that skips Vite's
`net use` probe; see the A4 report.)
