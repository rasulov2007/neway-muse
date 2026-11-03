import { describe, expect, it } from 'vitest';
import { teamNameLookup, withTeamName } from './team-names';

const people = [
  { id: 'emp_1', firstName: 'Alexander', lastName: 'Petrov', preferredName: 'ALEX' },
  { id: 'emp_2', firstName: 'Samuel', lastName: 'Ortiz', preferredName: null },
  { id: 'emp_3', firstName: 'Mark', lastName: 'Lee', preferredName: '  ' },
];

describe('board team names (owner, 2026-10-26)', () => {
  it('an employee team shows the nickname, the full name for the tooltip', () => {
    const lookup = teamNameLookup(people, new Map());
    expect(lookup('emp_1')).toEqual({ nickname: 'ALEX', fullName: 'Alexander Petrov' });
  });

  it('an employee with no nickname keeps the stored name', () => {
    const lookup = teamNameLookup(people, new Map());
    expect(lookup('emp_2')).toEqual({ nickname: null, fullName: null });
    expect(lookup('emp_3')).toEqual({ nickname: null, fullName: null });
  });

  it('a two-person team linked through its split uses each nickname, else the first name', () => {
    const lookup = teamNameLookup(people, new Map([['team_alex_samuel', ['emp_1', 'emp_2']]]));
    expect(lookup('team_alex_samuel')).toEqual({ nickname: 'ALEX / Samuel', fullName: 'Alexander Petrov / Samuel Ortiz' });
  });

  it('a free-text team, or a split with an unlinked person, stays as typed', () => {
    const lookup = teamNameLookup(people, new Map([['team_x', ['emp_1', null]]]));
    expect(lookup('team_x')).toEqual({ nickname: null, fullName: null });
    expect(lookup('team_nobody')).toEqual({ nickname: null, fullName: null });
    expect(lookup('none:unassigned')).toEqual({ nickname: null, fullName: null });
  });

  it('decorates a row without touching the stored name', () => {
    const lookup = teamNameLookup(people, new Map());
    expect(withTeamName({ dispatcherId: 'emp_1', dispatcherName: 'ALEXANDER PETROV' }, lookup)).toEqual({
      dispatcherId: 'emp_1',
      dispatcherName: 'ALEXANDER PETROV',
      dispatcherNickname: 'ALEX',
      dispatcherFullName: 'Alexander Petrov',
      // No team order on a bare lookup, so no TEAM n badge.
      teamNumber: null,
    });
  });
});
