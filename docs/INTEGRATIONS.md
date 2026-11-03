# NEWAY TMS — Integration Architecture

External systems are reached only through provider interfaces. Business modules depend on the interface, never on a vendor. Every interface ships with a mock provider, so the platform runs and is testable with no external account.

Related: [ARCHITECTURE.md](../ARCHITECTURE.md) · [DATABASE.md](DATABASE.md) §3.16 · [MULTI_TENANCY.md](MULTI_TENANCY.md)

---

## 1. Structure

```
apps/api/src/adapters/
  telematics/   telematics.provider.ts (interface)  samsara/  motive/  geotab/  mock/
  fuel-cards/   fuel-card.provider.ts                wex/ efs/ relay/ mock/
  load-boards/  load-board.provider.ts               dat/ truckstop/ mock/
  maps/         maps.provider.ts                     osrm/ ors/ google/ mapbox/ mock/
  messaging/    messaging.provider.ts                email-smtp/ twilio/ telegram/ mock/
  accounting/   accounting.provider.ts               quickbooks/ mock/
  payments/     payments.provider.ts                 stripe/ mock/
  weather/      weather.provider.ts                  open-meteo/ mock/
  storage/      storage.provider.ts                  local/ s3/
  llm/          llm.provider.ts                      anthropic/ mock/
  registry.ts   maps (category, providerCode) → implementation; resolves an account's provider at runtime
```

The `integrations` module owns the data: `integration_accounts` (per company, per provider, several allowed), `sync_runs`, `webhook_events`, `external_refs`. The adapters own the wire protocol. Business modules (`tracking`, `fuel`, `safety`, …) own what to do with the data.

---

## 2. Provider interfaces

Contracts are TypeScript interfaces with zod-validated normalized types. Vendors are mapped into these shapes inside the adapter; nothing vendor-specific leaves the adapter.

```ts
interface TelematicsProvider {
  capabilities(): { positions; hos; safetyEvents; faults; dvir; geofences; webhooks };
  listVehicles(): Promise<ExternalVehicle[]>;
  listDrivers(): Promise<ExternalDriver[]>;
  getCurrentStats(vehicleIds): Promise<VehicleSnapshot[]>;          // position, speed, odometer, engine state, fuel level
  getStatsHistory(vehicleIds, since, until): Promise<VehicleSample[]>;
  getHosLogs(driverIds, since): Promise<HosLog[]>;
  getSafetyEvents(since): Promise<SafetyEventRecord[]>;
  getFaultCodes(vehicleIds): Promise<FaultCode[]>;
  createGeofence?(geofence): Promise<ExternalId>;
  verifyWebhook(headers, rawBody): boolean;
  parseWebhook(payload): NormalizedEvent[];
}

interface FuelCardProvider   { listCards(); getTransactions(since, cursor?); verifyWebhook(); parseWebhook(); issueCode?(); }
interface LoadBoardProvider  { searchLoads(criteria); postTruck(availability); getLaneRates(lane); }
interface MapsProvider       { geocode(address); reverseGeocode(lat,lng); route(waypoints, options); distanceMatrix(origins, dests); tolls?(route); tiles?(); }
interface MessagingProvider  { channel: 'email'|'sms'|'telegram'; send(message): Promise<DeliveryResult>; verifyWebhook?(); parseInbound?(); }
interface AccountingProvider { pushInvoice(); pushCreditMemo(); pushBill(); pushPayment(); pullCustomers(); pullVendors(); }
interface PaymentsProvider   { createCharge(); createPayout(); verifyWebhook(); parseWebhook(); }
interface WeatherProvider    { current(lat,lng); alertsAlongRoute(polyline); }
interface StorageProvider    { put(key, body, contentType); get(key); head(key); signedUrl(key, ttl, disposition); delete(key); }
interface LLMProvider        { complete(request); stream(request); countTokens(request); }
```

Every provider also implements `testConnection(): Promise<{ ok, detail }>` used by the "Test" button in Administration → Integrations.

---

## 3. Accounts, credentials, multi-instance

