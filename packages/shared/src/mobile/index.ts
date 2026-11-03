// The NeWay mobile app's API contract (docs/mobile/API.md). The Expo app imports these types.
export * from './driver.js';
export * from './pti.js';
export * from './notifications.js';
export * from './access.js';
export * from './breakdowns.js';
export * from './money.js';
export * from './care.js';
export * from './vacations.js';
export * from './documents.js';
export * from './safety-reports.js';
export * from './messages.js';
export * from './office.js';
export * from './assistant.js';

/** The header every mobile write carries; a retry with the same key returns the first answer. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
