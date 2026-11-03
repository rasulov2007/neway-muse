# NeWay TMS — mobile app (Driver + Office)

Expo SDK 58 (React Native 0.88, React 19.3), TypeScript strict, expo-router. One app, two shells:
**Driver** (Today · Trips · Money · Inbox · More) and **Office** (Today · Work · Inbox · Approvals ·
More). Plan and API contract: [docs/mobile/PLAN.md](../../docs/mobile/PLAN.md); the four design sheets
in `docs/mobile/reference/` are the visual spec.

This folder is **not** a root npm workspace (the root `package.json` lists `apps/api` and `apps/web`
explicitly), so React Native never touches the web build. Install and run everything from here.

## Run it

```bash
cd apps/mobile
npm install                 # this folder's own node_modules
cp .env.example .env        # EXPO_PUBLIC_API_URL, see below
npx expo start              # QR code for Expo Go; press w for the web build
```

- **Expo Go** (iOS/Android) runs it: every native module used is in Expo Go, except that Expo Go
  cannot receive remote push (use a development build, `eas build --profile development`). A physical phone
  cannot reach `localhost`; set `EXPO_PUBLIC_API_URL=http://<your-computer's-LAN-IP>:3200/api/v1`.
- **Web** (`npx expo start --web`, or `npx expo export --platform web` + any static server) is for
  development and screenshots. The API has no CORS allowance, so serve the build behind a proxy that
  forwards `/api` to the API and build with `EXPO_PUBLIC_API_URL=/api/v1` (Git Bash: prefix
  `MSYS_NO_PATHCONV=1`, or the path is rewritten to a Windows path). `node scripts/web-demo-server.mjs
  <export-dir> [port]` is such a proxy for a local API (`API_TARGET`, default `http://localhost:3000`);
  on `http://localhost` the browser allows the microphone for Ask NeWay. On the web there is no camera
  (photo picker instead), no push, the queue lives in localStorage, and queued files are kept as data:
  URIs inside the queue item so they survive a reload (a file too big for localStorage stays in
  memory only).
- Staging API: from the `mobile-app` worktree, `apps/api`: `npx nest build && node dist/main.js`
  (its root `.env` gives PORT 3200 and the `neway_mobile` database).

| Variable | Meaning |
|---|---|
| `EXPO_PUBLIC_API_URL` | API base, default `http://localhost:3200/api/v1`. Inlined at build time; `eas.json` sets it per profile. |

## Checks

```bash
npx tsc --noEmit   # strict typecheck (includes the shared types from packages/shared/src)
npx jest           # queue rules + runner, PDF builder
npx expo-doctor    # dependency / config check
```

## How it is put together

- `src/app` — routes (expo-router). `/login`, `/change-password`, `/driver/(tabs)/*`,
  `/office/(tabs)/*` and the detail screens. The shell comes from `/auth/me`: `account.kind ===
  'driver'` (or only `driver_app.use`) → Driver; anything else → Office; a person with both switches
  in More.
- `src/ui` — the design system from the sheets: tokens (navy primary, white, gray text levels,
  hairlines, five status families with soft backgrounds), `AppHeader` (Eastern date/time for
  drivers; company switcher + bell + initials for office), `TabBar`, `Button`, `ListRow`,
  `StatusPill`/`StatusSymbol` (shape + word, never colour alone), `SegmentedTabs`, `Timeline`,
  `TextField`/`Select`/`DateField`/`WeekPicker`, Loading/Empty/Error/Offline/No-access/Not-connected/
  Coming-soon states, `OfflineBanner`, `Toast`.
- `src/api` — `client.ts` (bearer token in expo-secure-store, problem+json → `ApiError` kinds, 401 →
  login without touching drafts, `uploadRaw` with XHR progress + Idempotency-Key), `contract.ts`
  (routes; M1 types imported from `packages/shared/src/mobile`), `use-resource.ts`.
- `src/offline` — SQLite (`expo-sqlite`) queue + drafts; files kept in the app's document directory
  until the server acknowledges them. Every item carries `idempotencyKey`, `companyId`,
  `membershipId`; it only runs for that signed-in membership, retries with backoff, wakes on
  reconnect, pauses on 401 until the same membership signs in, survives restarts, and is cleared on
  sign-out. Statuses: Saved on phone · Waiting to upload · Uploading · Received by TMS · Upload
  failed.
- `src/lib` — business clock (US Eastern from the server's `Date` header; stop times in the stop's
  zone with Eastern beside), PDF builder (a multi-page scan is sent as ONE PDF), scan pipeline, push.

