import { describe, expect, it } from 'vitest';
import { prefillFromBoardRow } from './DriverFileForRow';

describe('prefillFromBoardRow', () => {
  it('splits the board name, cleans the phone and carries the row id and dispatcher', () => {
    expect(prefillFromBoardRow({ id: 'dbr_1', name: 'XAVIER SUTTON', phone: '`3125550188', dispatcherId: 'emp_9' })).toEqual({
      firstName: 'Xavier',
      lastName: 'Sutton',
      phone: '3125550188',
      dispatcherId: 'emp_9',
      boardRowId: 'dbr_1',
    });
  });

  it('keeps middle names with the first name, drops the co-driver and the second number', () => {
    const p = prefillFromBoardRow({ id: 'dbr_2', name: "JEAN MARC O'NEIL // BOB RAY", phone: '555-010-9927 // 555-010-0983', dispatcherId: '' });
    expect(p.firstName).toBe('Jean Marc');
    expect(p.lastName).toBe("O'Neil");
    expect(p.phone).toBe('555-010-9927');
    expect(p.dispatcherId).toBeUndefined();
  });
});
