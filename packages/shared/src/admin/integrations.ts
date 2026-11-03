import { z } from 'zod';

/**
 * Integrations.
 *
 * This module stores credentials for external systems, records what has been configured, and —
 * for the providers whose `connector.implemented` is true — syncs with them. Today that is
 * Samsara, Motive and Five ELD: vehicles, odometers and positions are read into the truck roster. Every other provider stores a
 * credential and nothing more, and says so.
 *
 * A carrier may hold **several accounts with the same provider**. Two Samsara organisations under
 * one company are two rows, each with its own token, its own status, its own last sync and its
 * own errors, and a truck remembers which of them it came from. There is no "the Samsara account".
 *
 * `connected` means exactly one thing: the provider answered a request made with the stored
 * credential. It is set by that request and by nothing else — never by storing a key, which only
 * earns `credentials_stored`, a claim about this database rather than about the provider.
 */

export const INTEGRATION_CATEGORIES = [
  'eld',
  'fuel',
  'accounting',
  'load_board',
  'mapping',
  'communication',
  'ai',
] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

export const INTEGRATION_CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  eld: 'ELD & telematics',
  fuel: 'Fuel cards',
  accounting: 'Accounting',
  load_board: 'Load boards',
  mapping: 'Mapping & routing',
  communication: 'Communication',
  ai: 'AI & voice',
};

/**
 * Statuses an account can hold.
 *
 * `connected` is earned, not assumed: the provider has answered a request made with the stored
 * credential. `error` is the provider refusing one. Storing a key earns only `credentials_stored`.
 *
 * `archived` is an account with no credential that nobody wants to see any more: hidden from the
 * list, never synced, kept on record and reversible (Unarchive puts it back to `not_configured`).
 */
