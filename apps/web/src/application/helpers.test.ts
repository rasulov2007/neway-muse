import { describe, expect, it } from 'vitest';
import type { DotAppMissingItem } from '@neway/shared';
import { uploadProblem } from './api';
import { saveLabel } from './autosave';
import { getP, setP, shortId } from './paths';
import { allMissing, withDefaults, attentionToast, canJump, continueFrom, initialPosition, reindex, ruleContext, stepErrors, visibleSteps } from './rules';
import { escapeHtml, sanitizeLegalHtml } from './sanitize';
import { inkBounds } from './signature';

describe('sanitizeLegalHtml', () => {
  it('keeps the allowed tags and class/rowspan/colspan only', () => {
    const out = sanitizeLegalHtml('<p class="addr" style="color:red" onclick="x()">A&amp;J<br>line</p><table><tr><td rowspan="2" colspan="x" id="t">c</td></tr></table>');
    expect(out).toContain('<p class="addr">A&amp;J<br>line</p>');
    expect(out).toContain('<td rowspan="2">c</td>');
    expect(out).not.toMatch(/style|onclick|colspan|id=/);
  });
  it('drops scripts with their content and unwraps unknown elements', () => {
    const out = sanitizeLegalHtml('<p>a<script>alert(1)</script><a href="javascript:x">link</a><img src=x onerror=alert(1)><span>b</span></p><iframe>z</iframe>');
    expect(out).toBe('<p>alinkb</p>');
  });
  it('keeps nested lists and headings', () => {
    expect(sanitizeLegalHtml('<h4>T</h4><ul><li><b>x</b><ul><li>y</li></ul></li></ul>')).toBe('<h4>T</h4><ul><li><b>x</b><ul><li>y</li></ul></li></ul>');
  });
  it('accepts nothing that is not a string', () => {
    expect(sanitizeLegalHtml(undefined)).toBe('');
    expect(sanitizeLegalHtml({ html: '<p>x</p>' })).toBe('');
  });
  it('escapes values put into template html', () => {
    expect(escapeHtml('<b>"A&J"</b>')).toBe('&lt;b&gt;&quot;A&amp;J&quot;&lt;/b&gt;');
  });
});

describe('paths', () => {
  it('reads and writes dotted paths immutably, making arrays for numeric keys', () => {
    const a = { personal: { firstName: 'A' } };
    const b = setP(a, 'licenses.0.number', 'X1');
    expect(getP(b, 'licenses.0.number')).toBe('X1');
    expect(Array.isArray((b as unknown as { licenses: unknown }).licenses)).toBe(true);
    expect(a).toEqual({ personal: { firstName: 'A' } });
    const c = setP(b, 'personal.address.city', 'Joliet');
    expect(c.personal).not.toBe(a.personal);
    expect(getP(c, 'personal.firstName')).toBe('A');
  });
  it('makes short ids', () => {
    expect(shortId()).toMatch(/^[0-9a-f]{10}$/);
    expect(shortId()).not.toBe(shortId());
  });
});