- `integration_accounts` rows are per company. A company may have **several accounts for the same provider** (two telematics organizations, two fuel card programs); sync jobs iterate accounts and merge results by unit number with explicit dedupe rules (most recent sample wins; units with no data for N days are ignored).
- Credentials are encrypted at rest (`credentials_enc`, AES-256-GCM with a rotatable master key from the environment) and never returned by the API after creation. Only `status`, `label`, non-secret config, `last_sync_at`, and `last_error` are readable.
- Platform-level credentials (a platform-wide maps key, LLM key) live in `platform_settings`, encrypted, and are used only when a company has no account of its own and the plan allows it. Usage is metered per company either way.
- Status is honest: `disconnected`, `connected`, `error` (with last error), or `mock`. The UI never shows a mock as connected.

---

## 4. Sync engine

- **Scheduled pulls** per account per kind (positions 1–5 min, HOS 15 min, safety events 30 min, fuel transactions 15 min, fault codes hourly) run on the worker and record a `sync_runs` row with cursor, counts, and errors.
- **Idempotent upserts** keyed by `(company_id, provider, entity_type, external_id)` through `external_refs`. Re-running a sync never duplicates.
- **Incremental cursors** stored per account per kind; a failed run does not advance the cursor.
- **Budgets:** each account has per-period call caps and each maps provider a monthly cap; the adapter refuses beyond the cap and raises an admin alert. Routing recomputation is proportional to distance remaining, not on every ping.
- **Data quality rules** live in the consuming module, not the adapter: odometer readings that go backwards are rejected with a reason; a GPS gap is "unknown", never "stopped"; duplicates by external id are ignored.
- **Failure visibility:** consecutive failures set `integration_accounts.status = error`, notify company admins, and show on the platform health screen. A stalled scheduler is detected by a heartbeat job.

---

## 5. Webhooks

- Inbound route: `POST /webhooks/{provider}/{integrationAccountId}`. The handler verifies the signature with the account's secret, stores the raw event in `webhook_events`, responds 2xx immediately, and enqueues processing. Invalid signatures are stored with `signature_valid = false` and rate-limited.
- Processing runs in the worker inside the account's tenant context and produces the same normalized records as a pull, so the consuming modules do not care which path delivered the data.
- Replays are safe because of `external_refs` idempotency.

---

## 6. Provider matrix

| Category | Interface | Providers planned | Phase | Notes |
|---|---|---|---|---|
| Telematics / ELD | `TelematicsProvider` | Mock, Samsara, Motive, Geotab | 6 (mock + first real), 15 (others) | HOS from the provider where available |
| Fuel cards | `FuelCardProvider` | Mock, WEX, EFS, Relay | 9 (mock + CSV import), 15 | CSV import is always available |
| Load boards | `LoadBoardProvider` | Mock, DAT, Truckstop | 15 | Needs company credentials |
| Maps / routing | `MapsProvider` | OSRM (self-hosted), OpenRouteService, Google Maps, Mapbox; MapLibre tiles for display | 6 | Free/self-hosted default; paid providers optional per company |
| Weather | `WeatherProvider` | Open-Meteo, Mock | 6 | Used by ETA risk |
| Messaging | `MessagingProvider` | Email (SMTP/SES), Twilio SMS, Telegram, Mock | 3 (email, in-app), 15 (SMS, Telegram) | Delivery outbox in `notifications` |
| Accounting | `AccountingProvider` | QuickBooks Online, Mock | 15 | Export/sync of invoices, bills, payments |
| Payments | `PaymentsProvider` | Stripe, Mock | 15 | Platform subscriptions and, if wanted, customer payments |
| Storage | `StorageProvider` | Local, S3-compatible | 0 | |
| LLM | `LLMProvider` | Anthropic, Mock | 14 | |

---

## 7. Adding a provider (checklist)

1. Implement the interface in `adapters/<category>/<provider>/` with normalized types; no business logic.
2. Register in `registry.ts` with a `providerCode`, display name, required credential fields (for the connect form), and capabilities.
3. Add contract tests against recorded fixtures (`__fixtures__/`) covering pagination, rate-limit handling, and error mapping.
4. Add `testConnection`.
5. If the provider pushes data, implement `verifyWebhook` and `parseWebhook` and add a fixture for each event type.
6. Document limits and costs in the adapter README; set default budgets.

---

## 8. Import/export as a first-class "integration"

Every module that can be fed by an integration can also be fed by a **CSV import** with a mapping step, validation preview, dry run, and rollback (`import_batches`). Exports (CSV/XLSX/PDF) go through the reporting module. This is how a new company loads its history without any database-level migration.