export const INTEGRATION_STATUSES = [
  'not_configured',
  'credentials_stored',
  'connected',
  'disabled',
  'error',
  'archived',
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const INTEGRATION_STATUS_LABELS: Record<IntegrationStatus, string> = {
  not_configured: 'Not configured',
  credentials_stored: 'Credentials stored',
  connected: 'Connected',
  disabled: 'Disabled',
  error: 'Error',
  archived: 'Archived',
};

export interface CredentialField {
  name: string;
  label: string;
  /** `secret` fields are write-only: stored encrypted at rest, never returned by any endpoint. */
  kind: 'secret' | 'text';
  help?: string;
  /** May be left blank; the connector then uses the default its help text names. */
  optional?: boolean;
}

export interface IntegrationProvider {
  provider: string;
  name: string;
  category: IntegrationCategory;
  description: string;
  /** What this integration would do for the carrier once a connector exists. */
  wouldSync: string[];
  credentialFields: CredentialField[];
  connector: {
    implemented: boolean;
    /** Present when `implemented` is false: exactly what is missing. */
    reason?: string;
  };
}

const NO_CONNECTOR = (what: string) => ({
  implemented: false,
  reason: `No ${what} client is implemented in this system. Credentials can be stored now, but nothing reads or writes ${what} data until a connector is built.`,
});

/**
 * The providers this carrier actually uses or is likely to.
 *
 * `telematics_provider` on the truck record already names Samsara and Motive, which is why those
 * two head the list — the fleet is on them today, and the data currently arrives by hand.
 */
export const INTEGRATION_PROVIDERS: IntegrationProvider[] = [
  {
    provider: 'samsara',
    name: 'Samsara',
    category: 'eld',
    description: 'ELD, GPS and vehicle diagnostics.',
    /** What the connector reads today. Read-only: nothing is ever written to Samsara. */
    wouldSync: ['Vehicles', 'Odometer and engine hours', 'Vehicle location'],
    credentialFields: [
      { name: 'apiToken', label: 'API token', kind: 'secret', help: 'Samsara dashboard → Settings → API tokens. Read scope on vehicles and vehicle stats is enough.' },
    ],
    connector: { implemented: true },
  },
  {
    provider: 'motive',
    name: 'Motive',
    category: 'eld',
    description: 'ELD, GPS and vehicle diagnostics.',
    /**
     * What the connector reads today, the same as Samsara. Read-only: nothing is ever written to
     * Motive. Hours of service, driver logs and safety events have no place in the product yet.
     */
    wouldSync: ['Vehicles', 'Odometer and engine hours', 'Vehicle location'],
    credentialFields: [
      { name: 'apiKey', label: 'API key', kind: 'secret', help: 'Motive dashboard → Admin → API keys (Fleet Admin). Read access to vehicles and vehicle locations is enough.' },
    ],
    connector: { implemented: true },
  },
  {
    provider: 'fiveeld',
    name: 'Five ELD',
    category: 'eld',
    description: 'ELD and GPS tracking (fiveeld.com).',
    /**
     * What the connector reads today. Read-only: nothing is ever written to Five ELD. Its read
     * API carries a GPS fix, speed, heading, address and odometer per tracking point, and no
     * engine hours — so engine hours are never written from it.
     */
    wouldSync: ['Vehicles', 'Odometer', 'Vehicle location'],
    credentialFields: [
      { name: 'apiKey', label: 'API key', kind: 'secret', help: 'Five ELD dashboard (main company account) → More → API Keys → Add Key.' },
      { name: 'providerToken', label: 'Provider token', kind: 'secret', help: 'Issued by Five ELD support, not the dashboard: email them the company name, USDOT and what the integration does.' },
      { name: 'usdot', label: 'USDOT number', kind: 'text', help: 'The company USDOT as Five ELD knows it. It goes in the request path; it is not a secret.' },
    ],
    connector: { implemented: true },
  },
  {
    provider: 'comdata',
    name: 'Comdata',
    category: 'fuel',
    description: 'Fuel card transactions.',
    wouldSync: ['Fuel purchases', 'Card limits', 'Driver card assignments'],
    credentialFields: [
      { name: 'accountCode', label: 'Account code', kind: 'text' },
      { name: 'apiSecret', label: 'API secret', kind: 'secret' },
    ],
    connector: NO_CONNECTOR('Comdata'),
  },
  {
    provider: 'efs',
    name: 'EFS',
    category: 'fuel',
    description: 'Fuel card transactions and money codes.',
    wouldSync: ['Fuel purchases', 'Cash advances'],
    credentialFields: [{ name: 'apiKey', label: 'API key', kind: 'secret' }],
    connector: NO_CONNECTOR('EFS'),
  },
  {
    provider: 'relay',
    name: 'Relay',
    category: 'fuel',
    description: 'Fuel bought with Relay codes and cards.',
    /** Read-only. Diesel and DEF land as separate rows so DEF never inflates an MPG figure. */
    wouldSync: ['Diesel fill-ups', 'DEF purchases', 'Station, truck and driver for each fill'],
    credentialFields: [
      {
        name: 'apiKey',
        label: 'API key',
        kind: 'secret',
        help: 'Relay → Integrations → API key (starts with iak_). The production key works only against app.relaypayments.com.',
      },
    ],
    connector: { implemented: true },
  },
  {
    provider: 'quickbooks',
    name: 'QuickBooks Online',
    category: 'accounting',
    description: 'General ledger, invoices and bills.',
    wouldSync: ['Invoices', 'Payments received', 'Vendor bills', 'Chart of accounts'],
    credentialFields: [
      { name: 'realmId', label: 'Company (realm) ID', kind: 'text' },
      { name: 'clientSecret', label: 'Client secret', kind: 'secret' },
      { name: 'refreshToken', label: 'Refresh token', kind: 'secret' },
    ],
    connector: NO_CONNECTOR('QuickBooks'),
  },
  {
    provider: 'rts',
    name: 'RTS Financial (FTPS)',
    category: 'accounting',
    description: 'Factoring: invoices sent to RTS as one PDF per invoice plus a CSV, over FTPS. One way - RTS sends nothing back.',
    // Writes only: Accounting's RTS batches upload through it. "Test" logs in and lists the folder.
    wouldSync: ['Invoice packets (one PDF per invoice)', 'The submission CSV'],
    credentialFields: [
      { name: 'clientNumber', label: 'Client number (FTP username)', kind: 'text', help: 'The username RTS gave for the FTP folder; it is also the Client column of the CSV.' },
      { name: 'password', label: 'Password', kind: 'secret' },
      { name: 'host', label: 'Server', kind: 'text', help: 'ftps.financial.rtspro.com (FTPS, port 21). ftps.rtsfinancial.com works too: it is the same server, and its certificate is checked against ftps.financial.rtspro.com, the only name the certificate carries.' },
      { name: 'environment', label: 'Environment', kind: 'text', help: 'test or production. A test account uploads to the RTS test folder and marks nothing submitted.' },
    ],
    connector: { implemented: true },
  },
  {
    provider: 'dat',
    name: 'DAT',
    category: 'load_board',
    description: 'Load board search and posting.',
    wouldSync: ['Available loads', 'Posted trucks', 'Rate benchmarks'],
    credentialFields: [
      { name: 'username', label: 'Username', kind: 'text' },
      { name: 'password', label: 'Password', kind: 'secret' },
    ],
    connector: NO_CONNECTOR('DAT'),
  },
  {
    provider: 'truckstop',
    name: 'Truckstop',
    category: 'load_board',
    description: 'Load board search and posting.',
    wouldSync: ['Available loads', 'Posted trucks'],
    credentialFields: [{ name: 'apiKey', label: 'API key', kind: 'secret' }],
    connector: NO_CONNECTOR('Truckstop'),
  },
  {
    provider: 'google_maps',
    name: 'Google Maps Platform',
    category: 'mapping',
    description: 'Geocoding and distance.',
    wouldSync: ['Stop geocoding', 'Route distance and duration'],
    credentialFields: [{ name: 'apiKey', label: 'API key', kind: 'secret' }],
    connector: NO_CONNECTOR('Google Maps'),
  },
  {
    provider: 'twilio',
    name: 'Twilio',
    category: 'communication',
    description: 'SMS to drivers: the recruiting consent and application links, with delivery receipts.',
    wouldSync: ['Outbound SMS', 'Delivery receipts'],
    credentialFields: [
      { name: 'accountSid', label: 'Account SID', kind: 'text', help: 'Twilio Console → Account info (starts with AC).' },
      { name: 'authToken', label: 'Auth token', kind: 'secret' },
      {
        name: 'fromNumber',
        label: 'Sender',
        kind: 'text',
        help: 'The Twilio phone number in +1… form, or a Messaging Service SID (starts with MG). US numbers need an approved A2P 10DLC campaign.',
      },
    ],
    // Sends only; there is nothing to sync. "Test" reads the account to prove the credential.
    connector: { implemented: true },
  },
  {
    provider: 'azure_speech',
    name: 'Azure Speech (voice)',
    category: 'ai',
    description: 'Microsoft Azure text-to-speech: NeWay AI reads answers aloud in Uzbek, Russian and English, whatever voices the computer has.',
    wouldSync: ['Read aloud for NeWay AI answers'],
    credentialFields: [
      { name: 'key', label: 'Speech key', kind: 'secret', help: 'Azure portal → your Speech resource → Keys and Endpoint → KEY 1.' },
      { name: 'region', label: 'Region', kind: 'text', help: 'The Speech resource location as Azure spells it, e.g. eastus or westeurope.' },
      {
        name: 'voiceUz',
        label: 'Uzbek voice',
        kind: 'text',
        optional: true,
        help: 'Leave blank for uz-UZ-SardorNeural (male). uz-UZ-MadinaNeural is the female voice.',
      },
    ],
    // Speaks only; there is nothing to sync. "Test" lists the region's voices and looks for Uzbek.
    connector: { implemented: true },
  },
];

export function integrationProvider(provider: string): IntegrationProvider | undefined {
  return INTEGRATION_PROVIDERS.find((p) => p.provider === provider);
}

/** True while nothing in the registry can actually talk to its provider. */
export const ANY_CONNECTOR_IMPLEMENTED = INTEGRATION_PROVIDERS.some(
  (p) => p.connector.implemented,
);

/** What one sync did, kept on the run and shown on the account. Counts only; never a secret. */
export const SyncSummarySchema = z.object({
  fetched: z.number().int(),
  matched: z.number().int(),
  updated: z.number().int(),
  created: z.number().int(),
  unchanged: z.number().int(),
  inactive: z.number().int(),
  duplicates: z.number().int(),
  unmatched: z.number().int(),
  conflicts: z.number().int(),
});
export type SyncSummary = z.infer<typeof SyncSummarySchema>;

export const IntegrationAccountSchema = z.object({
  id: z.string(),
  provider: z.string(),
  /** The administrator's own name for this account: "Samsara — Chicago yard". */
  name: z.string(),
  category: z.enum(INTEGRATION_CATEGORIES),
  status: z.enum(INTEGRATION_STATUSES),
  /** Never the credential. The last four characters, so an administrator can tell keys apart. */
  credentialHint: z.string().nullable(),
  credentialUpdatedAt: z.string().nullable(),
  /** Non-secret configuration only. Secret fields are stripped before this is built. */
  config: z.record(z.string(), z.string()),
  /** What the provider calls the organisation behind the token, once it has answered. */
  externalName: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastSummary: SyncSummarySchema.nullable(),
  errorCount: z.number(),
  createdAt: z.string(),
});
export type IntegrationAccount = z.infer<typeof IntegrationAccountSchema>;

/** Adds an account. Always a new row: a second Samsara is a second account, not a replaced key. */
export const ConnectIntegrationSchema = z.object({
  provider: z.string().min(1),
  name: z.string().trim().min(1).max(80).optional(),
  /** Field name → value. Secret fields go to encrypted storage and are never read back. */
  credentials: z.record(z.string(), z.string().min(1, 'Required')),
});

/** Replaces the credential on one account. The only edit a secret has. */
export const ReplaceCredentialSchema = z.object({
  credentials: z.record(z.string(), z.string().min(1, 'Required')),
});

export const RenameIntegrationSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const SetIntegrationStatusSchema = z.object({
  status: z.enum(['credentials_stored', 'disabled']),
});

/** Archives an account that holds no credential. The reason is optional and goes to the audit log. */
export const ArchiveIntegrationSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type ArchiveIntegrationRequest = z.infer<typeof ArchiveIntegrationSchema>;

// -------------------------------------------------------------------------------------- sync

/**
 * What one run may do.
 *
 * `dryRun` answers "what would change" and changes nothing; the screen calls it a preview and
 * shows it before anyone applies. `createMissing` is off by default: a vehicle Samsara knows and
 * the roster does not is listed, not invented, until somebody says so for that run.
 */
export const SyncRequestSchema = z.object({
  dryRun: z.boolean().default(false),
  createMissing: z.boolean().default(false),
});
export type SyncRequest = z.infer<typeof SyncRequestSchema>;

/** The connector's default for "this vehicle is no longer running": no reading for this long. */
export const SYNC_INACTIVE_AFTER_DAYS = 30;

/** How far below our odometer a provider reading may be before it is a conflict, not noise. */
export const SYNC_ODOMETER_ROLLBACK_TOLERANCE_MILES = 50;

export const SyncVehicleLineSchema = z.object({
  /** The provider's id for the vehicle. */
  externalId: z.string(),
  /** The unit number as the provider spells it. */
  name: z.string(),
  vin: z.string().nullable(),
  /** Our truck, when one matched. */
  truckId: z.string().nullable(),
  unitNumber: z.string().nullable(),
  odometerBefore: z.number().int().nullable(),
  odometerAfter: z.number().int().nullable(),
  /** When the provider last heard from the vehicle. */
  lastSeenAt: z.string().nullable(),
  /** Why it landed in its bucket, in words. */
  note: z.string(),
});
export type SyncVehicleLine = z.infer<typeof SyncVehicleLineSchema>;

export const SyncReportSchema = z.object({
  accountId: z.string(),
  provider: z.string(),
  dryRun: z.boolean(),
  startedAt: z.string(),
  durationMs: z.number().int(),
  summary: SyncSummarySchema,
  updated: z.array(SyncVehicleLineSchema),
  created: z.array(SyncVehicleLineSchema),
  unchanged: z.array(SyncVehicleLineSchema),
  /** No reading in the inactive window: skipped, and never turned into a truck. */
  inactive: z.array(SyncVehicleLineSchema),
  /** The same unit number more than once in the provider; the newest reading won. */
  duplicates: z.array(SyncVehicleLineSchema),
  /** Active in the provider, unknown to the roster, and not created on this run. */
  unmatched: z.array(SyncVehicleLineSchema),
  /** The provider's reading is below ours by more than the tolerance: not applied. */
  conflicts: z.array(SyncVehicleLineSchema),
});
export type SyncReport = z.infer<typeof SyncReportSchema>;

export const SyncRunSchema = z.object({
  id: z.string(),
  direction: z.string(),
  entity: z.string(),
  status: z.string(),
  records: z.number().int(),
  durationMs: z.number().int().nullable(),
  error: z.string().nullable(),
  summary: SyncSummarySchema.nullable(),
  startedAt: z.string(),
});
export type SyncRun = z.infer<typeof SyncRunSchema>;

/** Masks a credential for display. Never call this on the server's way *out* of storage. */
export function credentialHint(value: string): string {
  const tail = value.trim().slice(-4);
  return tail.length === 4 ? `••••••••${tail}` : '••••••••';
}