describe('signature trimming', () => {
  it('finds the padded ink box', () => {
    const ink = (x: number, y: number) => (x >= 20 && x <= 40 && y >= 10 && y <= 12 ? 255 : 0);
    expect(inkBounds(ink, 100, 50)).toEqual({ x: 16, y: 6, w: 29, h: 11 });
  });
  it('clamps to the canvas and returns null for an empty pad', () => {
    expect(inkBounds(() => 255, 10, 10)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    expect(inkBounds(() => 0, 10, 10)).toBeNull();
  });
});

const ctx = (over: Partial<Parameters<typeof ruleContext>[0]> = {}) =>
  ruleContext({ today: '2026-10-27', signatures: [], uploads: [], approvedDocs: [], consentLinks: [], ssnOnFile: false, ...over });

describe('step rules', () => {
  it('shows Contractor forms only for contractor positions', () => {
    expect(visibleSteps({})).not.toContain('contractor');
    expect(visibleSteps({ company: { position: 'Owner Operator' } })).toContain('contractor');
    expect(visibleSteps({})).toHaveLength(11);
  });
  it('Continue is blocked while the step has items, and moves on when it has none', () => {
    const missing = allMissing({}, ctx());
    const errs = stepErrors('personal', missing, new Set());
    expect(errs.length).toBeGreaterThan(0);
    expect(continueFrom(0, 0, errs, 11)).toEqual({ step: 0, maxStep: 0, blocked: true });
    expect(continueFrom(0, 0, [], 11)).toEqual({ step: 1, maxStep: 1, blocked: false });
    expect(continueFrom(10, 10, [], 11)).toEqual({ step: 10, maxStep: 10, blocked: false });
  });
  it('awaiting documents never stop Continue, nor do the fields inside their cards', () => {
    const missing = allMissing({}, ctx());
    const certs = stepErrors('certs', missing, new Set(['prev_da', 'onduty', 'other_work', 'violations_cert']));
    expect(certs.some((m) => m.kind === 'document')).toBe(false);
    expect(certs.some((m) => /^(prevda|onduty|otherwork|cov)\./.test(m.key))).toBe(false);
    // …but Submit still lists them.
    expect(missing.some((m) => m.kind === 'document' && m.key === 'doc.prev_da')).toBe(true);
  });
  it('a signature is required only for an approved document', () => {
    const none = stepErrors('emergency', allMissing({}, ctx()), new Set());
    expect(none.some((m) => m.key === 'sig.emergency')).toBe(false);
    const withDoc = stepErrors('emergency', allMissing({}, ctx({ approvedDocs: ['emergency'] })), new Set());
    expect(withDoc.some((m) => m.key === 'sig.emergency')).toBe(true);
  });
  it('opens at the first incomplete step, or at the first section Safety asked about', () => {
    const steps = visibleSteps({});
    const m: DotAppMissingItem[] = [{ step: 'license', key: 'exp.other', label: 'x', kind: 'field' }];
    expect(initialPosition(steps, m, new Set(), null)).toEqual({ step: 2, maxStep: 2 });
    expect(initialPosition(steps, [], new Set(), null)).toEqual({ step: steps.length - 1, maxStep: steps.length - 1 });
    expect(initialPosition(steps, m, new Set(), ['history'])).toEqual({ step: 4, maxStep: steps.length - 1 });
  });
  it('keeps the same section when the step list changes', () => {
    const a = visibleSteps({});
    const b = visibleSteps({ company: { position: 'Owner Operator' } });
    expect(b[reindex(a, b, a.indexOf('documents'))]).toBe('documents');
    expect(a[reindex(b, a, b.indexOf('contractor'))]).toBe('documents');
  });
  it('jumps only to reached steps', () => {
    expect(canJump(2, 3)).toBe(true);
    expect(canJump(4, 3)).toBe(false);
    expect(canJump(-1, 3)).toBe(false);
  });
  it('says how many items need attention', () => {
    expect(attentionToast(1)).toBe('1 item needs attention');
    expect(attentionToast(3)).toBe('3 items need attention');
  });
});

describe('first-open defaults', () => {
  it('adds a first employer with an id and a first license; ids missing employers', () => {
    const r = withDefaults({});
    expect(r.answers.employers?.[0]?.id).toMatch(/^[0-9a-f]{10}$/);
    expect(r.answers.licenses?.[0]).toMatchObject({ country: 'United States', current: 'Yes', cdl: 'Yes' });
    expect(r.changed).toBe(false);
    const s = withDefaults({ employers: [{ company: 'A' }] });
    expect(s.changed).toBe(true);
    expect(s.answers.employers?.[0]?.id).toBeTruthy();
  });
});

describe('uploads and save status', () => {
  it('checks type and size before sending', () => {
    expect(uploadProblem({ name: 'a.jpg', type: 'image/jpeg', size: 10 })).toBeNull();
    expect(uploadProblem({ name: 'a.HEIC', type: '', size: 10 })).toBeNull();
    expect(uploadProblem({ name: 'a.docx', type: 'application/msword', size: 10 })).toMatch(/photo or PDF/);
    expect(uploadProblem({ name: 'a.pdf', type: 'application/pdf', size: 16 * 1024 * 1024 })).toMatch(/15 MB/);
  });
  it('words the save status as the prototype does', () => {
    const f = () => '3:04 PM';
    expect(saveLabel(false, 'saved', null, f).text).toBe('Offline — not saved yet');
    expect(saveLabel(true, 'saving', null, f).text).toBe('Saving…');
    expect(saveLabel(true, 'error', null, f).text).toBe('Save failed — retrying');
    expect(saveLabel(true, 'saved', '2026-10-27T19:04:00Z', f).text).toBe('Saved 3:04 PM');
    expect(saveLabel(true, 'saved', null, f).text).toBe('All changes saved');
  });
});
