import { describe, expect, it } from 'vitest';
import * as shared from '@neway/shared';
import * as page from './forms';

/** The Driver Care page keeps its own copies of the option lists; they must equal the server's. */
describe('Driver Care services and options', () => {
  it.each([
    'MANAGEMENT_CALL_TOPICS',
    'MANAGEMENT_CALL_TOPIC_LABELS',
    'COMPLIANCE_SUBJECTS',
    'COMPLIANCE_SUBJECT_LABELS',
    'DRIVER_REFERRAL_BONUS_TEXT',
    'DRIVER_CARE_MAX_FILES',
    'DRIVER_CARE_MAX_FILE_BYTES',
    'DRIVER_CARE_MAX_TOTAL_BYTES',
  ] as const)('%s matches the shared contract', (key) => {
    expect(page[key]).toEqual(shared[key]);
  });

  it('follows the design’s serviceOrder, with no Apply to Drive or Pay Raise card', () => {
    expect(page.SERVICES.map((s) => s.name)).toEqual([
      'Refer a Driver',
      'Complaint & Feedback',
      'Reimbursement',
      'Pay & Statement Help',
      'Compliance',
      'Management Call Request',
    ]);
    expect(page.SERVICES.map((s) => s.topic)).toEqual(shared.DRIVER_RELATION_TOPICS);
  });

  it('every service posts something the server schema accepts', () => {
    const base = { submissionId: '00000000-0000-4000-8000-000000000000', website: '', name: 'Sam Driver', truckNumber: '303' };
    const samples: Record<string, Record<string, unknown>> = {
      referral: { referralName: 'Jamie West', referralPhone: '(312) 555-0142' },
      complaint_feedback: { phone: '(312) 555-0142', details: 'x' },
      reimbursement: { phone: '(312) 555-0142', amount: 85, loadNumber: null, details: 'x', attachments: [] },
      pay_statement: { phone: '(312) 555-0142', details: 'x', weekStart: null, loadNumber: null },
      compliance: { phone: '(312) 555-0142', subject: 'cdl', details: 'x' },
      management_call: { phone: '(312) 555-0142', callTopic: 'confidential', preferredTime: null, details: 'x' },
    };
    for (const s of page.SERVICES) {
      const parsed = shared.DriverCareSubmissionSchema.safeParse({ ...base, topic: s.topic, ...samples[s.topic] });
      expect(parsed.success, `${s.topic}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });
});
