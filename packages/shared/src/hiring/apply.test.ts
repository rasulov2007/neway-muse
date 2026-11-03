import { describe, expect, it } from 'vitest';
// The application page's own phone check, verbatim from the owner's design. The server must accept
// and refuse exactly the numbers the page does, so both run the same table below.
import { phoneMessage } from '../../../../apps/web/src/apply/phone-message';
import {
  sourceFromAttribution,
  ApplicationAnswersSchema,
  CreateApplyLinkSchema,
  LeadApplicationSummarySchema,
  PublicApplicationSchema,
  normalizeApplyPhone,
  normalizeEmail,
  normalizePhone,
  phoneMatchKey,
  splitFullName,
} from './apply.js';

describe('normalizePhone', () => {
  it('turns any common US typing into E.164', () => {
    for (const typed of ['(312) 555-0142', '312.555.0142', '312 555 0142', '1-312-555-0142']) {
      expect(normalizePhone('1', typed)).toEqual({ ok: true, e164: '+13125550142' });
    }
  });

  it('refuses numbers that cannot exist in North America', () => {
    expect(normalizePhone('1', '555-0100').ok).toBe(false);
    expect(normalizePhone('1', '(012) 555-0142').ok).toBe(false);
    expect(normalizePhone('1', '(312) 155-0142').ok).toBe(false);
    expect(normalizePhone('1', '').ok).toBe(false);
  });

  it('handles full international numbers, and +1 as North American', () => {
    expect(normalizePhone('other', '+998 90 123 45 67')).toEqual({
      ok: true,
      e164: '+998901234567',
    });
    expect(normalizePhone('other', '+52 55 1234 5678')).toEqual({
      ok: true,
      e164: '+525512345678',
    });
    expect(normalizePhone('other', '+1 312 555 0142')).toEqual({ ok: true, e164: '+13125550142' });
    expect(normalizePhone('other', '+1 312 555 014').ok).toBe(false);
    expect(normalizePhone('other', '0123').ok).toBe(false);
  });
});

/**
 * One table, two checks: the page's `phoneMessage` (empty string = accepted) and the server's
 * `normalizeApplyPhone`. Every row must agree on accept/refuse, and on the wording when refused.
 */
const PHONE_TABLE: { input: string; e164: string | null }[] = [
  { input: '(312) 555-0142', e164: '+13125550142' },
  { input: '312.555.0142', e164: '+13125550142' },
  { input: '312 555 0142', e164: '+13125550142' },
  { input: '3125550142', e164: '+13125550142' },
  { input: '1 312 555 0142', e164: '+13125550142' },
  { input: '1-312-555-0142', e164: '+13125550142' },
  { input: '+1 (312) 555-0142', e164: '+13125550142' },
  { input: '+13125550142', e164: '+13125550142' },
  { input: '  +1 312 555 0142 ', e164: '+13125550142' },
  { input: '+998 90 123 45 67', e164: '+998901234567' },
  { input: '+52 55 1234 5678', e164: '+525512345678' },
  { input: '+44 20 7946 0958', e164: '+442079460958' },
  { input: '+7 912 345 67 89', e164: '+79123456789' },
  { input: '+12345678', e164: null },
  { input: '+1 312 555 014', e164: null },
  { input: '+1 312 555 01420', e164: null },
  { input: '+0 123 456 789', e164: null },
  { input: '+998 90', e164: null },
  { input: '+123456789012345678', e164: null },
  { input: '555-0100', e164: null },
  { input: '(012) 555-0142', e164: null },
  { input: '(312) 155-0142', e164: null },
  { input: '(112) 555-0142', e164: null },
  { input: '2 312 555 0142', e164: null },
  { input: '312 555 01420', e164: null },
  { input: '998 90 123 45 67', e164: null },
  { input: '52 55 1234 5678', e164: null },
  { input: '312+555+0142', e164: '+13125550142' },
];

describe('the page and the server agree on every phone number', () => {
  it.each(PHONE_TABLE)('$input', ({ input, e164 }) => {
    const page = phoneMessage(input);
    const server = normalizeApplyPhone(input);
    expect(page === '').toBe(e164 !== null);
    expect(server.ok).toBe(e164 !== null);
    if (server.ok) expect(server.e164).toBe(e164);
    else expect(server.message).toBe(page);
  });

  it('an empty number is refused by the server (the page refuses it as a required field)', () => {
    expect(normalizeApplyPhone('').ok).toBe(false);
    expect(normalizeApplyPhone('+').ok).toBe(false);
  });
});

