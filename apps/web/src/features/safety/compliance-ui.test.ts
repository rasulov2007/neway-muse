import { describe, expect, it } from 'vitest';
import type { ComplianceDocument, EntityCompliance, EvaluatedItem } from '@neway/shared';
import { attentionGroupOf, groupOpenItems, pendingDocumentFor } from './compliance-ui';

/**
 * P1 #9: once a document is attached, the requirement is no longer "missing" - it is waiting on
 * safety. The needs-attention list splits by state so chasing and reviewing never share a bucket.
 */
function item(overrides: Partial<EvaluatedItem>): EvaluatedItem {
  return {
    itemId: 'qi_1',
    entityId: 'drv_1',
    requirementCode: 'cdl',
    requirementName: 'CDL',
    status: 'missing',
    severity: 'critical',
    requiredAction: 'Attach the CDL',
    owner: 'safety',
    notify: [],
    reasons: [],
    blocksDispatch: true,
    inGracePeriod: false,
    expiresOn: null,
    dueOn: null,
    ...overrides,
  } as EvaluatedItem;
}

function entity(items: EvaluatedItem[]): EntityCompliance {
  return { scope: 'driver', entityId: 'drv_1', items } as unknown as EntityCompliance;
}

function doc(overrides: Partial<ComplianceDocument>): ComplianceDocument {
  return {
    id: 'doc_1',
    ownerType: 'driver',
    ownerId: 'drv_1',
    requirementCode: 'cdl',
    status: 'pending_review',
    uploadedAt: '2026-09-16T10:00:00Z',
    ...overrides,
  } as ComplianceDocument;
}

describe('attentionGroupOf', () => {
  it('reads an attached, unreviewed item as pending, not missing', () => {
    expect(attentionGroupOf(item({ status: 'pending_verification', severity: 'warning' }))).toBe(
      'pending',
    );
    expect(attentionGroupOf(item({ status: 'missing' }))).toBe('missing');
  });

  it('puts expiring and expired items in their own groups, and leaves satisfied ones out', () => {
    expect(attentionGroupOf(item({ status: 'expiring' }))).toBe('expiring');
    expect(attentionGroupOf(item({ status: 'expired' }))).toBe('expired');
    expect(attentionGroupOf(item({ status: 'verified', requiredAction: null }))).toBeNull();
  });
});

describe('groupOpenItems', () => {
  it('groups with counts in reading order, leaving out empty groups', () => {
    const groups = groupOpenItems(
      entity([
        item({ requirementCode: 'mvr', requirementName: 'MVR', status: 'expired' }),
        item({ requirementCode: 'cdl', status: 'pending_verification', severity: 'warning' }),
        item({ requirementCode: 'medical_card', requirementName: 'Medical', status: 'missing' }),
        item({
          requirementCode: 'psp',
          requirementName: 'PSP',
          status: 'verified',
          requiredAction: null,
        }),
      ]),
    );
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ['Missing', 1],
      ['Pending verification', 1],
      ['Expired', 1],
    ]);
    // Pending loses the danger treatment; missing keeps it.
    expect(groups.find((g) => g.group === 'pending')?.tone).toBe('warning');
    expect(groups.find((g) => g.group === 'missing')?.tone).toBe('danger');
  });
});

describe('pendingDocumentFor', () => {
  it('finds the newest unreviewed document for the item, and nothing for a bare item', () => {
    const pending = item({ status: 'pending_verification' });
    const docs = [
      doc({ id: 'old', uploadedAt: '2026-09-01T10:00:00Z' }),
      doc({ id: 'new', uploadedAt: '2026-09-16T10:00:00Z' }),
      doc({ id: 'other', requirementCode: 'mvr' }),
      doc({ id: 'done', status: 'verified' }),
    ];
    expect(pendingDocumentFor(pending, docs)?.id).toBe('new');
    expect(pendingDocumentFor(item({ status: 'missing' }), [])).toBeNull();
  });
});
