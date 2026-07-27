import { describe, expect, it } from 'vitest';
import type {
  InternalId,
  WeeklyChallengeDefinition,
  WeeklyChallengeResult,
  YahooCapabilityKey,
} from '@dinkel/shared';
import {
  assertCanFinalize,
  assertCanOverride,
  calculateChallenge,
  CALCULATOR_TYPES,
  CHALLENGE_PROPOSALS,
  decideRecalculation,
  findProposal,
  proposalToDefinition,
  type PlayerWeek,
  type TeamWeek,
  type WeekInput,
} from './index.js';

const id = (value: string): InternalId => value as InternalId;

const ALL_VERIFIED = (): boolean => true;
const NONE_VERIFIED = (): boolean => false;

/** Builds a definition from a proposal, with everything verified. */
function definition(
  slug: string,
  overrides: Partial<WeeklyChallengeDefinition> = {},
): WeeklyChallengeDefinition {
  const proposal = findProposal(slug);
  if (!proposal) throw new Error(`no proposal ${slug}`);
  const derived = proposalToDefinition(proposal, { isCapabilityVerified: ALL_VERIFIED });

  return {
    entity: 'WeeklyChallengeDefinition',
    challengeDefinitionId: id('DEF'),
    leagueId: id('LEAGUE'),
    seasonYear: 2026,
    createdAt: '2026-07-26T00:00:00',
    createdBy: id('USER'),
    updatedAt: '2026-07-26T00:00:00',
    updatedBy: id('USER'),
    version: 1,
    ...derived,
    ...overrides,
  } as WeeklyChallengeDefinition;
}

function player(overrides: Partial<PlayerWeek> & { playerName: string }): PlayerWeek {
  return {
    playerKey: `p.${overrides.playerName}`,
    selectedPosition: 'WR',
    position: 'WR',
    ...overrides,
  };
}

function team(memberId: string, overrides: Partial<TeamWeek> = {}): TeamWeek {
  return {
    leagueMemberId: id(memberId),
    players: [],
    ...overrides,
  };
}

const week = (teams: TeamWeek[]): WeekInput => ({ seasonYear: 2026, week: 3, teams });

describe('capability gating', () => {
  it('blocks a challenge whose Yahoo data is unverified, rather than guessing', () => {
    const result = calculateChallenge(definition('one-man-army'), week([team('M1')]), {
      isCapabilityVerified: NONE_VERIFIED,
    });

    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.missingCapabilities).toContain('player_week_points');
      expect(result.reason).toContain('not been verified');
    }
  });

  it('names every missing capability, so the gap is actionable', () => {
    const verified = (capability: YahooCapabilityKey): boolean =>
      capability === 'roster_selected_position';

    const result = calculateChallenge(definition('one-man-army'), week([team('M1')]), {
      isCapabilityVerified: verified,
    });

    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.missingCapabilities).toEqual(['player_week_points']);
    }
  });

  it('blocks a definition explicitly marked blocked', () => {
    const blocked = definition('one-man-army', {
      status: 'blocked',
      blockedReason: 'Waiting on a real league.',
    });

    const result = calculateChallenge(blocked, week([team('M1')]), {
      isCapabilityVerified: ALL_VERIFIED,
    });

    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.reason).toBe('Waiting on a real league.');
  });

  it('does not calculate a draft or retired definition', () => {
    for (const status of ['draft', 'retired'] as const) {
      const result = calculateChallenge(
        definition('one-man-army', { status }),
        week([team('M1')]),
        {
          isCapabilityVerified: ALL_VERIFIED,
        },
      );
      expect(result.blocked).toBe(true);
    }
  });

  it('does not calculate a week the challenge does not run in', () => {
    const result = calculateChallenge(
      definition('one-man-army', { weeks: [1, 2] }),
      week([team('M1')]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.reason).toContain('week 3');
  });
});

