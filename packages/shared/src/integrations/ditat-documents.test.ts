import { describe, expect, it } from 'vitest';
import {
  dayOf,
  planDocuments,
  type DitatDocumentRow,
  type DocumentOwner,
  type ExistingDocument,
} from './ditat-documents.js';

function doc(over: Partial<DitatDocumentRow> = {}): DitatDocumentRow {
  return {
    documentKey: '22771',
    fileName: 'annual inspection 2026',
    documentFolderId: 'DOT Inspections',
    expireOn: '2027-03-01T00:00:00.000Z',
    documentCreatedOn: '2026-03-01T01:30:46.630Z',
    fileSize: 38505,
    ...over,
  };
}

function owner(over: Partial<DocumentOwner> = {}): DocumentOwner {
  return { externalId: '2785', id: 'trk_2785', label: 'Unit 2785', documents: [doc()], ...over };
}

describe('what it files', () => {
  it('files a DOT inspection against the unit, with its dates', () => {
    const [r] = planDocuments('truck', [owner()], []).rows;
    expect(r?.outcome).toBe('create');
    expect(r).toMatchObject({
      ownerId: 'trk_2785',
      requirementCode: 'annual_inspection',
      issuedOn: '2026-03-01',
      expiresOn: '2027-03-01',
      externalId: '22771',
    });
  });

  it('leaves a document with no expiry without one, rather than calling it expired', () => {
    const r = planDocuments('truck', [owner({ documents: [doc({ expireOn: null })] })], []).rows[0];
    expect(r?.outcome).toBe('create');
    expect(r?.expiresOn).toBeNull();
  });
});

describe('what it will not file', () => {
  it('reports a folder this product has no document type for, and writes nothing', () => {
    const repairs = doc({ documentKey: '9', documentFolderId: 'Repairs', fileName: '$1,054.78, tyre' });
    const plan = planDocuments('truck', [owner({ documents: [repairs] })], []);
    expect(plan.counts.review).toBe(1);
    expect(plan.counts.create).toBe(0);
    expect(plan.rows[0]?.requirementCode).toBeNull();
    expect(plan.rows[0]?.note).toContain('Repairs');
  });

  it('refuses a document whose unit is not on this fleet', () => {
    const plan = planDocuments('truck', [owner({ id: null, label: 'Unit 9999' })], []);
    expect(plan.counts.skip).toBe(1);
    expect(Object.keys(plan.skippedBy).join(' ')).toContain('not on this fleet');
  });

  it('takes a document with no key no further', () => {
    const plan = planDocuments('truck', [owner({ documents: [doc({ documentKey: '' })] })], []);
    expect(plan.counts.skip).toBe(1);
  });
});

describe('the second run', () => {
  it('files nothing twice', () => {
    const existing: ExistingDocument[] = [
      { id: 'doc_1', ownerType: 'truck', ownerId: 'trk_2785', externalId: '22771', sourceSystem: 'ditat' },
    ];
    const plan = planDocuments('truck', [owner()], existing);
    expect(plan.counts.unchanged).toBe(1);
    expect(plan.counts.create).toBe(0);
  });

  it('is not fooled by a document somebody uploaded here with the same number', () => {
    const existing: ExistingDocument[] = [
      { id: 'doc_1', ownerType: 'truck', ownerId: 'trk_2785', externalId: '22771', sourceSystem: null },
    ];
    expect(planDocuments('truck', [owner()], existing).counts.create).toBe(1);
  });
});

describe('the day a document carries', () => {
  it('reads an instant down to its calendar day, and refuses anything else', () => {
    expect(dayOf('2026-03-01T01:30:46.630Z')).toBe('2026-03-01');
    expect(dayOf('2026-03-01')).toBe('2026-03-01');
    expect(dayOf('')).toBeNull();
    expect(dayOf('whenever')).toBeNull();
  });
});
