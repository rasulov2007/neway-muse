import { describe, expect, it } from 'vitest';
import { looksLikeTeam, parseTeamOrder, teamOrder, type KnownDispatcher } from './team-order';
import { compareTeams, teamNameLookup, withTeamName } from './team-names';

const roster: KnownDispatcher[] = [
  { dispatcherId: 'd_adam', dispatcherName: 'ARLO / MAXWELL' },
  { dispatcherId: 'emp_adin', dispatcherName: 'ADIN' },
  { dispatcherId: 'd_alex', dispatcherName: 'AXEL / SOREN' },
  { dispatcherId: 'd_bryan', dispatcherName: 'BRANT / MILO' },
  { dispatcherId: 'd_franklin', dispatcherName: 'FLINT / SILAS' },
  { dispatcherId: 'd_marshall', dispatcherName: 'MERRITT / LARS' },
  { dispatcherId: 'emp_matthew', dispatcherName: 'MATTHEW' },
  { dispatcherId: 'emp_max', dispatcherName: 'MAX' },
  { dispatcherId: 'd_michael', dispatcherName: 'MOSES / IVO' },
  { dispatcherId: 'd_tom', dispatcherName: 'TAVI / MAREK' },
];

const ownerOrder = {
  version: 1,
  teams: ['d_adam', 'd_alex', 'd_franklin', 'd_tom', 'd_michael', 'd_bryan', 'd_marshall'],
  solos: ['emp_matthew', 'emp_max', 'emp_adin'],
};

const board = (order: ReturnType<typeof teamOrder>) =>
  [...roster]
    .sort((a, b) => order.compare(a, b))
    .map((d) => {
      const n = order.placeOf(d.dispatcherId, d.dispatcherName).teamNumber;
      return n === null ? d.dispatcherName : `${d.dispatcherName} TEAM ${n}`;
    });

describe('team order and TEAM n badges (owner, 2026-10-26)', () => {
  it('a solo dispatcher is never a team, whatever its place in the alphabet', () => {
    const order = teamOrder(roster, null);
    expect(order.placeOf('emp_adin', 'ADIN').teamNumber).toBeNull();
    // Without a stored order: teams alphabetically, numbered 1.., then solos alphabetically.
    expect(board(order)).toEqual([
      'ARLO / MAXWELL TEAM 1',
      'AXEL / SOREN TEAM 2',
      'BRANT / MILO TEAM 3',
      'FLINT / SILAS TEAM 4',
      'MERRITT / LARS TEAM 5',
      'MOSES / IVO TEAM 6',
      'TAVI / MAREK TEAM 7',
      'ADIN',
      'MATTHEW',
      'MAX',
    ]);
  });

  it('the stored order is the owner list exactly', () => {
    expect(board(teamOrder(roster, ownerOrder))).toEqual([
      'ARLO / MAXWELL TEAM 1',
      'AXEL / SOREN TEAM 2',
      'FLINT / SILAS TEAM 3',
      'TAVI / MAREK TEAM 4',
      'MOSES / IVO TEAM 5',
      'BRANT / MILO TEAM 6',
      'MERRITT / LARS TEAM 7',
      'MATTHEW',
      'MAX',
      'ADIN',
    ]);
  });

  it('a team not in the stored list numbers on after the stored ones; a new solo goes after the stored solos', () => {
    const order = teamOrder(
      [
        ...roster,
        { dispatcherId: 'd_new', dispatcherName: 'ZED / YAN' },
        { dispatcherId: 'emp_amy', dispatcherName: 'AMY' },
      ],
      ownerOrder,
    );
    expect(order.placeOf('d_new', 'ZED / YAN').teamNumber).toBe(8);
    expect(order.placeOf('emp_amy', 'AMY').teamNumber).toBeNull();
    const sorted = [
      ...roster,
      { dispatcherId: 'd_new', dispatcherName: 'ZED / YAN' },
      { dispatcherId: 'emp_amy', dispatcherName: 'AMY' },
    ]
      .sort(order.compare)
      .map((d) => d.dispatcherId);
    expect(sorted.indexOf('d_new')).toBe(7);
    expect(sorted.at(-1)).toBe('emp_amy');
  });

  it('a stored solo stays solo even with a "/" in its name; Unassigned is last with no number', () => {
    const order = teamOrder(roster, { version: 2, teams: ['d_alex'], solos: ['d_adam'] });
    expect(order.placeOf('d_adam', 'ARLO / MAXWELL').teamNumber).toBeNull();
    expect(order.placeOf('d_alex', 'AXEL / SOREN').teamNumber).toBe(1);
    expect(order.placeOf('', '')).toEqual({ teamNumber: null, rank: 9000 });
    expect(order.placeOf('none:unassigned', 'Unassigned').teamNumber).toBeNull();
  });

  it('two people in the commission split make a team without a "/"', () => {
    expect(looksLikeTeam('RORY', null, 2)).toBe(true);
    expect(looksLikeTeam('RORY', 'RORY / BEAU', 0)).toBe(true);
    expect(looksLikeTeam('RORY', null, 1)).toBe(false);
  });

  it('a damaged stored value reads as no order', () => {
    expect(parseTeamOrder('{oops')).toBeNull();
    expect(
      parseTeamOrder(JSON.stringify({ version: 3, teams: ['a', 7, ''], solos: null })),
    ).toMatchObject({ version: 3, teams: ['a'], solos: [] });
  });

  it('withTeamName carries the number and compareTeams the order', () => {
    const lookup = teamNameLookup([], new Map());
    lookup.order = teamOrder(roster, ownerOrder);
    expect(
      withTeamName({ dispatcherId: 'd_tom', dispatcherName: 'TAVI / MAREK' }, lookup).teamNumber,
    ).toBe(4);
    expect(
      withTeamName({ dispatcherId: 'emp_adin', dispatcherName: 'ADIN' }, lookup).teamNumber,
    ).toBeNull();
    const rows = [
      { dispatcherId: 'emp_adin', dispatcherName: 'ADIN' },
      { dispatcherId: 'd_bryan', dispatcherName: 'BRANT / MILO' },
      { dispatcherId: 'd_adam', dispatcherName: 'ARLO / MAXWELL' },
    ];
    expect(rows.sort(compareTeams(lookup)).map((r) => r.dispatcherId)).toEqual([
      'd_adam',
      'd_bryan',
      'emp_adin',
    ]);
    // A bare lookup (no order) keeps the old name order and no number.
    const bare = teamNameLookup([], new Map());
    expect(withTeamName({ dispatcherId: 'd_tom' }, bare).teamNumber).toBeNull();
  });
});
