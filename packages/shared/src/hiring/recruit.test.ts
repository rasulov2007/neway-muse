import { describe, expect, it } from 'vitest';
import {
  ExternalApplicationSchema,
  RecruitListQuerySchema,
  RecruitNoteSchema,
  followUpStateOf,
  isActiveProgress,
  matchesRecruitFilter,
  RECRUIT_BOARD_COLUMN_LABELS,
  RECRUIT_BOARD_COLUMNS,
  RECRUIT_PROGRESS,
  RECRUIT_STAGES,
  recruitBoardColumnOf,
  recruitStageOf,
  recruitNextStep,
  recruitProgressOf,
  type RecruitProgressInput,
} from './recruit.js';

const base: RecruitProgressInput = {
  lead: { status: 'new' },
  hiringCase: null,
  application: 'none',
  externalReceived: false,
  linkLive: false,
};

describe('recruit progress', () => {
  it('a lead with no candidate record is New until contacted, then Contacted; a dead one Closed', () => {
    expect(recruitProgressOf(base)).toBe('new');
    expect(recruitProgressOf({ ...base, lead: { status: 'contacted' } })).toBe('contacted');
    expect(recruitProgressOf({ ...base, lead: { status: 'prequalified' } })).toBe('prequalified');
    expect(matchesRecruitFilter('prequalified', 'in_progress')).toBe(true);
    expect(matchesRecruitFilter('contacted', 'in_progress')).toBe(true);
    expect(recruitProgressOf({ ...base, lead: { status: 'dead' } })).toBe('closed');
  });

  it('the journey: consent, then Safety, then the application (owner, 2026-10-11)', () => {
    const lead = { ...base, lead: { status: 'contacted' } };
    expect(recruitProgressOf({ ...lead, consent: 'sent' })).toBe('consent_sent');
    expect(recruitProgressOf({ ...lead, consent: 'received' })).toBe('consent_received');
    const c = { ...lead, consent: 'received' as const, hiringCase: { state: 'application' as const, safetyRequestedAt: '2026-10-11T12:00:00Z' } };
    expect(recruitProgressOf({ ...c, safety: 'pending' })).toBe('safety_review');
    expect(recruitProgressOf({ ...c, safety: 'needs_follow_up' })).toBe('safety_review');
    expect(recruitProgressOf({ ...c, safety: 'declined' })).toBe('closed');
    // Approved: the application is next; a link out is not a submission.
    expect(recruitProgressOf({ ...c, safety: 'approved' })).toBe('application_sent');
    expect(recruitProgressOf({ ...c, safety: 'approved', linkLive: true, application: 'draft' })).toBe('application_sent');
    expect(recruitProgressOf({ ...c, safety: 'approved', application: 'driver_submitted' })).toBe('application_received');
    expect(recruitProgressOf({ ...c, safety: 'approved', externalReceived: true })).toBe('application_received');
  });

  it('candidates under the earlier order (application first) read through the same steps', () => {
    const c = { ...base, hiringCase: { state: 'application' as const, safetyRequestedAt: null } };
    expect(recruitProgressOf(c)).toBe('prequalified');
    expect(recruitProgressOf({ ...c, linkLive: true })).toBe('application_sent');
    expect(recruitProgressOf({ ...c, application: 'driver_submitted' })).toBe('application_received');
    const checks = { ...base, application: 'submitted' as const, hiringCase: { state: 'checks' as const, safetyRequestedAt: null } };
    expect(recruitProgressOf(checks)).toBe('safety_review');
    expect(recruitProgressOf({ ...checks, hiringCase: { state: 'safety_review', safetyRequestedAt: null } })).toBe('safety_review');
  });

  it('offer to orientation is Onboarding, Ready to hire once every prerequisite is met; hire and exits end it', () => {
    for (const state of ['offer', 'ticketed', 'orientation'] as const) {
      expect(recruitProgressOf({ ...base, hiringCase: { state, safetyRequestedAt: null } })).toBe('onboarding');
    }
    expect(recruitProgressOf({ ...base, hiringCase: { state: 'orientation', safetyRequestedAt: null }, hireReady: true })).toBe('ready_to_hire');
    expect(recruitProgressOf({ ...base, hiringCase: { state: 'hired', safetyRequestedAt: null } })).toBe('hired');
    expect(recruitProgressOf({ ...base, hiringCase: { state: 'active_driver', safetyRequestedAt: null } })).toBe('hired');
    expect(recruitProgressOf({ ...base, hiringCase: { state: 'withdrawn', safetyRequestedAt: null } })).toBe('closed');
  });

  it('every progress value falls in exactly one dashboard stage', () => {
    for (const p of RECRUIT_PROGRESS) expect(RECRUIT_STAGES).toContain(recruitStageOf(p));
    expect(recruitStageOf('consent_received')).toBe('safety_review');
    expect(recruitStageOf('ready_to_hire')).toBe('onboarding');
  });

  it('next steps follow the real state', () => {
    expect(recruitNextStep(base)).toBe('Contact driver');
    expect(recruitNextStep({ ...base, lead: { status: 'contacted' } })).toBe('Send consent');
    expect(recruitNextStep({ ...base, lead: { status: 'contacted' }, consent: 'sent' })).toBe('Waiting for consent');
    expect(recruitNextStep({ ...base, lead: { status: 'contacted' }, consent: 'received' })).toBe('Send to Safety');
    const approved = { ...base, consent: 'received' as const, safety: 'approved' as const, hiringCase: { state: 'application' as const, safetyRequestedAt: 'x' } };
    expect(recruitNextStep(approved)).toBe('Send application');
    expect(recruitNextStep({ ...approved, linkLive: true })).toBe('Waiting for application');
    expect(recruitNextStep({ ...approved, application: 'driver_submitted' })).toBe('Review application');
    expect(recruitNextStep({ ...approved, application: 'driver_submitted', applicationReviewed: true })).toBe('Start onboarding');
    // The earlier order: a received application went to Safety next.
    expect(recruitNextStep({ ...base, application: 'driver_submitted', hiringCase: { state: 'application', safetyRequestedAt: null } })).toBe('Review application');
    expect(recruitNextStep({ ...base, application: 'submitted', hiringCase: { state: 'application', safetyRequestedAt: null } })).toBe('Send to Safety');
    expect(recruitProgressOf({ ...base, lead: { status: 'contacted' }, linkLive: true })).toBe('application_sent');
    expect(recruitNextStep({ ...base, hiringCase: { state: 'orientation', safetyRequestedAt: null }, hireReady: true })).toBe('Hire driver');
  });

  it('filters: All leaves out closed, In progress is the working range', () => {
    expect(matchesRecruitFilter('closed', 'all')).toBe(false);
    expect(matchesRecruitFilter('hired', 'all')).toBe(true);
    for (const p of ['consent_sent', 'safety_review', 'application_received', 'ready_to_hire'] as const) {
      expect(matchesRecruitFilter(p, 'in_progress')).toBe(true);
    }
    expect(matchesRecruitFilter('new', 'in_progress')).toBe(false);
    expect(isActiveProgress('hired')).toBe(false);
    expect(isActiveProgress('safety_review')).toBe(true);
  });

  it('follow-up state is relative to the given (Eastern) today', () => {
    expect(followUpStateOf(null, '2026-10-08')).toBeNull();
    expect(followUpStateOf('2026-10-07', '2026-10-08')).toBe('overdue');
    expect(followUpStateOf('2026-10-08', '2026-10-08')).toBe('today');
    expect(followUpStateOf('2026-10-09', '2026-10-08')).toBe('upcoming');
  });
});

