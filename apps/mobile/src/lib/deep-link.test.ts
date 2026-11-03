import { DEEP_LINK_TYPES } from '@neway/shared/mobile/notifications';

import { absoluteUrl } from './config';
import { hrefFor } from './deep-link';

describe('hrefFor (push and notification taps)', () => {
  it('opens every deep-link type the server sends, in both shells', () => {
    for (const type of DEEP_LINK_TYPES) {
      expect(hrefFor('driver', { type, id: 'x1', parentId: 'p1' })).not.toBeNull();
      expect(hrefFor('office', { type, id: 'x1', parentId: 'p1' })).not.toBeNull();
    }
  });

  it('opens the exact record the link names', () => {
    expect(hrefFor('driver', { type: 'load', id: 'ld_1' })).toBe('/driver/load/ld_1');
    expect(hrefFor('driver', { type: 'load_document', id: 'doc_1', parentId: 'ld_1' })).toBe('/driver/load/ld_1');
    expect(hrefFor('driver', { type: 'breakdown', id: 'bd_1' })).toBe('/driver/request/breakdown/bd_1');
    expect(hrefFor('driver', { type: 'conversation', id: 'cnv_1' })).toBe('/driver/conversation/cnv_1');
    expect(hrefFor('driver', { type: 'settlement', id: 'stm_1' })).toEqual({ pathname: '/driver/money', params: { statement: 'stm_1' } });
    expect(hrefFor('office', { type: 'breakdown', id: 'bd_1' })).toBe('/office/breakdown/bd_1');
    expect(hrefFor('office', { type: 'pti', id: 'pti_1' })).toEqual({ pathname: '/office/safety', params: { inspection: 'pti_1' } });
  });

  it('a document link without its load, or no target, opens nothing', () => {
    expect(hrefFor('driver', { type: 'load_document', id: 'doc_1' })).toBeNull();
    expect(hrefFor('office', null)).toBeNull();
  });
});

describe('absoluteUrl (signed file links)', () => {
  it('puts the API origin in front of a relative link and leaves absolute ones', () => {
    expect(absoluteUrl('/api/v1/files/signed?t=abc')).toBe('http://localhost:3200/api/v1/files/signed?t=abc');
    expect(absoluteUrl('https://cdn.example/x.jpg')).toBe('https://cdn.example/x.jpg');
  });
});
