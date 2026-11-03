#!/usr/bin/env node
/**
 * Demo payroll set-up for the hackathon film (local demo only): finishes Silk Way Demo Lines'
 * settlement settings and saves every driver's financial profile, through the API's own doors
 * (version checks, audit), so NeWay AI's driver_statements_preview shows earnings instead of
 * "Pay plan not reviewed".
 *
 *   node scripts/hackathon/seed-pay.mjs [--api http://127.0.0.1:3100]
 *
 * Fictional data. One deliberate slip for the AI to catch: Darnell Pruitt (truck 1102) is saved at
 * $1.62 a mile instead of the fleet's $0.62 (a typo an accountant would want flagged).
 * Idempotent: settings already set and profiles already saved are left alone.
 * Refuses any API that is not on localhost.
 */
const argv = process.argv.slice(2);
const API = (argv.includes('--api') ? argv[argv.indexOf('--api') + 1] : 'http://127.0.0.1:3100').replace(/\/$/, '');
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(API)) {
  console.error(`Refusing ${API}: the demo payroll seed only runs against a local API.`);
  process.exit(1);
}
const B = `${API}/api/v1`;
const EMAIL = process.env.DEMO_EMAIL ?? 'demo.admin@silkway-demo.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'MuseDemo-2026!';
const TYPO_DRIVER = 'drv_swd_02';
const EFFECTIVE = '2026-10-01';

const login = await fetch(`${B}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
if (!login.ok) throw new Error(`Sign-in failed (${login.status})`);
const { token } = await login.json();
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const call = async (method, path, body) => {
  const r = await fetch(`${B}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${j.detail ?? ''}`);
  return j;
};

const s = await call('GET', '/accounting/settings');
const want = { cutoffBasis: 'delivered_at', cutoffTimezoneConfirmed: true, teamBaseMileageSplit: 'each_full' };
if (Object.entries(want).some(([k, v]) => s.settings[k] !== v)) {
  await call('PUT', '/accounting/settings', {
    expectedVersion: s.version,
    settings: want,
    confirmations: { cutoffTimezoneConfirmed: 'Demo company (fictional): pay week Monday 12:00 to Monday 12:00 US Eastern' },
  });
  console.log('settlement settings set');
} else console.log('settlement settings already set');

const drivers = (await call('GET', '/drivers?pageSize=100')).data;
let saved = 0;
for (const d of drivers) {
  const { profile } = await call('GET', `/accounting/drivers/${d.id}/account`);
  if (!profile.defaulted) continue;
  const cur = profile.current;
  const loadedPlan = d.id === TYPO_DRIVER && cur.loadedPlan.kind === 'per_mile' ? { kind: 'per_mile', rate: 1.62 } : cur.loadedPlan;
  await call('PUT', `/accounting/drivers/${d.id}/profile`, {
    expectedVersion: profile.version,
    effectiveFrom: EFFECTIVE,
    contractType: cur.contractType,
    switches: cur.switches,
    loadedPlan,
    emptyPlan: cur.emptyPlan,
    escrow: { ...cur.escrow, openingBalanceCents: 0, openingReconciled: true },
    lease: cur.lease ?? null,
    openingDebtCents: 0,
    openingDebtReconciled: true,
    confirmRate: true,
    reason: 'Demo payroll set-up (fictional company)',
  });
  saved += 1;
}
console.log(`driver profiles saved: ${saved} (of ${drivers.length})`);