## Builds (EAS)

`eas.json` has three profiles: `development` (dev client, internal), `preview` (internal
distribution, channel `preview`) and `production` (store build, channel `production`, auto-increment).
The preview/production API hosts in `eas.json` are placeholders — set them before building.

```bash
npm install -g eas-cli          # or npx eas-cli@latest …
eas login                       # an Expo account (free) — owner decision which account
eas init                        # creates the EAS project and writes extra.eas.projectId into app.json
eas build --profile preview --platform android   # APK/AAB to install directly
eas build --profile preview --platform ios       # needs an Apple Developer account (ad-hoc devices)
eas build --profile production --platform all
eas submit --platform ios|android                # store upload — only with the owner's OK
```

**Bundle ids** `com.newaytms.app` (iOS `bundleIdentifier`, Android `package`) are placeholders in
`app.json`: the owner must confirm the final id before the first store build — it cannot change
afterwards. App icon/splash are still Expo's template images.

**Accounts the owner needs**

- Expo account (free) for EAS builds and push; CI uses an `EXPO_ACCESS_TOKEN`.
- Apple Developer Program (US$99/yr) for any iOS device build, TestFlight and the App Store; EAS can
  create the certificates and provisioning profiles with the account's credentials.
- Google Play Console (US$25 once) for Play Store distribution; internal APKs need nothing.

## Push notifications

The app registers its Expo push token with `POST /mobile/devices` after sign-in (real devices only)
and revokes it with `POST /mobile/devices/:id/revoke` on sign-out. It needs `extra.eas.projectId`
in `app.json` (written by `eas init`); without it registration quietly does nothing. The server
sends with the Expo push service; for iOS, EAS uploads the APNs key from the Apple account, for
Android an FCM v1 service-account key is added with `eas credentials`. A push carries only
`{type, id}`; tapping opens the record, fetched with the current session.

