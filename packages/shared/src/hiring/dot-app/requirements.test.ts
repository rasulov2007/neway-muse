import { describe, expect, it } from 'vitest';
import { abaRoutingValid, SaveDotAppSchema } from './answers.js';
import { DOT_APP_DOCUMENTS, signatureDocKey } from './documents.js';
import {
  dotAppCoverage,
  dotAppEvEmployers,
  dotAppFcraEntities,
  dotAppMissing,
  dotAppSignaturesFor,
  dotAppSphEmployers,
  dotAppUploadSlots,
  dotAppVisibleSteps,
  signatureLabel,
  type DotAppContext,
} from './requirements.js';

const today = '2026-10-27';
const all = new Set(DOT_APP_DOCUMENTS.map((d) => d.key));
const ctx = (over: Partial<DotAppContext> = {}): DotAppContext => ({
  today,
  signatures: new Set(),
  uploads: new Set(),
  approvedDocs: all,
  consentLinks: new Set(),
  ssnOnFile: false,
  ...over,
});

describe('DOT application v2 requirements', () => {
  it('shows Contractor forms only to owner-operators and contractors', () => {
    expect(dotAppVisibleSteps({ company: { position: 'Company Driver' } })).not.toContain('contractor');
    expect(dotAppVisibleSteps({ company: { position: 'Owner Operator' } })).toContain('contractor');
    expect(dotAppVisibleSteps({ company: { position: 'Lease Purchase' } })).toContain('contractor');
  });

  it('does not ask again for a signature the Consent Form already holds, but still asks the acknowledgement', () => {
    const linked = dotAppSignaturesFor('disclosures', {}, { approvedDocs: all, consentLinks: new Set(['psp', 'mvr', 'clearinghouse']), today });
    expect(linked).not.toContain('psp');
    expect(linked).not.toContain('fcra_disclosure');
    expect(linked).toContain('emp_verification');
    const missing = dotAppMissing({}, ctx({ consentLinks: new Set(['psp']) }));
    expect(missing.some((m) => m.key === 'ack.psp')).toBe(true);
    expect(missing.some((m) => m.key === 'sig.psp')).toBe(false);
  });

  it('asks one Safety Performance History signature per DOT-tested employer of the last 3 years', () => {
    const a = {
      employers: [
        { id: 'a', company: 'Old Co', start: '2019-01-01', end: '2022-01-01', dotTesting: 'Yes' },
        { id: 'b', company: 'Recent Co', start: '2022-02-01', end: '2025-01-01', dotTesting: 'Yes' },
        { id: 'c', company: 'Warehouse', start: '2025-02-01', dotTesting: 'No' },
      ],
    };
    expect(dotAppSphEmployers(a, today).map((e) => e.id)).toEqual(['b']);
    expect(dotAppSignaturesFor('disclosures', a, { approvedDocs: all, consentLinks: new Set(), today })).toContain('sph_b');
  });

  it('highlights gaps in the 3-year employment coverage', () => {
    const cov = dotAppCoverage({ employers: [{ start: '2023-10-27', end: '2025-01-01' }, { start: '2025-06-01' }] }, today);
    expect(cov.ok).toBe(false);
    expect(cov.gaps).toEqual([['2025-01-01', '2025-06-01']]);
  });

  it('a document the company has not approved blocks Submit and is never asked to be signed', () => {
    const none = new Set<string>();
    const missing = dotAppMissing({}, ctx({ approvedDocs: none }));
    expect(missing.some((m) => m.kind === 'document' && m.key === 'doc.psp')).toBe(true);
    expect(missing.some((m) => m.kind === 'signature')).toBe(false);
  });

  it('asks the TWIC card only when the driver holds one, registration only for owner-operators', () => {
    expect(dotAppUploadSlots({ company: { twic: 'Yes' } }).find((s) => s.slot === 'twic')?.required).toBe(true);
    expect(dotAppUploadSlots({}).some((s) => s.slot === 'twic')).toBe(false);
    expect(dotAppUploadSlots({ company: { position: 'Owner Operator' } }).find((s) => s.slot === 'registration')?.required).toBe(false);
  });

  it('asks one 391.23 Request/Consent per previous employer of the last 3 years (the generic one when none)', () => {
    const a = {
      employers: [
        { id: 'a', company: 'Old Co', start: '2019-01-01', end: '2022-01-01' },
        { id: 'b', company: 'Recent Co', start: '2022-02-01', end: '2025-01-01', dotTesting: 'No' },
        { id: 'c', company: 'Now Co', start: '2025-02-01' },
      ],
    };
    expect(dotAppEvEmployers(a, today).map((e) => e.id)).toEqual(['b', 'c']);
    const keys = dotAppSignaturesFor('disclosures', a, { approvedDocs: all, consentLinks: new Set(), today });
    expect(keys).toEqual(expect.arrayContaining(['ev_b', 'ev_c']));
    expect(keys).not.toContain('emp_verification');
    expect(keys).not.toContain('ev_a');
    expect(dotAppSignaturesFor('disclosures', {}, { approvedDocs: all, consentLinks: new Set(), today })).toContain('emp_verification');
    expect(signatureDocKey('ev_b')).toBe('emp_verification');
    expect(signatureLabel('ev_b', a)).toContain('Recent Co');
  });

  it('asks one FCRA Disclosure + Authorization (acknowledged and signed) per employer and per trucking school, even with the Consent Form linked', () => {
    const a = { employers: [{ id: 'e1', company: 'Midwest Freight' }], schools: [{ id: 's1', school: 'CDL Academy' }] };
    expect(dotAppFcraEntities(a).map((x) => x.name)).toEqual(['Midwest Freight', 'CDL Academy']);
    const keys = dotAppSignaturesFor('disclosures', a, { approvedDocs: all, consentLinks: new Set(['psp', 'mvr', 'clearinghouse']), today });
    expect(keys).toEqual(expect.arrayContaining(['fcrad_e1', 'fcraa_e1', 'fcrad_s1', 'fcraa_s1']));
    const missing = dotAppMissing(a, ctx({ consentLinks: new Set(['mvr']) })).map((m) => m.key);
    expect(missing).toEqual(expect.arrayContaining(['ack.fcrad_e1', 'ack.fcraa_s1', 'sig.fcrad_s1', 'sig.fcraa_e1']));
    expect(signatureDocKey('fcrad_s1')).toBe('fcra_disclosure_entity');
    expect(signatureLabel('fcraa_s1', a)).toContain('CDL Academy');
  });

  it('a document added later does not block a company that has not approved it', () => {
    const without = new Set([...all].filter((k) => !['fcra_disclosure_entity', 'fcra_authorization_entity', 'ach_debit'].includes(k)));
    const a = { company: { position: 'Owner Operator' }, employers: [{ id: 'e1', company: 'X' }] };
    const missing = dotAppMissing(a, ctx({ approvedDocs: without }));
    expect(missing.some((m) => m.key.includes('fcrad_') || m.key.includes('ach'))).toBe(false);
    expect(missing.some((m) => m.key === 'doc.ach_debit')).toBe(false);
  });

  it('ACH debit authorization: required for contractors, bank numbers counted only when sealed on file', () => {
    const a = { company: { position: 'Owner Operator' }, ach: { name: 'X LLC', address: '1 Main', accountType: 'Checking Account', bank: 'Chase', email: 'x@y.co' } };
    expect(dotAppSignaturesFor('contractor', a, { approvedDocs: all, consentLinks: new Set(), today })).toContain('ach_debit');
    expect(dotAppMissing(a, ctx()).map((m) => m.key)).toContain('ach.numbers');
    const ok = dotAppMissing(a, ctx({ bankOnFile: true })).map((m) => m.key);
    expect(ok).not.toContain('ach.numbers');
    expect(ok.some((k) => k.startsWith('ach.'))).toBe(false);
    expect(dotAppMissing({ company: { position: 'Company Driver' } }, ctx()).some((m) => m.key.startsWith('ach.'))).toBe(false);
  });

  it('validates ABA routing numbers by checksum', () => {
    expect(abaRoutingValid('021000021')).toBe(true);
    expect(abaRoutingValid('111000025')).toBe(true);
    expect(abaRoutingValid('021000022')).toBe(false);
    expect(abaRoutingValid('12345')).toBe(false);
    expect(SaveDotAppSchema.safeParse({ version: 1, answers: {}, bank: { routing: '021000022', account: '123456' } }).success).toBe(false);
    expect(SaveDotAppSchema.safeParse({ version: 1, answers: {}, bank: { routing: '021000021', account: '123456' } }).success).toBe(true);
  });

  it('single-query Clearinghouse consent asks the query period; the minister’s permit question is always asked; FEIN or None', () => {
    const m = dotAppMissing({ chs: { from: '2026-11-01', to: '2026-10-01' }, company: { position: 'Owner Operator' } }, ctx()).map((x) => x.key);
    expect(m).toContain('chs.to');
    expect(m).toContain('criminal.canadaPermit');
    expect(m).toContain('oa.fein');
    const m2 = dotAppMissing({ chs: { from: '2026-10-01', to: '2026-10-31' }, oa: { feinNone: true }, company: { position: 'Owner Operator' } }, ctx()).map((x) => x.key);
    expect(m2).not.toContain('chs.to');
    expect(m2).not.toContain('chs.from');
    expect(m2).not.toContain('oa.fein');
  });

  it('asks the initials the company’s own documents carry (pages and items), not a fixed layout', () => {
    const keys = (c: DotAppContext) => dotAppMissing({}, c).map((m) => m.key);
    // Without the content: the Harbor Line layout (2 initialled pages, 3 video initials, 12 receipt items).
    expect(keys(ctx())).toEqual(expect.arrayContaining(['ica.init0', 'ica.init1', 'vid.i2', 'dar.i12']));
    // A one-page IC acknowledgement and a one-item video consent (a company's own documents).
    const content: Record<string, Record<string, unknown>> = {
      ic_ack: { pages: [{ label: 'Page 1', initials: true }] },
      video_consent: { items: ['Video'] },
      da_receipt: { items: ['1', '2', '3'] },
    };
    const own = keys(ctx({ templateContent: (k) => content[k] }));
    expect(own).toContain('ica.init0');
    expect(own).not.toContain('ica.init1');
    expect(own).toContain('vid.i0');
    expect(own).not.toContain('vid.i1');
    expect(own).toContain('dar.i3');
    expect(own).not.toContain('dar.i4');
    // Only pages marked for initials are asked.
    const third = keys(ctx({ templateContent: (k) => (k === 'ic_ack' ? { pages: [{}, {}, { initials: true }] } : undefined) }));
    expect(third.filter((k) => k.startsWith('ica.init'))).toEqual(['ica.init2']);
  });
});
