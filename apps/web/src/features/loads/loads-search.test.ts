import { describe, expect, it } from 'vitest';
import { demoData } from '@/demo';
import { matchesView } from './loads-search';

/** A delivered load with its POD on file and no invoice yet: ready to bill on its own. */
function billable() {
  const seed = structuredClone(demoData.loads[0]!);
  seed.status = 'delivered';
  seed.invoiceId = null;
  seed.documents = seed.documents.filter((d) => d.type !== 'pod');
  seed.documents.push({
    ...structuredClone(seed.documents[0]!),
    id: 'doc_pod_test',
    type: 'pod',
    title: 'Proof of delivery',
    status: 'pending',
  });
  return seed;
}

describe('Ready to bill', () => {
  it('lists a delivered load with its POD on file', () => {
    expect(matchesView('ready_to_bill', billable(), 'on_track', 'on_time', { flagged: false })).toBe(true);
  });

  it('holds the invoice while a flag is open on the load (rule 1.10)', () => {
    expect(matchesView('ready_to_bill', billable(), 'on_track', 'on_time', { flagged: true })).toBe(false);
  });

  it('shows the same load under Flagged instead', () => {
    expect(matchesView('flagged', billable(), 'on_track', 'on_time', { flagged: true })).toBe(true);
  });
});