Taps are handled in `src/lib/push.ts` (`usePushRouting`, mounted in the root layout once someone
is signed in): while the app runs (foreground or background, via the response listener) and when
the tap launched it (`getLastNotificationResponseAsync`). `src/lib/deep-link.ts` maps every
`DEEP_LINK_TYPES` value to a screen per shell (tested); the screen reads the record with the
session, so a 403 shows "No access" and a 404 "Not found". The device id is kept on the phone so
sign-out revokes it even after a restart (the server also revokes the session's devices).

## Screens and their routes (M5a)

| Screen | Route(s) |
|---|---|
| Driver Money | `GET /driver/settlements?week=`, `/:id`, `/:id/pdf` (downloaded with the session; share sheet on a phone) |
| Driver Inbox / thread / new message | `/driver/conversations*`, photos via `POST /driver/files` |
| Driver Care, referral, reimbursement | `POST /driver/care`, `/driver/referrals`, `/driver/reimbursements` |
| Report a problem | `POST /driver/breakdowns` (GPS via expo-location with capture time, or typed) or `/driver/safety-reports` |
| My requests + detail | the six `GET /driver/*` lists (breakdowns, reimbursements, care, vacations, safety reports, referrals) |
| PTI / Vacation / Documents | `/driver/pti*`, `/driver/vacations*`, `/driver/documents` |
| Office Today / Dispatch / Approvals / My work | `/office/today?role=`, `/office/dispatch`, `/office/approvals` (decision routes it names), `/office/my-work`, `/hr/pto/me` |
| Office load, team inbox | `GET /loads/:id`, `POST /loads/:id/status` (only with `loads.edit`), `/conversations*` |
| Safety / Fleet / Accounting / Recruiting / Owner | `/fleet/pti/*`, `/fleet/breakdowns*`, `/accounting/billing/*`, `/accounting/reimbursements*`, `/accounting/settlements`, `/hiring/my-leads`, `/hiring/leads/:id/notes`, `/office/today?role=owner&period=` |

Every driver write goes through the offline queue (`kind` per record, one `driver-post` sender:
files to `POST /driver/files` with derived keys, then the route with the item's Idempotency-Key).
Office writes call the existing routes directly; a rejection or correction always asks for a reason.

**Web build against the staging API:** the API has no CORS allowance, so put a small proxy in
front (`:5200` → `/api/*` to `:3200`, the rest to Metro on `:8081`) and start Metro with
`EXPO_PUBLIC_API_URL=/api/v1`. Metro maps the shared package's `.js` import specifiers to its `.ts`
sources (`metro.config.js`).

## M6: look and feel (owner, 2026-10-28)

- **Theme**: Porcelain tokens in `src/ui/tokens.ts` (teal accent, light + dark palettes, Manrope via
  `@expo-google-fonts/manrope`). `src/ui/theme.tsx` follows the person's Light / Dark / System
  (`users.appearance`, `PATCH /auth/me/preferences`) and redraws the tree below the session.
- **Intro + login**: `features/brand.tsx` (road drawn in, truck, wordmark; react-native-svg + Animated),
  `app/login.tsx` ("Welcome back", Keep me signed in: unticked keeps the token in memory only).
- **Face ID / fingerprint**: `auth/biometric.ts` (expo-local-authentication, lazy), `features/biometric-sheet.tsx`
  (lock at start + glyph). Off by default; offered once after a password sign-in; Settings toggles it;
  sign-out turns it off. The password is never stored. In **Expo Go on iOS** Face ID is not allowed and the
  phone asks for the passcode; Android Expo Go uses the fingerprint / face unlock the phone has.
- **Driver Home**: `features/driver/home.tsx` (stacked load cards, quick actions, Ask NeWay row, rows) and the
  floating dock in `ui/tab-bar.tsx` (`DockSpaceContext` gives pages their bottom room).
- **Ask NeWay**: `app/driver/assistant.tsx`, `features/assistant/orb.tsx`, `lib/voice.ts` (expo-speech reads
  answers; expo-audio records; server transcription only with an Azure Speech account).
- **Settings**: `app/settings/*`, `features/settings.tsx` (staged changes, floating "N changes · Discard · Save").
- `app/dev-lock.tsx` draws the lock without asking the phone, development builds only (web screenshots).

## M7: owner's requests of 2026-10-28

- **Login**: no road/truck and no intro before it (`app/index.tsx` goes straight to login, the Face ID lock,
  or the shell). `features/brand.tsx` draws the large NeWay wordmark in the accent gradient (teal → violet,
  `mixColor` between two tokens), each letter bouncing in turn (Animated, native driver, still with reduced
  motion), tagline "Trucking, on time. Every mile." A language chip sits top right.
- **Languages**: `src/i18n` — `core.ts` (`t('English text', vars)`, `tn(count, one, many)`; no React Native
  imports, so the queue and its tests can use it), `index.tsx` (`LanguageProvider`, kept on the phone in the
  drafts table, applies at once), `dict/*.ts` (one fragment per area: English → uz Latin, ru, es, tr, kk).
  English is the source and the fallback. `node scripts/i18n-check.mjs` lists anything untranslated and any
  placeholder that a translation lost. Dates and money keep the US formats.
- **Appearance and language apply in one tap** (no Save bar; the bar is only for Face ID and alerts). The
  redraw remounts the navigators, so `lib/keep-place.tsx` remembers the navigation state just before and
  restores it after: the person stays on the page they were on.
- **Dock**: frosted glass — expo-blur under a part-strength ink on iOS and the web; Android draws the
  see-through ink (`dockFrost`) without a blur (a real Android blur needs a blur target around the page,
  which the tab bar cannot have).
- **Document photos** (`ui/media.tsx` `DocumentPhotoCard`): a large card with Take photo / Gallery, then the
  picture with "Ready to send", Retake, Remove. Android offers its crop step after the photo.
- **Scan**: `lib/doc-scanner.ts` uses `react-native-document-scanner-plugin` (ML Kit on Android, VisionKit
  on iOS: edge detection, perspective crop, several pages) and the scan screen opens it at once. It is
  native code: it works in a development / store build (EAS), **not in Expo Go**. In Expo Go the screen's own
  camera shows a letter-size page frame and crops each photo to it ("Keep the whole photo" undoes the crop).
  Document types: BOL, POD, Lumper receipt, TONU, Layover, Detention, Other (the API accepts the same set).
- Net pay is labelled "after deductions" and sits right, one line; the message composer sits above the
  gesture bar and rises with the keyboard (`Footer` in `ui/layout.tsx` measures the overlap); the Ask NeWay
  send button is a 44 px round icon.
- **Staging TEST loads**: `infra/staging/seed-driver-test-loads.mjs` (re-runnable, staging and TEST
  companies only, never deletes) gives the TEST driver one active and one upcoming load.
- The grey gear floating over every screen in Expo Go is Expo Go's own developer-menu button, not the app's
  (it is not in a development or store build; Expo Go can hide it in its settings).
