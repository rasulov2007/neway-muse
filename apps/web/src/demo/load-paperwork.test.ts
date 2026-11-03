import { afterEach, describe, expect, it, vi } from 'vitest';
// The scheduler is mocked so nothing here waits on a timer or touches the workspace snapshot.
const saveSoon = vi.hoisted(() => vi.fn());
vi.mock('./state-persist', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./state-persist')>()),
  saveSoon,
}));

import { demoData } from './data';
import { serveLoads } from '@/test/roster-server';
import {
  duplicateDocumentWarning,
  suggestionForLoadDocument,
  updateLoad,
  uploadLoadDocument,
} from './api';
import {
  DOCUMENTS_REQUIRED_FOR,
  isQualifyingDocument,
  missingDocumentsFor,
  qualifyingDocument,
} from './load-paperwork';
import type { Load, LoadDocument, LoadStatus } from './types';

/**
 * The rule under test is that a status is a claim, and a claim needs its paper.
 *
 * Every load here is built for the test and removed afterwards: the seeded book is what the rest
 * of the suite reads, and a test that leaves a delivered load behind it changes somebody else's
 * assertion three files away.
 */

let made = 0;
const created: string[] = [];

function doc(
  type: LoadDocument['type'],
  status: LoadDocument['status'] = 'verified',
): LoadDocument {
  return {
    id: `doc_fixture_${type}_${made}`,
    type,
    title: type,
    fileName: status === 'missing' ? `placeholder-${type}.pdf` : `${type}.pdf`,
    sizeBytes: status === 'missing' ? 0 : 2048,
    uploadedAt: status === 'missing' ? '2026-09-01T00:00:00.000Z' : '2026-09-01T00:00:00.000Z',
    uploadedBy: status === 'missing' ? '—' : 'Test',
    status,
  };
}

/** A load of this test's own, in the book only for as long as the test runs. */
function fixture(status: LoadStatus, documents: LoadDocument[]): Load {
  made += 1;
  const template = demoData.loads.find((l) => l.status === 'in_transit' && l.stops.length >= 2);
  if (!template) throw new Error('the demo book has no in-transit load to copy');
  const load: Load = structuredClone(template);
  load.id = `load_fixture_${made}`;
  load.loadNumber = `L-90000${made}`;
  load.status = status;
  load.documents = documents;
  load.timeline = [];
  load.deliveredAt = null;
  demoData.loads.push(load);
  serveLoads([load]);
  created.push(load.id);
  return load;
}

function live(id: string): Load {
  const load = demoData.loads.find((l) => l.id === id);
  if (!load) throw new Error('fixture went missing');
  return load;
}

const FILE = {
  fileName: 'signed.pdf',
  sizeBytes: 4096,
  mimeType: 'application/pdf',
  fileUrl: '/api/v1/files/file_test', fileId: 'file_test',
  uploadedBy: 'Test',
};

afterEach(() => {
  for (const id of created) {
    const index = demoData.loads.findIndex((l) => l.id === id);
    if (index >= 0) demoData.loads.splice(index, 1);
  }
  created.length = 0;
  saveSoon.mockClear();
});

describe('what counts as a document on file', () => {
  it('accepts a filed document, and legacy paperwork that never carried its bytes', () => {
    const legacy = doc('rate_confirmation');
    delete legacy.dataUrl;
    expect(isQualifyingDocument(legacy)).toBe(true);
  });

  it('refuses a placeholder, an unverified upload and an empty record', () => {
    expect(isQualifyingDocument(doc('pod', 'missing'))).toBe(false);
    expect(isQualifyingDocument(doc('pod', 'pending'))).toBe(false);
    // A person's upload counts the moment it is received; verified is their word about it.
    expect(isQualifyingDocument({ ...doc('pod', 'pending'), review: 'received' })).toBe(true);
    expect(isQualifyingDocument({ ...doc('pod'), fileName: '  ' })).toBe(false);
    expect(isQualifyingDocument({ ...doc('pod'), uploadedAt: '' })).toBe(false);
  });

  it('asks for nothing on the way out of a load that never ran', () => {
    expect(DOCUMENTS_REQUIRED_FOR.cancelled).toEqual([]);
    expect(DOCUMENTS_REQUIRED_FOR.tonu).toEqual([]);
  });

  it('names what is missing at each milestone', () => {
    const bare = fixture('booked', []);
    expect(missingDocumentsFor(bare, 'assigned')).toEqual(['rate_confirmation']);
    expect(missingDocumentsFor(bare, 'loaded')).toEqual(['rate_confirmation', 'bol']);
    expect(missingDocumentsFor(bare, 'delivered')).toEqual(['rate_confirmation', 'bol', 'pod']);
    expect(missingDocumentsFor(bare, 'cancelled')).toEqual([]);
  });
});

