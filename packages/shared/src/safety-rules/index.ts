// Accident & Claims v2 — pure, storage-independent rules (SPEC §4, §7). Used by the API (source of truth)
// and by the web app only for live previews. Exported from the package root as the `safetyRules` namespace
// because several names (dotRecordable, testing, Severity, Claim, Task…) already exist in `safety/*`.
export * from './types.js';
export * from './settings.js';
export * from './time.js';
export * from './format.js';
export * from './rules.js';
export * from './board.js';
export * from './report.js';
export * from './analytics.js';