describe('phoneMatchKey', () => {
  it('makes every way of writing one US number the same key', () => {
    const keys = ['+13125550142', '(312) 555-0142', '312.555.0142', '1 312 555 0142'].map(
      phoneMatchKey,
    );
    expect(new Set(keys)).toEqual(new Set(['13125550142']));
  });
});

describe('names and email', () => {
  it('splits on the first word and keeps the rest as the last name', () => {
    expect(splitFullName('  Juan  Carlos Pérez ')).toEqual({
      firstName: 'Juan',
      lastName: 'Carlos Pérez',
    });
  });

  it('a one-word name is allowed: the last name is empty', () => {
    expect(splitFullName('Madonna')).toEqual({ firstName: 'Madonna', lastName: '' });
  });

  it('lower-cases and trims email; empty is null', () => {
    expect(normalizeEmail('  A.B@Example.COM ')).toBe('a.b@example.com');
    expect(normalizeEmail('  ')).toBeNull();
  });
});

describe('application schemas', () => {
  const body = {
    submissionId: '4b7e2a5f-9c1d-4e8a-b2f3-0a1b2c3d4e5f',
    fullName: 'Marcus Reed',
    phone: '(312) 555-0142',
    experience: '2 years',
    position: 'Company driver',
    consent: true,
    website: '',
    completedInSeconds: 27,
  };

  it('takes the design’s four answers, trimmed', () => {
    const parsed = PublicApplicationSchema.parse({
      ...body,
      fullName: '  Marcus Reed ',
      experience: ' 2 years ',
      position: ' Company driver  ',
    });
    expect(parsed.fullName).toBe('Marcus Reed');
    expect(parsed.experience).toBe('2 years');
    expect(parsed.position).toBe('Company driver');
    expect(parsed.completedInSeconds).toBe(27);
  });

  it('checks each field on its own and names it', () => {
    const issues = (patch: Record<string, unknown>) =>
      PublicApplicationSchema.safeParse({ ...body, ...patch }).error?.issues.map((i) => i.path[0]);
    expect(issues({ fullName: ' M ' })).toEqual(['fullName']);
    expect(issues({ fullName: 'x'.repeat(101) })).toEqual(['fullName']);
    expect(issues({ phone: '' })).toEqual(['phone']);
    expect(issues({ phone: '1'.repeat(26) })).toEqual(['phone']);
    expect(issues({ experience: '   ' })).toEqual(['experience']);
    expect(issues({ experience: 'x'.repeat(81) })).toEqual(['experience']);
    expect(issues({ position: '' })).toEqual(['position']);
    expect(issues({ position: 'x'.repeat(81) })).toEqual(['position']);
    expect(issues({ completedInSeconds: -1 })).toEqual(['completedInSeconds']);
    expect(issues({ completedInSeconds: 3601 })).toEqual(['completedInSeconds']);
    expect(issues({ completedInSeconds: 1.5 })).toEqual(['completedInSeconds']);
  });

  it('a one-word name is accepted', () => {
    expect(PublicApplicationSchema.safeParse({ ...body, fullName: 'Madonna' }).success).toBe(true);
  });

  it('the seconds are optional', () => {
    const { completedInSeconds: _drop, ...rest } = body;
    expect(PublicApplicationSchema.safeParse(rest).success).toBe(true);
    expect(PublicApplicationSchema.safeParse({ ...rest, completedInSeconds: null }).success).toBe(
      true,
    );
  });

  it('consent must be explicitly true', () => {
    expect(PublicApplicationSchema.safeParse({ ...body, consent: false }).success).toBe(false);
    expect(PublicApplicationSchema.safeParse({ ...body, consent: undefined }).success).toBe(false);
  });

  it('the submission needs a uuid and drops anything it does not know, such as a company', () => {
    const parsed = PublicApplicationSchema.parse({ ...body, companyId: 'co_someone_else' });
    expect('companyId' in parsed).toBe(false);
    expect(PublicApplicationSchema.parse({ ...body, website: undefined }).website).toBe('');
    expect(PublicApplicationSchema.safeParse({ ...body, submissionId: 'x' }).success).toBe(false);
  });

  it('the stored answers are the four fields and the seconds; an older shape does not parse', () => {
    expect(
      ApplicationAnswersSchema.safeParse({
        fullName: 'Marcus Reed',
        phone: '+13125550142',
        experience: '2 years',
        position: 'Company driver',
        completedInSeconds: null,
      }).success,
    ).toBe(true);
    expect(
      ApplicationAnswersSchema.safeParse({
        fullName: 'Marcus Reed',
        phone: '+13125550142',
        email: null,
        city: 'Joliet',
        state: 'IL',
        hasCdlA: 'yes',
        experience: '1_2yr',
        interest: 'company',
        setup: 'solo',
        start: 'immediately',
        message: null,
      }).success,
    ).toBe(false);
    expect(
      LeadApplicationSummarySchema.safeParse({
        receivedAt: '2026-10-04T12:00:00.000Z',
        linkName: 'Instagram drivers',
        experience: null,
        position: null,
      }).success,
    ).toBe(true);
  });

  it('a link needs approved wording and https addresses; a logo may be a path on this site', () => {
    const base = {
      name: 'Instagram drivers',
      slug: 'nwf-drivers',
      consentText: 'I agree to be contacted by NORTHWIND FREIGHT INC about my application.',
      privacyPolicyUrl: 'https://northwind-freight.example/privacy-policy/',
    };
    expect(CreateApplyLinkSchema.safeParse(base).success).toBe(true);
    expect(CreateApplyLinkSchema.safeParse({ ...base, consentText: 'ok' }).success).toBe(false);
    expect(
      CreateApplyLinkSchema.safeParse({ ...base, privacyPolicyUrl: 'http://x.com' }).success,
    ).toBe(false);
    expect(CreateApplyLinkSchema.safeParse({ ...base, slug: 'Bad Slug' }).success).toBe(false);
    const logo = (logoUrl: string) =>
      CreateApplyLinkSchema.safeParse({ ...base, logoUrl }).success;
    expect(logo('/brand/nwf-logo.png')).toBe(true);
    expect(logo('https://cdn.example.com/logo.png')).toBe(true);
    expect(logo('')).toBe(true);
    expect(logo('//evil.example.com/logo.png')).toBe(false);
    expect(logo('http://example.com/logo.png')).toBe(false);
    expect(logo('javascript:alert(1)')).toBe(false);
    expect(logo('brand/logo.png')).toBe(false);
  });

  it('a short name is optional and at most 12 characters', () => {
    const base = {
      name: 'Instagram drivers',
      slug: 'nwf-drivers',
      consentText: 'I agree to be contacted by NORTHWIND FREIGHT INC about my application.',
      privacyPolicyUrl: 'https://northwind-freight.example/privacy-policy/',
    };
    expect(CreateApplyLinkSchema.parse({ ...base, shortName: ' NWF ' }).shortName).toBe('NWF');
    expect(CreateApplyLinkSchema.parse({ ...base, shortName: '' }).shortName).toBeNull();
    expect(CreateApplyLinkSchema.parse(base).shortName).toBeNull();
    expect(CreateApplyLinkSchema.safeParse({ ...base, shortName: 'x'.repeat(13) }).success).toBe(
      false,
    );
  });
});

