import { describe, expect, it } from 'vitest';
import { billingVerdict, type BillableLoad } from '../accounting/billing.js';
import { DRIVER_MEMBERSHIP_PERMISSIONS, SYSTEM_ROLES } from '../admin/permissions.js';
import { DRIVER_DOCUMENT_STATE_LABEL, driverDocumentState, driverLoadScopeOf, driverPtiState, phoneLogin } from './index.js';

describe('driver app status words', () => {
  it('maps the TMS review onto what the driver reads', () => {
    expect(DRIVER_DOCUMENT_STATE_LABEL[driverDocumentState({ review: 'received' })]).toBe('Received by TMS · Needs review');
    expect(driverDocumentState({ review: 'reviewed' })).toBe('reviewed');
    expect(driverDocumentState({ review: 'verified' })).toBe('reviewed');
    expect(DRIVER_DOCUMENT_STATE_LABEL[driverDocumentState({ review: 'rejected' })]).toBe('Correction requested');
    expect(driverDocumentState({ review: 'rejected', supersededBy: 'doc_2' })).toBe('replaced');
  });

  it('says where a PTI stands, the correction first', () => {
    expect(driverPtiState({ receivedAt: null, reviewState: 'unreviewed' })).toBe('not_submitted');
    expect(driverPtiState({ receivedAt: '2026-10-27T10:00:00Z', reviewState: 'unreviewed' })).toBe('received');
    expect(driverPtiState({ receivedAt: '2026-10-27T10:00:00Z', reviewState: 'reviewed' })).toBe('reviewed');
    expect(driverPtiState({ receivedAt: null, reviewState: 'unreviewed', correction: { requestedAt: 'x', requestedBy: 'S', reason: 'dark', answeredAt: null } })).toBe('correction_requested');
  });

  it('puts loads in the scope a driver thinks in, and cancelled ones nowhere', () => {
    expect(driverLoadScopeOf('in_transit')).toBe('active');
    expect(driverLoadScopeOf('assigned')).toBe('upcoming');
    expect(driverLoadScopeOf('delivered')).toBe('completed');
    expect(driverLoadScopeOf('cancelled')).toBeNull();
  });

  it('files a phone login under the digits', () => {
    expect(phoneLogin('+1 (555) 123-4567')).toBe('5551234567@phone.neway');
    expect(phoneLogin('12')).toBeNull();
  });

  it('gives the driver role the driver-app code and nothing else', () => {
    const role = SYSTEM_ROLES.find((r) => r.code === 'driver');
    expect(role?.permissions).toEqual([...DRIVER_MEMBERSHIP_PERMISSIONS]);
  });
});

describe('billing and driver-app paperwork', () => {
  const load = (review: string, source: string | null): BillableLoad => ({
    id: 'ld_1',
    loadNumber: 'L-1',
    status: 'delivered',
    brokerReference: 'R1',
    customerId: null,
    brokerId: null,
    customerName: 'C',
    brokerName: null,
    rate: 1000,
    documents: [
      { id: 'rc', type: 'rate_confirmation', status: 'verified', review: 'verified', uploadedAt: '2026-10-20T00:00:00Z', fileHash: 'h1' },
      { id: 'pod', type: 'pod', status: 'pending', review, source, uploadedAt: '2026-10-21T00:00:00Z' },
    ],
    charges: [],
    stops: [{ kind: 'delivery', status: 'completed' }],
    updatedAt: '2026-10-21T00:00:00Z',
  });
  const ctx = { invoices: [], hashesElsewhere: () => [], resolvedExceptions: () => [] };

  it('holds an unreviewed driver-app POD in Needs review; an office upload bills as before', () => {
    const fromApp = billingVerdict(load('received', 'driver_app'), ctx as never);
    expect(fromApp.queue).toBe('needs_review');
    expect(fromApp.conditions.map((c) => c.code)).toContain('driver_document_unreviewed');
    expect(billingVerdict(load('reviewed', 'driver_app'), ctx as never).queue).toBe('ready_to_bill');
    expect(billingVerdict(load('received', null), ctx as never).queue).toBe('ready_to_bill');
  });
});
