import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * Loads the nearest `.env` file (current directory or up to three parents) into
 * `process.env`. Variables already present in the environment take precedence.
 */
function loadDotEnv(): void {
  let dir = process.cwd();
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /**
   * Connections in the API's pool. 10 everywhere; 1 only for the hackathon demo's PGlite fallback
   * (scripts/hackathon/pglite-server.mjs), which runs one query at a time.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().min(1).default('./storage'),
  /**
   * How many reverse proxies sit in front of the API and append to `X-Forwarded-For`.
   *
   * 0 (the default) trusts no header: the client address is the socket peer, which behind a proxy
   * is the proxy itself. The public application form rate-limits per client address, so behind a
   * proxy this must be the real number of hops or every visitor shares one limit. Production runs
   * behind the host's TLS proxy and the web container's nginx: 2.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /**
   * The proxies to trust by address (comma-separated IPs or CIDRs), instead of a hop count. Wins
   * over TRUST_PROXY_HOPS when set. Production has two front doors - neway.example.com (Caddy, then
   * nginx) and :8080 (nginx only) - so no single hop count is right for both; trusting only the
   * private docker addresses gives the real client either way and never a header a client wrote.
   */
  TRUST_PROXY_ADDRESSES: z.string().trim().optional(),
  /**
   * Honour the `X-Account` / `X-Demo-Role` impersonation headers.
   *
   * These pick an acting account with no credential, which is a development convenience and a
   * complete authentication bypass. Off unless explicitly enabled, and refused outright in
   * production (see the check below), so no deployment can be talked into it by an env var.
   */
  AUTH_DEV_HEADERS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Fill an empty database with the demo fleet, workforce, qualification file and hiring funnel
   * at boot.
   *
   * Development and the tests want it. Production must not have it: a workspace that has been
   * emptied on purpose would otherwise refill itself with demo data at the next restart, and the
   * seeds only check whether their tables are empty. Unset, it is on outside production and off
   * in it; set it explicitly to override either way.
   */
  SEED_DEMO_DATA: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  /**
   * The Fleet upgrade's new endpoints: the Today board, the unit picker and the work orders
   * behind them.
   *
   * The browser has had a `fleet_v2` flag since the work started, but hiding a page leaves its
   * endpoints answering a direct request, so the flag exists here too and this is the copy that
   * decides whether the feature is reachable. Unset, it is on outside production and off in it -
   * the same shape as the seeds above - so a deploy never carries a half-reviewed feature in
   * front of the shop without somebody turning it on.
   */
  FLEET_V2: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  /** The Oil change / PM module (docs/pm-module). Same shape as FLEET_V2: on outside production. */
  PM_MODULE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  /** Safety v2 (docs/safety/SAFETY-V2.md): server-side cases. Same shape: on outside production. */
  SAFETY_V2: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  /**
   * Accident & Claims v2 (docs/accidents). Unlike the flags above it is OFF everywhere unless set to
   * 'true' (owner, 2026-10-21: each phase ships with the flag off; the owner turns it on).
   */
  ACCIDENTS_V2: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  /**
   * How often every connected integration account is synced, unattended. 0 turns it off; the
   * screen's "Sync now" still works. Read-only against the provider either way.
   */
  /**
   * Email for statements and invoices. `smtp` needs SMTP_URL (smtps://user:pass@host:465) and
   * SMTP_FROM; `file` writes each message as .eml under STORAGE_LOCAL_PATH/outbox (QA only);
   * unset = no transport, deliveries are queued and say so.
   */
  EMAIL_TRANSPORT: z.enum(['resend', 'smtp', 'graph', 'file']).optional(),
  /**
   * Resend (owner brief 2026-10-27): the API key. Set = every email goes through Resend unless
   * EMAIL_TRANSPORT names another transport. Never logged, never sent to the browser.
   */
  RESEND_EMAIL_API: z.string().min(1).optional(),
  /** The signing secret of the Resend webhook (whsec_…), for delivered / bounced / complained. */
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** The verified sending domain; senders are recruiting@ / accounting@ this domain. */
  EMAIL_FROM_DOMAIN: z.string().min(3).default('mail.neway.example.com'),
  SMTP_URL: z.string().min(1).optional(),
  SMTP_FROM: z.string().min(1).optional(),
  /**
   * Microsoft 365 through Microsoft Graph (EMAIL_TRANSPORT=graph): an Entra app registration with the
   * Mail.Send application permission (limit it to the sending mailbox with an application access
   * policy). SMTP_FROM is the mailbox it sends as. Server secrets only.
   */
  GRAPH_TENANT_ID: z.string().min(1).optional(),
  GRAPH_CLIENT_ID: z.string().min(1).optional(),
  GRAPH_CLIENT_SECRET: z.string().min(1).optional(),
  GRAPH_API_BASE: z.string().url().default('https://graph.microsoft.com'),
  GRAPH_LOGIN_BASE: z.string().url().default('https://login.microsoftonline.com'),
  /**
   * Twilio's API root. Production leaves the default; the e2e suite points it at a local stand-in
   * so the real client code runs without sending a text. Credentials live per company in
   * Integrations (encrypted), never here.
   */
  TWILIO_API_BASE: z.string().url().default('https://api.twilio.com'),
  TWILIO_MESSAGING_API_BASE: z.string().url().default('https://messaging.twilio.com'),
  /**
   * The rate confirmation reader (Add load → upload RC → the form fills itself) sends the RC to
   * Claude. Unset = the reader says it is not set up; nothing else changes.
   */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  RC_READER_MODEL: z.string().min(1).default('claude-opus-5'),
  /** The model the owner set (2026-10-17, e.g. claude-haiku-4-5-20251001); wins over RC_READER_MODEL. */
  ANTHROPIC_MODEL: z.string().min(1).optional(),
  /** NeWay AI (2026-10-20): which models the selector offers (comma list; empty = all known) and the monthly cap in USD. */
  AI_MODELS: z.string().optional(),
  AI_MONTHLY_CAP_USD: z.coerce.number().positive().optional(),
  /**
   * Meta Model API key (Muse, 2026-11-03). Set = Muse Spark is NeWay AI's default model, Claude the
   * fallback. The driver app's voice questions are turned into words by muse-voice-transcribe-1.0
   * (POST {META_API_BASE}/asr/transcribe, WAV only).
   */
  META_API_KEY: z.string().min(1).optional(),
  META_API_BASE: z.string().url().default('https://api.meta.ai/v1'),
  META_TRANSCRIBE_MODEL: z.string().min(1).default('muse-voice-transcribe-1.0'),
  /**
   * NeWay AI Morning brief, scheduled (hackathon A2, 2026-11-03): the US Eastern hours at which
   * the brief is rebuilt for everyone who ran it, comma list (e.g. "6,10,14,18"). Unset = off;
   * "Run now" on the page works either way.
   */
  AI_BRIEF_CRON: z.string().trim().optional(),
  /** Where the server finds us-places.json (stop coordinates); default: beside the web app in the repo. */
  US_PLACES_PATH: z.string().trim().optional(),
  /**
   * Who reads an RC no template knows: claude (fast; the default once a key is set) or local
   * (Ollama). Either way the other one is the fallback when the first cannot answer.
   */
  RC_READER_PREFER: z.enum(['claude', 'local']).default('claude'),
  /** The local reader: Ollama on our own server (e.g. http://ollama:11434). Tried before Claude. */
  OLLAMA_URL: z.string().url().optional(),
  RC_READER_OLLAMA_MODEL: z.string().min(1).default('qwen2.5:3b'),
  /**
   * v2 (2026-10-02): the fine-tuned `neway-rc-v2` - short prompt, compact answer, and scans read by
   * OCR (poppler + tesseract in the api image). v1 is the earlier long-prompt reader. Switching back
   * is this one setting.
   */
  RC_READER_VERSION: z.enum(['v1', 'v2']).default('v1'),
  /** Our own MC / DOT, comma-separated: printed in every RC's carrier block, never the broker's. */
  RC_CARRIER_NUMBERS: z.string().optional(),
  /**
   * Meta Muse vision (hackathon, 2026-11-03): reads a CDL photo and an RC through
   * `muse-spark-1.3` with META_API_KEY above. Unset key = "Read with Muse" says it is not set up
   * and the RC reader keeps its existing order.
   */
  META_API_BASE_URL: z.string().url().default('https://api.meta.ai/v1'),
  MUSE_VISION_MODEL: z.string().min(1).default('muse-spark-1.3'),
  MUSE_VISION_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** `muse` puts Muse first for RCs no template knows; the other readers stay the fallback. */
  RC_READER_PROVIDER: z.enum(['default', 'muse']).default('default'),
  /**
   * Route options after Create load (owner, 2026-10-27): TollGuru prices up to three roads -
   * tolls and fuel - and the dispatcher picks one. Unset = the panel says TollGuru is not set up;
   * the load is booked as always. A secret: server environment only, never the browser or git.
   */
  TOLLGURU_API_KEY: z.string().trim().min(1).optional(),
  /**
   * The companies whose drivers may be given the driver app (owner, 2026-10-28: on trial, the TEST
   * company only - nothing reaches a real company). Comma-separated company ids; unset = every
   * company (development, staging, tests).
   */
  DRIVER_APP_COMPANIES: z.string().trim().min(1).optional(),
  /** TollGuru's address; tests point it at a local stand-in. */
  TOLLGURU_API_BASE: z.string().url().default('https://apis.tollguru.com'),
  INTEGRATION_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1440).default(60),
  /** Live-map positions from Samsara, between full syncs (0 turns it off). */
  SAMSARA_POSITIONS_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1440).default(5),
  /**
   * Driver Relations → Telegram (owner, 2026-10-06): one management group, one bot, not set up
   * yet. Off unless DR_TELEGRAM_ENABLED=true AND both the token and the chat id are present; while
   * off, nothing is sent and the outbox rows stay pending. The token is a secret: environment
   * only, never in git, the browser, a log line or a screenshot.
   */
  DR_TELEGRAM_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  TELEGRAM_DR_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_DR_CHAT_ID: z.string().min(1).optional(),
  /** The TMS address a notification links to (an authenticated page, never public data). */
  DR_TMS_BASE_URL: z.string().url().default('https://neway.example.com'),
  /** The public address of the web app, used to build links sent to drivers (/dot/<token>). */
  PUBLIC_APP_BASE_URL: z.string().url().default('https://neway.example.com'),
  /**
   * Public link pages (the DOT application, /dot/<token>) answer only requests that arrived over
   * HTTPS, judged by X-Forwarded-Proto from the trusted proxies (TRUST_PROXY_*). Unset: on in
   * production, off in development and tests.
   */
  PUBLIC_LINKS_REQUIRE_HTTPS: z.enum(['true', 'false']).optional(),
  /**
   * New online leads posted to the recruiting group (owner, 2026-10-07). Both must be set, in the
   * server's .env only — never in git or the browser. Missing either: nothing is sent.
   */
  HIRING_TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  HIRING_TELEGRAM_CHAT_ID: z.string().min(1).optional(),
  /** The company whose no-answer leads get follow-up reminders in that group (owner, 2026-10-23). */
  HIRING_TELEGRAM_COMPANY_ID: z.string().min(1).optional(),
  /**
   * The external driver application intake adapter (owner, 2026-10-08). Off unless both are set:
   * the companies whose candidates may be received through it (comma-separated ids), and the
   * browser origins allowed to call it (comma-separated; a server-to-server caller sends none).
   * A shared secret, when set, must arrive as `x-intake-secret` (server-to-server callers only).
   */
  EXTERNAL_APPLICATION_COMPANIES: z.string().optional(),
  EXTERNAL_APPLICATION_ORIGINS: z.string().optional(),
  EXTERNAL_APPLICATION_SECRET: z.string().min(16).optional(),
  /** The base address of the external application page the candidate link points at. */
  EXTERNAL_APPLICATION_BASE_URL: z.string().url().optional(),
  /**
   * The personal driver application (owner, 2026-10-08). Where "Send application" links point;
   * the token goes after `#token=`. Unset: the page the TMS itself serves, PUBLIC_APP_BASE_URL +
   * /application/. Point it elsewhere only once that host forwards submissions to the TMS
   * (see docs/hiring/driver-application-integration.md).
   */
  DRIVER_APPLICATION_LINK_BASE_URL: z.string().url().optional(),
  /** Extra browser origins allowed to post /api/applications (comma-separated); the TMS's own is always allowed. */
  DRIVER_APPLICATION_ORIGINS: z.string().optional(),
});

export type Env = Omit<z.infer<typeof EnvSchema>, 'SEED_DEMO_DATA' | 'FLEET_V2' | 'PM_MODULE' | 'SAFETY_V2'> & {
  SEED_DEMO_DATA: boolean;
  FLEET_V2: boolean;
  PM_MODULE: boolean;
  SAFETY_V2: boolean;
};

/** Parses and validates the environment. Exits the process on invalid configuration. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  loadDotEnv();
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    console.error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
    process.exit(1);
  }
  if (result.data.NODE_ENV === 'production' && result.data.AUTH_DEV_HEADERS) {
    console.error('AUTH_DEV_HEADERS cannot be enabled in production: it bypasses authentication.');
    process.exit(1);
  }
  return {
    ...result.data,
    SEED_DEMO_DATA: result.data.SEED_DEMO_DATA ?? result.data.NODE_ENV !== 'production',
    FLEET_V2: result.data.FLEET_V2 ?? result.data.NODE_ENV !== 'production',
    PM_MODULE: result.data.PM_MODULE ?? result.data.NODE_ENV !== 'production',
    SAFETY_V2: result.data.SAFETY_V2 ?? result.data.NODE_ENV !== 'production',
  };
}

export const env: Env = loadEnv();
