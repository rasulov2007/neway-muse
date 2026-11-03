import { describe, expect, it } from 'vitest';
import { LeadTelegramNotifier } from './lead-telegram';

describe('LeadTelegramNotifier.text', () => {
  const notifier = new LeadTelegramNotifier();
  const answers = { fullName: 'Ann <b>Lee</b>', phone: '+13125550142', experience: '3 years', position: 'Lease owner' } as never;

  it('says new lead, the answers, the source by name and links the lead; driver text is escaped', () => {
    const text = notifier.text({ leadNumber: 'LEAD-1030', leadId: 'lead_1', answers, source: 'instagram', again: false });
    expect(text).toContain('New lead · LEAD-1030');
    expect(text).toContain('Ann &lt;b&gt;Lee&lt;/b&gt;');
    expect(text).toContain('Source: Instagram');
    expect(text).toContain('<a href="https://neway.example.com/hr/recruiting">Open in TMS</a>');
  });

  it('says applied again for a known lead', () => {
    expect(notifier.text({ leadNumber: 'LEAD-1', leadId: 'l', answers, source: 'social', again: true })).toContain('Applied again');
  });

  it('names the recruiter who has the lead, or says unassigned', () => {
    expect(notifier.text({ leadNumber: 'LEAD-2', leadId: 'l', answers, source: 'website', again: false, recruiterName: 'Greta Harper' })).toContain('Recruiter: Greta Harper');
    expect(notifier.text({ leadNumber: 'LEAD-3', leadId: 'l', answers, source: 'website', again: false })).toContain('Recruiter: Unassigned');
  });
});