/**
 * The paperwork gate moved to the server with the status itself (P1): the rule and its tests now
 * live in `@neway/shared` `loads/progress`, where the board and the load page both read it. What
 * is still this layer's business is that the old door is shut.
 */
describe('the browser cannot write a status any more', () => {
  it('refuses a status change and names the endpoint that owns it', async () => {
    const load = fixture('in_transit', [doc('rate_confirmation'), doc('bol')]);
    await expect(updateLoad({ loadId: load.id, status: 'delivered' })).rejects.toThrow(
      /POST \/loads\/:id\/status/,
    );
  });

  it('refuses an assignment the same way', async () => {
    const load = fixture('booked', []);
    await expect(updateLoad({ loadId: load.id, driverId: 'drv_1' })).rejects.toThrow(
      /POST \/loads\/:id\/assignment/,
    );
  });
});

describe('paperwork that arrives (P0.5: uploads suggest, people confirm)', () => {
  it('files the document as received and moves nothing - not the status, the stops, the problem or the dispatch time', async () => {
    const load = fixture('in_transit', [doc('rate_confirmation'), doc('bol')]);
    const before = structuredClone(live(load.id));
    before.exception = { code: 'problem', reason: 'Late', raisedAt: '2026-09-05T12:00:00.000Z' };
    live(load.id).exception = before.exception;

    const updated = await uploadLoadDocument({ loadId: load.id, type: 'pod', ...FILE });

    expect(updated.status).toBe('in_transit');
    expect(updated.stops.map((s) => s.status)).toEqual(before.stops.map((s) => s.status));
    expect(updated.exception).toEqual(before.exception);
    expect(updated.dispatchedAt).toBe(before.dispatchedAt);
    expect(updated.deliveredAt).toBeNull();
    const pod = qualifyingDocument(updated, 'pod');
    expect(pod?.fileName).toBe('signed.pdf');
    expect(pod).toMatchObject({ status: 'pending', review: 'received', verifiedBy: null });
    expect(updated.timeline.at(-1)).toMatchObject({ kind: 'document_uploaded' });
    // The document is on the load the store holds, and it is asked to be kept.
    expect(qualifyingDocument(live(load.id), 'pod')).not.toBeNull();
    // The browser never saves the loads collection any more: the write was the server's (1.11).
    expect(saveSoon).not.toHaveBeenCalled();
  });

  it('suggests what the paperwork means, in the stop clock, and only where it makes sense', async () => {
    const load = fixture('at_pickup', [doc('rate_confirmation')]);
    const pickup = live(load.id).stops[0]!;
    pickup.status = 'in_progress';
    pickup.arrivedAt = '2026-09-05T12:52:00.000Z';
    pickup.timezone = 'America/Chicago';

    const bol = suggestionForLoadDocument(live(load.id), 'bol');
    expect(bol).toMatchObject({ kind: 'mark_loaded', stopId: pickup.id, at: pickup.arrivedAt, prompt: 'Mark loaded at 7:52 AM CDT?' });
    expect(suggestionForLoadDocument(live(load.id), 'rate_confirmation')).toBeNull();
    expect(suggestionForLoadDocument(fixture('delivered', []), 'pod')).toBeNull();
  });

  it('a status confirmed afterwards still stands on the paperwork', async () => {
    const load = fixture('unloading', [doc('rate_confirmation'), doc('bol')]);

    await uploadLoadDocument({ loadId: load.id, type: 'pod', ...FILE });
    expect(live(load.id).status).toBe('unloading');

    // Moving it to delivered is the server's call now (POST /loads/:id/status); what this layer
    // still owes is that the POD is on file and the load has not moved by itself.
    expect(live(load.id).documents.some((d) => d.type === 'pod' && d.status !== 'missing')).toBe(true);
    expect(live(load.id).status).toBe('unloading');
  });

  it('warns when the same file is filed under a second type', async () => {
    const load = fixture('in_transit', [doc('rate_confirmation'), doc('bol')]);
    await uploadLoadDocument({ loadId: load.id, type: 'bol', ...FILE, fileHash: 'abc' });

    expect(duplicateDocumentWarning(live(load.id), { type: 'pod', fileName: 'other.pdf', fileHash: 'abc' })?.match).toBe('hash');
    expect(duplicateDocumentWarning(live(load.id), { type: 'pod', fileName: 'signed.pdf' })?.match).toBe('fileName');
    expect(duplicateDocumentWarning(live(load.id), { type: 'bol', fileName: 'signed.pdf', fileHash: 'abc' })).toBeNull();
  });
});
