import { describe, expect, it } from 'vitest';
import { matchMembersToTeams, type MatchableMember, type MatchableTeam } from './match-members.js';

const team = (key: string, name: string, managers: string[]): MatchableTeam => ({
  yahooTeamKey: key,
  name,
  managerNames: managers,
  leagueMemberId: null,
});

const member = (id: string, displayName: string): MatchableMember => ({
  leagueMemberId: id,
  displayName,
  yahooTeamKey: null,
});

describe('matchMembersToTeams', () => {
  it('pairs on manager nickname, which is what actually identifies a person', () => {
    const result = matchMembersToTeams(
      [
        team('nfl.l.1.t.10', 'To infinity and Bijan', ['Lopez']),
        team('nfl.l.1.t.5', 'Rated R Superstars', ['edge']),
      ],
      [member('m1', 'Lopez'), member('m2', 'Edge')],
    );

    expect(result.matches).toHaveLength(2);
    // Casing differs between Yahoo and the portal; that must not defeat it.
    expect(result.matches.find((m) => m.memberName === 'Edge')?.yahooTeamKey).toBe('nfl.l.1.t.5');
    expect(result.unmatchedTeams).toHaveLength(0);
  });

  it('ignores spacing and punctuation', () => {
    const result = matchMembersToTeams(
      [team('t.2', 'K-Pop Dinkel Hunters', ['De Haan Solo'])],
      [member('m1', 'Dehaan Solo')],
    );

    expect(result.matches[0]?.leagueMemberId).toBe('m1');
  });

  it('never matches on the fantasy team name', () => {
    /*
      Team names change mid-season and are nobody's actual name, so agreement
      between one and a member would be a coincidence. A wrong pairing credits
      one manager's scores to another — worse than asking.
    */
    const result = matchMembersToTeams(
      [team('t.3', 'Lopez', ['SomebodyElse'])],
      [member('m1', 'Lopez')],
    );

    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedTeams).toHaveLength(1);
  });

  it('refuses to guess when two members share a name', () => {
    const result = matchMembersToTeams(
      [team('t.4', 'Some Team', ['Kevin'])],
      [member('m1', 'Kevin'), member('m2', 'kevin')],
    );

    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedMembers).toHaveLength(2);
  });

  it('keeps Kevin and Kevyn apart, because they are two different people', () => {
    const result = matchMembersToTeams(
      [
        team('t.6', 'Saquon-qu-quon-quon-quon', ['Kevin']),
        team('t.8', 'Team Jason Burns', ['Kevyn']),
      ],
      [member('m1', 'Kevin'), member('m2', 'Kevyn')],
    );

    expect(result.matches).toHaveLength(2);
    expect(result.matches.find((m) => m.memberName === 'Kevin')?.yahooTeamKey).toBe('t.6');
    expect(result.matches.find((m) => m.memberName === 'Kevyn')?.yahooTeamKey).toBe('t.8');
  });

  it('leaves already-mapped teams and members alone', () => {
    const result = matchMembersToTeams(
      [{ ...team('t.9', 'Done', ['Carl']), leagueMemberId: 'm9' }],
      [{ ...member('m9', 'Carl'), yahooTeamKey: 't.9' }],
    );

    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedTeams).toHaveLength(0);
    expect(result.unmatchedMembers).toHaveLength(0);
  });

  it('reports who was left over, rather than silently dropping them', () => {
    const result = matchMembersToTeams(
      [team('t.1', 'A Team', ['Andrew'])],
      [member('m1', 'Andrew'), member('m2', 'SomebodyWhoLeft')],
    );

    expect(result.matches).toHaveLength(1);
    expect(result.unmatchedMembers.map((m) => m.displayName)).toEqual(['SomebodyWhoLeft']);
  });
});