describe('One Man Army', () => {
  it('finds the highest-scoring starter across the league', () => {
    const result = calculateChallenge(
      definition('one-man-army'),
      week([
        team('M1', {
          players: [
            player({ playerName: 'Alpha', points: 22.4 }),
            player({ playerName: 'Beta', points: 9.1 }),
          ],
        }),
        team('M2', { players: [player({ playerName: 'Gamma', points: 31.7 })] }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    expect(result.blocked).toBe(false);
    if (result.blocked) return;

    expect(result.winningLeagueMemberIds).toEqual([id('M2')]);
    expect(result.winningValue).toBe(31.7);
    expect(result.explanation).toContain('Gamma');
    expect(result.explanation).toContain('31.7');
  });

  it('ignores bench players when the definition excludes them', () => {
    const result = calculateChallenge(
      definition('one-man-army'),
      week([
        team('M1', { players: [player({ playerName: 'Starter', points: 15 })] }),
        team('M2', {
          players: [
            player({ playerName: 'Benched', points: 40, selectedPosition: 'BN' }),
            player({ playerName: 'Weak', points: 3 }),
          ],
        }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    // A bench player scoring 40 was never a lineup decision.
    expect(result.winningLeagueMemberIds).toEqual([id('M1')]);
  });

  it('excludes a player who did not play from winning with a zero', () => {
    const result = calculateChallenge(
      definition('one-man-army'),
      week([
        team('M1', { players: [player({ playerName: 'DidNotPlay' })] }),
        team('M2', { players: [player({ playerName: 'Played', points: 0 })] }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    // Undefined points is "no data", which is different from a real 0.
    expect(result.winningLeagueMemberIds).toEqual([id('M2')]);
    expect(result.winningValue).toBe(0);
  });
});

describe('Bench Mob', () => {
  it('sums bench points and names the top contributors', () => {
    const result = calculateChallenge(
      definition('bench-mob'),
      week([
        team('M1', {
          players: [
            player({ playerName: 'Starter', points: 30 }),
            player({ playerName: 'Bench1', points: 12.4, selectedPosition: 'BN' }),
            player({ playerName: 'Bench2', points: 9.8, selectedPosition: 'BN' }),
          ],
        }),
        team('M2', {
          players: [player({ playerName: 'Bench3', points: 8, selectedPosition: 'BN' })],
        }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningLeagueMemberIds).toEqual([id('M1')]);
    expect(result.winningValue).toBe(22.2);
    expect(result.explanation).toContain('Bench1');
  });

  it('counts injured reserve as bench, since those points were also not in the lineup', () => {
    const result = calculateChallenge(
      definition('bench-mob'),
      week([
        team('M1', {
          players: [player({ playerName: 'OnIR', points: 25, selectedPosition: 'IR' })],
        }),
        team('M2', {
          players: [player({ playerName: 'Bench', points: 20, selectedPosition: 'BN' })],
        }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningLeagueMemberIds).toEqual([id('M1')]);
  });

  it('excludes negatives so a bad defense does not shrink the total', () => {
    const result = calculateChallenge(
      definition('bench-mob'),
      week([
        team('M1', {
          players: [
            player({ playerName: 'Good', points: 20, selectedPosition: 'BN' }),
            player({ playerName: 'Awful', points: -4, selectedPosition: 'BN' }),
          ],
        }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningValue).toBe(20);
  });

  it('avoids floating-point drift when summing tenths', () => {
    // 0.1 + 0.2 in binary floating point is 0.30000000000000004, which would
    // lose a tie comparison it should have won.
    const result = calculateChallenge(
      definition('bench-mob'),
      week([
        team('M1', {
          players: [
            player({ playerName: 'A', points: 0.1, selectedPosition: 'BN' }),
            player({ playerName: 'B', points: 0.2, selectedPosition: 'BN' }),
          ],
        }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningValue).toBe(0.3);
  });
});

describe('Photo Finish', () => {
  it('finds the narrowest margin', () => {
    const result = calculateChallenge(
      definition('photo-finish', { tieBreakers: ['higher_team_points'] }),
      week([
        team('M1', { teamPoints: 100, opponentPoints: 90, outcome: 'win', priorWins: 1 }),
        team('M2', { teamPoints: 90, opponentPoints: 100, outcome: 'loss', priorWins: 1 }),
        team('M3', { teamPoints: 120.5, opponentPoints: 120.2, outcome: 'win', priorWins: 1 }),
        team('M4', { teamPoints: 120.2, opponentPoints: 120.5, outcome: 'loss', priorWins: 1 }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    // Both teams in the closest game tie at 0.3; higher score breaks it.
    expect(result.winningLeagueMemberIds).toEqual([id('M3')]);
    expect(result.winningValue).toBe(0.3);
    expect(result.wasTied).toBe(true);
    expect(result.appliedTieBreaker).toBe('higher_team_points');
  });

  it('can be configured so the loser of the closest game wins instead', () => {
    // Whether the winner or the loser takes Photo Finish is a league policy
    // question, answered by configuration rather than code.
    const result = calculateChallenge(
      definition('photo-finish', { tieBreakers: ['lower_team_points'] }),
      week([
        team('M3', { teamPoints: 120.5, opponentPoints: 120.2, outcome: 'win' }),
        team('M4', { teamPoints: 120.2, opponentPoints: 120.5, outcome: 'loss' }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningLeagueMemberIds).toEqual([id('M4')]);
  });

  it('excludes a team with no matchup data', () => {
    const result = calculateChallenge(
      definition('photo-finish'),
      week([
        team('M1', { teamPoints: 100 }),
        team('M2', { teamPoints: 95, opponentPoints: 94, outcome: 'win' }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningLeagueMemberIds).toEqual([id('M2')]);

    const excluded = result.standings.find((s) => s.leagueMemberId === id('M1'));
    expect(excluded?.eligible).toBe(false);
    expect(excluded?.ineligibleReason).toBe('no_matchup');
  });
});

describe('Bad Beat', () => {
  it('finds the highest score that lost', () => {
    const result = calculateChallenge(
      definition('bad-beat'),
      week([
        team('M1', { teamPoints: 150, opponentPoints: 151, outcome: 'loss' }),
        team('M2', { teamPoints: 160, opponentPoints: 100, outcome: 'win' }),
        team('M3', { teamPoints: 140, opponentPoints: 145, outcome: 'loss' }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    // The 160 won, so it is not eligible however high it is.
    expect(result.winningLeagueMemberIds).toEqual([id('M1')]);
    expect(result.winningValue).toBe(150);
  });

  it('excludes ties, which are not losses', () => {
    const result = calculateChallenge(
      definition('bad-beat'),
      week([
        team('M1', { teamPoints: 150, opponentPoints: 150, outcome: 'tie' }),
        team('M2', { teamPoints: 100, opponentPoints: 101, outcome: 'loss' }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningLeagueMemberIds).toEqual([id('M2')]);
  });

  it('reports not calculable when nobody lost', () => {
    const result = calculateChallenge(
      definition('bad-beat'),
      week([team('M1', { teamPoints: 150, opponentPoints: 100, outcome: 'win' })]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningLeagueMemberIds).toEqual([]);
    expect(result.notCalculableReason).toBe('no_eligible_competitors');
  });
});

describe('Ground and Pound and other position groups', () => {
  it('sums only the requested position, including flex slots', () => {
    const result = calculateChallenge(
      definition('ground-and-pound'),
      week([
        team('M1', {
          players: [
            player({ playerName: 'RB1', position: 'RB', selectedPosition: 'RB', points: 14 }),
            player({ playerName: 'FlexRB', position: 'RB', selectedPosition: 'W/R/T', points: 11 }),
            player({ playerName: 'WR1', position: 'WR', selectedPosition: 'WR', points: 30 }),
          ],
        }),
        team('M2', {
          players: [
            player({ playerName: 'RB2', position: 'RB', selectedPosition: 'RB', points: 24 }),
          ],
        }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    // 14 + 11 = 25 from running backs; the 30-point receiver does not count.
    expect(result.winningLeagueMemberIds).toEqual([id('M1')]);
    expect(result.winningValue).toBe(25);
  });

  it('accepts several defense position codes, since Yahoo’s exact code is unverified', () => {
    const result = calculateChallenge(
      definition('defense-wins-championships'),
      week([
        team('M1', { players: [player({ playerName: 'D1', position: 'DEF', points: 12 })] }),
        team('M2', { players: [player({ playerName: 'D2', position: 'D/ST', points: 18 })] }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningLeagueMemberIds).toEqual([id('M2')]);
  });

  it('counts a negative defense score, because it really happened', () => {
    const result = calculateChallenge(
      definition('defense-wins-championships'),
      week([
        team('M1', { players: [player({ playerName: 'Bad', position: 'DEF', points: -3 })] }),
        team('M2', { players: [player({ playerName: 'Worse', position: 'DEF', points: -6 })] }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningLeagueMemberIds).toEqual([id('M1')]);
    expect(result.winningValue).toBe(-3);
  });

  it('excludes a team with nobody at the position', () => {
    const result = calculateChallenge(
      definition('tight-end-day'),
      week([
        team('M1', { players: [player({ playerName: 'WR', position: 'WR', points: 30 })] }),
        team('M2', { players: [player({ playerName: 'TE', position: 'TE', points: 8 })] }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningLeagueMemberIds).toEqual([id('M2')]);
    expect(result.standings.find((s) => s.leagueMemberId === id('M1'))?.ineligibleReason).toBe(
      'no_players_at_position',
    );
  });
});

describe('Blackjack', () => {
  it('wins with the closest score at or under 21', () => {
    const result = calculateChallenge(
      definition('blackjack'),
      week([
        team('M1', { players: [player({ playerName: 'A', points: 19.8 })] }),
        team('M2', { players: [player({ playerName: 'B', points: 20.6 })] }),
        team('M3', { players: [player({ playerName: 'C', points: 12 })] }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningLeagueMemberIds).toEqual([id('M2')]);
    expect(result.winningValue).toBe(0.4);
  });

  it('busts a team whose only players went over, rather than penalizing them', () => {
    const result = calculateChallenge(
      definition('blackjack'),
      week([
        team('M1', { players: [player({ playerName: 'Over', points: 21.1 })] }),
        team('M2', { players: [player({ playerName: 'Under', points: 5 })] }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    // Busting disqualifies — that is what makes it blackjack.
    expect(result.winningLeagueMemberIds).toEqual([id('M2')]);
    expect(result.standings.find((s) => s.leagueMemberId === id('M1'))?.ineligibleReason).toBe(
      'busted',
    );
  });

  it('treats exactly 21 as a perfect score', () => {
    const result = calculateChallenge(
      definition('blackjack'),
      week([
        team('M1', { players: [player({ playerName: 'Exact', points: 21 })] }),
        team('M2', { players: [player({ playerName: 'Close', points: 20.9 })] }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningLeagueMemberIds).toEqual([id('M1')]);
    expect(result.winningValue).toBe(0);
  });

  it('picks the best qualifying player when a roster has both busts and hits', () => {
    const result = calculateChallenge(
      definition('blackjack'),
      week([
        team('M1', {
          players: [
            player({ playerName: 'Bust', points: 45 }),
            player({ playerName: 'Good', points: 20.5 }),
            player({ playerName: 'Low', points: 2 }),
          ],
        }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningValue).toBe(0.5);
    expect(result.explanation).toContain('Good');
  });
});

describe('ties', () => {
  it('splits the prize when configured to', () => {
    const result = calculateChallenge(
      definition('bench-mob', { tieBreakers: ['split_prize'] }),
      week([
        team('M1', { players: [player({ playerName: 'A', points: 10, selectedPosition: 'BN' })] }),
        team('M2', { players: [player({ playerName: 'B', points: 10, selectedPosition: 'BN' })] }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningLeagueMemberIds).toHaveLength(2);
    expect(result.appliedTieBreaker).toBe('split_prize');
    expect(result.explanation).toContain('split');
  });

  it('escalates to the commissioner rather than inventing a winner', () => {
    const result = calculateChallenge(
      definition('bench-mob', { tieBreakers: ['commissioner_decides'] }),
      week([
        team('M1', { players: [player({ playerName: 'A', points: 10, selectedPosition: 'BN' })] }),
        team('M2', { players: [player({ playerName: 'B', points: 10, selectedPosition: 'BN' })] }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    // No alphabetical fallback: that would look decisive while being arbitrary.
    expect(result.winningLeagueMemberIds).toHaveLength(2);
    expect(result.appliedTieBreaker).toBe('commissioner_decides');
  });

  it('applies tiebreakers in order until one separates the leaders', () => {
    const result = calculateChallenge(
      definition('bench-mob', {
        tieBreakers: ['worse_record', 'lower_team_points', 'commissioner_decides'],
      }),
      week([
        team('M1', {
          priorWins: 2,
          teamPoints: 120,
          players: [player({ playerName: 'A', points: 10, selectedPosition: 'BN' })],
        }),
        team('M2', {
          priorWins: 2,
          teamPoints: 90,
          players: [player({ playerName: 'B', points: 10, selectedPosition: 'BN' })],
        }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    // Records tie, so the second tiebreaker decides.
    expect(result.winningLeagueMemberIds).toEqual([id('M2')]);
    expect(result.appliedTieBreaker).toBe('lower_team_points');
  });

  it('skips a tiebreaker whose data is missing', () => {
    const result = calculateChallenge(
      definition('bench-mob', { tieBreakers: ['worse_record', 'lower_team_points'] }),
      week([
        team('M1', {
          teamPoints: 120,
          players: [player({ playerName: 'A', points: 10, selectedPosition: 'BN' })],
        }),
        team('M2', {
          teamPoints: 90,
          players: [player({ playerName: 'B', points: 10, selectedPosition: 'BN' })],
        }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningLeagueMemberIds).toEqual([id('M2')]);
    expect(result.appliedTieBreaker).toBe('lower_team_points');
  });

  it('shares a rank among tied competitors', () => {
    const result = calculateChallenge(
      definition('one-man-army'),
      week([
        team('M1', { players: [player({ playerName: 'A', points: 20 })] }),
        team('M2', { players: [player({ playerName: 'B', points: 20 })] }),
        team('M3', { players: [player({ playerName: 'C', points: 10 })] }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    const ranks = result.standings.filter((s) => s.eligible).map((s) => s.rank);
    // Two at rank 1, then rank 3 — not 1, 2, 3.
    expect(ranks).toEqual([1, 1, 3]);
  });
});

describe('eligibility rules', () => {
  it('excludes a manager with unpaid dues when the rule requires payment', () => {
    const withRule = definition('one-man-army');
    withRule.eligibility = { ...withRule.eligibility, requiresDuesPaid: true };

    const result = calculateChallenge(
      withRule,
      week([
        team('M1', { duesPaid: false, players: [player({ playerName: 'A', points: 40 })] }),
        team('M2', { duesPaid: true, players: [player({ playerName: 'B', points: 10 })] }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningLeagueMemberIds).toEqual([id('M2')]);
    expect(result.standings.find((s) => s.leagueMemberId === id('M1'))?.ineligibleReason).toBe(
      'dues_unpaid',
    );
  });

  it('enforces a per-season win cap', () => {
    const capped = definition('one-man-army');
    capped.eligibility = { ...capped.eligibility, maxWinsPerSeason: 2 };

    const result = calculateChallenge(
      capped,
      week([
        team('M1', {
          priorWinsOfThisChallenge: 2,
          players: [player({ playerName: 'A', points: 40 })],
        }),
        team('M2', { players: [player({ playerName: 'B', points: 10 })] }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningLeagueMemberIds).toEqual([id('M2')]);
  });

  it('restricts to an explicit member list when one is set', () => {
    const limited = definition('one-man-army');
    limited.eligibility = { ...limited.eligibility, limitedToLeagueMemberIds: [id('M2')] };

    const result = calculateChallenge(
      limited,
      week([
        team('M1', { players: [player({ playerName: 'A', points: 40 })] }),
        team('M2', { players: [player({ playerName: 'B', points: 10 })] }),
      ]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningLeagueMemberIds).toEqual([id('M2')]);
  });

  it('does not exclude a manager whose dues status is simply unknown', () => {
    // `undefined` means "we do not know", which must not disqualify someone.
    const withRule = definition('one-man-army');
    withRule.eligibility = { ...withRule.eligibility, requiresDuesPaid: true };

    const result = calculateChallenge(
      withRule,
      week([team('M1', { players: [player({ playerName: 'A', points: 40 })] })]),
      { isCapabilityVerified: ALL_VERIFIED },
    );

    if (result.blocked) return;
    expect(result.winningLeagueMemberIds).toEqual([id('M1')]);
  });
});

describe('stat-correction recalculation', () => {
  const existing = (
    overrides: Partial<
      Pick<
        WeeklyChallengeResult,
        'status' | 'winningLeagueMemberIds' | 'winningValue' | 'payoutSettled'
      >
    > = {},
  ) => ({
    status: 'provisional' as const,
    winningLeagueMemberIds: [id('M1')],
    winningValue: 30,
    payoutSettled: false,
    ...overrides,
  });

  const outcome = (winners: string[], value: number) => ({
    winningLeagueMemberIds: winners.map(id),
    winningValue: value,
    standings: [],
    explanation: '',
    wasTied: false,
  });

  it('leaves an unchanged result alone', () => {
    const decision = decideRecalculation(existing(), outcome(['M1'], 30));
    expect(decision.shouldUpdate).toBe(false);
    expect(decision.changed).toBe(false);
  });

  it('updates a provisional result when a correction changes the winner', () => {
    const decision = decideRecalculation(existing(), outcome(['M2'], 32));
    expect(decision.shouldUpdate).toBe(true);
    expect(decision.changed).toBe(true);
  });

  it('updates when only the value changed', () => {
    const decision = decideRecalculation(existing(), outcome(['M1'], 31.5));
    expect(decision.shouldUpdate).toBe(true);
  });

  it('refuses to silently rewrite a result whose payout already settled', () => {
    // Quietly changing this would leave the portal claiming someone won money
    // they never received.
    const decision = decideRecalculation(existing({ payoutSettled: true }), outcome(['M2'], 32));

    expect(decision.shouldUpdate).toBe(false);
    expect(decision.changed).toBe(true);
    expect(decision.blockedBySettledPayout).toBe(true);
    expect(decision.summary).toContain('override');
  });

  it('leaves a commissioner override standing', () => {
    const decision = decideRecalculation(existing({ status: 'overridden' }), outcome(['M2'], 32));

    expect(decision.shouldUpdate).toBe(false);
    expect(decision.summary).toContain('override');
  });

  it('treats the same winners in a different order as unchanged', () => {
    const decision = decideRecalculation(
      existing({ winningLeagueMemberIds: [id('M1'), id('M2')] }),
      outcome(['M2', 'M1'], 30),
    );
    expect(decision.changed).toBe(false);
  });
});

describe('finalization', () => {
  it('accepts a single clear winner', () => {
    expect(() =>
      assertCanFinalize({ status: 'provisional', winningLeagueMemberIds: [id('M1')] }),
    ).not.toThrow();
  });

  it('refuses to finalize twice', () => {
    expect(() =>
      assertCanFinalize({ status: 'finalized', winningLeagueMemberIds: [id('M1')] }),
    ).toThrow(expect.objectContaining({ code: 'challenge_already_finalized' }));
  });

  it('refuses to finalize an unresolved tie', () => {
    expect(() =>
      assertCanFinalize({ status: 'provisional', winningLeagueMemberIds: [id('M1'), id('M2')] }),
    ).toThrow(expect.objectContaining({ code: 'precondition_failed' }));
  });

  it('refuses to finalize with no winner', () => {
    expect(() => assertCanFinalize({ status: 'provisional', winningLeagueMemberIds: [] })).toThrow(
      expect.objectContaining({ code: 'precondition_failed' }),
    );
  });

  it('refuses to finalize something that could not be calculated', () => {
    expect(() =>
      assertCanFinalize({ status: 'not_calculable', winningLeagueMemberIds: [] }),
    ).toThrow(expect.objectContaining({ code: 'challenge_blocked' }));
  });
});

describe('overrides', () => {
  it('requires a reason', () => {
    expect(() =>
      assertCanOverride({ overridePolicy: 'always_with_reason' }, { status: 'provisional' }, '   '),
    ).toThrow(expect.objectContaining({ code: 'override_reason_required' }));
  });

  it('accepts an override with a reason', () => {
    expect(() =>
      assertCanOverride(
        { overridePolicy: 'always_with_reason' },
        { status: 'finalized' },
        'Yahoo corrected the stat after we paid; league voted to keep the original winner.',
      ),
    ).not.toThrow();
  });

  it('honours a never-override policy', () => {
    expect(() =>
      assertCanOverride({ overridePolicy: 'never' }, { status: 'provisional' }, 'because'),
    ).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });

  it('honours a before-finalization-only policy', () => {
    expect(() =>
      assertCanOverride({ overridePolicy: 'before_finalization' }, { status: 'provisional' }, 'ok'),
    ).not.toThrow();

    expect(() =>
      assertCanOverride({ overridePolicy: 'before_finalization' }, { status: 'finalized' }, 'ok'),
    ).toThrow(expect.objectContaining({ code: 'challenge_already_finalized' }));
  });
});

describe('challenge proposals', () => {
  it('covers all thirteen league challenges', () => {
    expect(CHALLENGE_PROPOSALS).toHaveLength(13);

    const slugs = CHALLENGE_PROPOSALS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(13);
    for (const expected of [
      'one-man-army',
      'photo-finish',
      'bench-mob',
      'ground-and-pound',
      'bad-beat',
      'overachiever',
      'air-raid',
      'tight-end-day',
      'defense-wins-championships',
      'bullseye',
      'catch-everything',
      'blackjack',
      'touchdown-dependency',
    ]) {
      expect(slugs).toContain(expected);
    }
  });

  it('has a calculator for every calculation type', () => {
    for (const proposal of CHALLENGE_PROPOSALS) {
      expect(CALCULATOR_TYPES).toContain(proposal.calculation.type);
    }
  });

  it('blocks every challenge when nothing is verified, which is the shipped state', () => {
    // yahoo-capabilities.json ships with an empty verified list, so nothing runs
    // until a real league confirms the data exists.
    for (const proposal of CHALLENGE_PROPOSALS) {
      const derived = proposalToDefinition(proposal, { isCapabilityVerified: NONE_VERIFIED });
      expect(derived.status).toBe('blocked');
      expect(derived.blockedReason).toContain('verify:yahoo');
    }
  });

  it('activates the eight challenges that need no projections or raw stat ids', () => {
    const verified = (capability: YahooCapabilityKey): boolean =>
      !['player_projected_points', 'team_projected_points', 'player_stat_by_id'].includes(
        capability,
      );

    const active = CHALLENGE_PROPOSALS.filter(
      (proposal) =>
        proposalToDefinition(proposal, { isCapabilityVerified: verified }).status === 'active',
    ).map((p) => p.slug);

    expect(active.sort()).toEqual(
      [
        'bad-beat',
        'bench-mob',
        'blackjack',
        'defense-wins-championships',
        'ground-and-pound',
        'one-man-army',
        'photo-finish',
        'tight-end-day',
      ].sort(),
    );
  });

  it('explains why each blocked proposal is blocked', () => {
    for (const slug of [
      'overachiever',
      'bullseye',
      'air-raid',
      'catch-everything',
      'touchdown-dependency',
    ]) {
      const proposal = findProposal(slug)!;
      expect(proposal.rationale).toContain('BLOCKED');
    }
  });

  it('records every rule as configuration rather than hardcoded behavior', () => {
    // Correcting a rule must be an edit in the portal, not a code change.
    for (const proposal of CHALLENGE_PROPOSALS) {
      expect(typeof proposal.benchCounts).toBe('boolean');
      expect(typeof proposal.decimalsCount).toBe('boolean');
      expect(typeof proposal.negativesCount).toBe('boolean');
      expect(proposal.tieBreakers.length).toBeGreaterThan(0);
      expect(proposal.requiredYahooData.length).toBeGreaterThan(0);
    }
  });
});