describe('sourceFromAttribution (owner, 2026-10-06)', () => {
  const none = { utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null, fbclid: null, gclid: null, referrer: null };
  it('reads Instagram and Facebook from utm_source, the referrer, or a Meta click id', () => {
    expect(sourceFromAttribution({ ...none, utmSource: 'instagram' }, 'social')).toBe('instagram');
    expect(sourceFromAttribution({ ...none, utmSource: 'ig' }, 'social')).toBe('instagram');
    expect(sourceFromAttribution({ ...none, utmSource: 'fb' }, 'social')).toBe('facebook');
    expect(sourceFromAttribution({ ...none, utmSource: 'Facebook_Mobile_Feed' }, 'social')).toBe('facebook');
    expect(sourceFromAttribution({ ...none, referrer: 'https://l.instagram.com/' }, 'social')).toBe('instagram');
    expect(sourceFromAttribution({ ...none, referrer: 'https://m.facebook.com/' }, 'social')).toBe('facebook');
    expect(sourceFromAttribution({ ...none, fbclid: 'IwAR123' }, 'social')).toBe('facebook');
  });
  it('keeps the link source when nothing says where the driver came from, or the link is not social', () => {
    expect(sourceFromAttribution({ ...none }, 'social')).toBe('social');
    expect(sourceFromAttribution(null, 'social')).toBe('social');
    expect(sourceFromAttribution({ ...none, utmSource: 'instagram' }, 'job_board')).toBe('job_board');
    expect(sourceFromAttribution({ ...none, utmSource: 'big-sale' }, 'social')).toBe('social');
  });
});
