import type { DriverRelationTopic } from '@neway/shared';

/*
 * The six Driver Care services, from the owner's approved design (Northwind Freight-Driver-Care.html,
 * 2026-10-06): names, descriptions and icons as designed, in the design's serviceOrder. Apply to
 * Drive and Pay Raise Request were removed by the owner and are not here.
 *
 * The option lists are the page's own copies (type-only imports keep the shared package and zod
 * off a driver's phone); forms.test.ts holds them equal to the server's contract.
 */

export const DRIVER_REFERRAL_BONUS_TEXT = '$900';

export const MANAGEMENT_CALL_TOPICS = ['general_support', 'dispatch_work', 'pay_settlement', 'confidential', 'other'] as const;
export const MANAGEMENT_CALL_TOPIC_LABELS = {
  general_support: 'General support',
  dispatch_work: 'Dispatch or work concern',
  pay_settlement: 'Pay or settlement concern',
  confidential: 'Confidential concern',
  other: 'Other',
} as const;

export const COMPLIANCE_SUBJECTS = ['cdl', 'medical_card', 'other'] as const;
export const COMPLIANCE_SUBJECT_LABELS = {
  cdl: 'CDL',
  medical_card: 'Medical card',
  other: 'Other document or safety question',
} as const;

export const DRIVER_CARE_MAX_FILES = 3;
export const DRIVER_CARE_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DRIVER_CARE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export interface Service {
  topic: DriverRelationTopic;
  /** The card title, as designed ("Refer a Driver" for the referral). */
  name: string;
  /** The form title. */
  title: string;
  desc: string;
  /** The eyebrow over the form: where the request goes. */
  route: string;
  icon: string;
}

export const SERVICES: Service[] = [
  {
    topic: 'referral',
    name: 'Refer a Driver',
    title: 'Refer a Driver',
    desc: 'Know someone ready for a fresh start? Introduce them to our team.',
    route: 'Driver Relations · HR Referrals',
    icon: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0112 0v2M19 8v6M16 11h6"/>',
  },
  {
    topic: 'complaint_feedback',
    name: 'Complaint & Feedback',
    title: 'Complaint & Feedback',
    desc: 'Share a concern or an idea. Help us make your experience better.',
    route: 'Driver Relations · Confidential',
    icon: '<path d="M4 4h16v12H9l-5 4zM8 8h8M8 12h5"/>',
  },
  {
    topic: 'reimbursement',
    name: 'Reimbursement',
    title: 'Reimbursement',
    desc: 'Request a reimbursement for a work expense you paid out of pocket.',
    route: 'Driver Relations',
    icon: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h3"/>',
  },
  {
    topic: 'pay_statement',
    name: 'Pay & Statement Help',
    title: 'Pay & Statement Help',
    desc: 'Ask about missing load pay, deductions, escrow, or your weekly statement.',
    route: 'Driver Relations',
    icon: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h3"/>',
  },
  {
    topic: 'compliance',
    name: 'Compliance',
    title: 'Compliance',
    desc: 'Get help with driver documents, renewals, or a safety requirement.',
    route: 'Driver Relations',
    icon: '<path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',
  },
  {
    topic: 'management_call',
    name: 'Management Call Request',
    title: 'Management Call Request',
    desc: 'Request a call from management to discuss a concern or get personal support.',
    route: 'Driver Relations',
    icon: '<path d="M5 3h4l2 5-3 2a15 15 0 006 6l2-3 5 2v4c-10 3-20-7-16-16z"/>',
  },
];