describe('recruit schemas', () => {
  it('list query defaults to my leads, page 1 of 10', () => {
    expect(RecruitListQuerySchema.parse({})).toMatchObject({ scope: 'mine', filter: 'all', page: 1, pageSize: 10 });
  });

  it('a note needs text; the follow-up date is optional', () => {
    expect(RecruitNoteSchema.safeParse({ note: '  ' }).success).toBe(false);
    expect(RecruitNoteSchema.parse({ note: 'Called' })).toEqual({ note: 'Called', followUpOn: null });
    expect(RecruitNoteSchema.safeParse({ note: 'x', followUpOn: '10/09/2026' }).success).toBe(false);
  });

  it('the external application maps the form fields and refuses a malformed SSN', () => {
    const ok = ExternalApplicationSchema.parse({
      submissionKey: 'a1b2c3d4-key',
      firstName: 'Ann',
      lastName: 'Lee',
      phone: '(312) 555-0100',
      email: '',
      consent: 'on',
      ssn: '123-45-6789',
    });
    expect(ok.email).toBeNull();
    expect(ok.consent).toBe(true);
    expect(ok.files).toEqual({});
    expect(ExternalApplicationSchema.safeParse({ submissionKey: 'a1b2c3d4-key', firstName: 'A', lastName: 'B', phone: '3125550100', consent: true, ssn: '12' }).success).toBe(false);
  });
});

describe('recruit board columns', () => {
  it('puts Consent sent and Consent received in their own adjacent columns (owner, 2026-10-26)', () => {
    const i = RECRUIT_BOARD_COLUMNS.indexOf('consent_sent');
    expect(RECRUIT_BOARD_COLUMNS[i - 1]).toBe('lead_screening');
    expect(RECRUIT_BOARD_COLUMNS[i + 1]).toBe('consent_received');
    expect(RECRUIT_BOARD_COLUMNS[i + 2]).toBe('safety_review');
    expect(RECRUIT_BOARD_COLUMN_LABELS.consent_sent.title).toBe('Consent sent');
    expect(RECRUIT_BOARD_COLUMN_LABELS.consent_received.title).toBe('Consent received');
    expect(recruitBoardColumnOf('consent_sent')).toBe('consent_sent');
    expect(recruitBoardColumnOf('consent_received')).toBe('consent_received');
  });

  it('places every active progress in exactly one existing column', () => {
    for (const p of RECRUIT_PROGRESS) {
      const col = recruitBoardColumnOf(p);
      if (p === 'hired' || p === 'closed') expect(col).toBeNull();
      else expect(RECRUIT_BOARD_COLUMNS).toContain(col);
    }
  });
});
