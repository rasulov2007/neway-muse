import type { Href } from 'expo-router';

import type {
  DriverBreakdown,
  DriverCareRequest,
  DriverReferral,
  DriverReimbursement,
  DriverSafetyReport,
  DriverVacationRequestView,
} from '@/api/contract';
import { REIMBURSEMENT_CATEGORY_LABEL } from '@neway/shared/accounting/reimbursements';
import { t } from '@/i18n/core';
import { dayLabel, moneyCents } from '@/lib/format';

export type RequestKind = 'breakdown' | 'reimbursement' | 'care' | 'vacation' | 'safety_report' | 'referral';

export const REQUEST_KIND_LABEL: Record<RequestKind, string> = {
  breakdown: 'Breakdown',
  reimbursement: 'Reimbursement',
  care: 'Driver Care',
  vacation: 'Vacation',
  safety_report: 'Safety report',
  referral: 'Referral',
};

/** One line of "My requests", whatever record it is. */
export interface RequestEntry {
  kind: RequestKind;
  id: string;
  title: string;
  subtitle: string | null;
  status: string;
  statusLabel: string;
  responsible: string | null;
  lastUpdate: string;
  href: Href;
}

const detail = (kind: RequestKind, id: string): Href => `/driver/request/${kind}/${id}`;

export function fromBreakdown(b: DriverBreakdown): RequestEntry {
  return {
    kind: 'breakdown',
    id: b.id,
    title: t('Breakdown {number}', { number: b.number }),
    subtitle: [t(b.categoryLabel), b.truck ? t('Truck {unit}', { unit: b.truck.unitNumber }) : null].filter(Boolean).join(' · '),
    status: b.status,
    statusLabel: b.statusLabel,
    responsible: b.responsible?.name ?? null,
    lastUpdate: b.latestUpdate?.at ?? b.updatedAt,
    href: detail('breakdown', b.id),
  };
}

export function fromReimbursement(r: DriverReimbursement): RequestEntry {
  return {
    kind: 'reimbursement',
    id: r.id,
    title: t('Reimbursement {number}', { number: r.number }),
    subtitle: `${t(REIMBURSEMENT_CATEGORY_LABEL[r.category] ?? r.category)} · ${moneyCents(r.amountCents)}`,
    status: r.state,
    statusLabel: r.stateLabel,
    responsible: r.reviewer?.name ?? null,
    lastUpdate: r.lastUpdate,
    href: detail('reimbursement', r.id),
  };
}

export function fromCare(c: DriverCareRequest): RequestEntry {
  return {
    kind: 'care',
    id: c.id,
    title: `${t(c.topicLabel)} ${c.number}`,
    subtitle: c.message.slice(0, 80),
    status: c.state,
    statusLabel: c.stateLabel,
    responsible: t(c.teamLabel),
    lastUpdate: c.lastUpdate,
    href: detail('care', c.id),
  };
}

export function fromVacation(v: DriverVacationRequestView): RequestEntry {
  const last = [...v.steps].reverse().find((s) => s.at)?.at ?? v.createdAt;
  return {
    kind: 'vacation',
    id: v.id,
    title: t('Vacation request'),
    subtitle: `${dayLabel(v.from)} – ${dayLabel(v.to)}`,
    status: v.status,
    statusLabel: v.statusLabel,
    responsible: null,
    lastUpdate: last,
    href: '/driver/vacation',
  };
}

export function fromSafetyReport(s: DriverSafetyReport): RequestEntry {
  return {
    kind: 'safety_report',
    id: s.id,
    title: `${t(s.kindLabel)} ${s.reference}`,
    subtitle: s.description.slice(0, 80),
    status: s.status,
    statusLabel: s.statusLabel,
    responsible: t('Safety'),
    lastUpdate: s.createdAt,
    href: detail('safety_report', s.id),
  };
}

export function fromReferral(r: DriverReferral): RequestEntry {
  return {
    kind: 'referral',
    id: r.id,
    title: t('Referral · {name}', { name: r.name }),
    subtitle: r.number,
    status: r.stage,
    statusLabel: r.stageLabel,
    responsible: t('Recruiting'),
    lastUpdate: r.submittedAt,
    href: detail('referral', r.id),
  };
}
