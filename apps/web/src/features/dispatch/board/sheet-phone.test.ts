import { describe, expect, it } from 'vitest';
import { phoneParts } from './sheet';

const tels = (text: string) => phoneParts(text).filter((p) => p.kind === 'tel').map((p) => p.value);

describe('the phone cell', () => {
  it('reads one number', () => {
    expect(tels('555-010-9927')).toEqual(['555-010-9927']);
    expect(tels('555 010 3479')).toEqual(['555 010 3479']);
  });

  it('reads two numbers, however they are separated', () => {
    for (const text of ['555-010-9927 // 555-010-0983', '555-010-9927/555-010-0983', '555-010-9927, 555-010-0983', '555-010-9927 555-010-0983']) {
      expect(tels(text)).toEqual(['555-010-9927', '555-010-0983']);
    }
    expect(tels('555 010 3479 555-010-4923')).toEqual(['555 010 3479', '555-010-4923']);
  });

  it('keeps a word that is not a number as text', () => {
    expect(phoneParts('555-010-9927 // wife').map((p) => p.kind)).toEqual(['tel', 'sep', 'text']);
  });
});
