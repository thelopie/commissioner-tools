import type {
  Calculation,
  ChallengeStatus,
  Objective,
  OverridePolicy,
  TieBreaker,
  WeeklyChallengeDefinition,
  YahooCapabilityKey,
} from '@dinkel/shared';

/**
 * Proposed rules for the league's thirteen weekly challenges.
 *
 * These are PROPOSALS. Each one is a defensible reading of the challenge name,
 * but the league's actual rules live in the commissioner's head and in a legacy
 * spreadsheet. Every knob — bench counting, decimals, negatives, tiebreakers,
 * targets, position groups — is stored on the definition record, so correcting a
 * rule is an edit in the portal, not a code change and a redeploy.
 *
 * `status` is derived at load time from the capability matrix: a challenge whose
 * required Yahoo data has not been verified against a real league is `blocked`
 * and no math runs for it. Nothing here invents a Yahoo field.
 */

export interface ChallengeProposal {
  slug: string;
  name: string;
  /** The rule as proposed, in the language a commissioner would use. */
  description: string;
  requiredYahooData: YahooCapabilityKey[];
  calculation: Calculation;
  objective: Objective;
  tieBreakers: TieBreaker[];
  benchCounts: boolean;
  decimalsCount: boolean;
  negativesCount: boolean;
  statCorrectionsCanChangeOutcome: boolean;
  overridePolicy: OverridePolicy;
  /** Why this reading was chosen, and what a commissioner might want to change. */
  rationale: string;
}

export const CHALLENGE_PROPOSALS: readonly ChallengeProposal[] = [
  {
    slug: 'one-man-army',
    name: 'One Man Army',
    description: 'The single highest-scoring starter in the league for the week.',
    requiredYahooData: ['roster_selected_position', 'player_week_points'],
    calculation: { type: 'highest_single_starter_score' },
    objective: 'maximize',
    tieBreakers: ['worse_record', 'commissioner_decides'],
    benchCounts: false,
    decimalsCount: true,
    negativesCount: false,
    statCorrectionsCanChangeOutcome: true,
    overridePolicy: 'always_with_reason',
    rationale:
      'Starters only: a bench player who happened to score big was not a lineup decision. ' +
      'Set benchCounts if the league intends otherwise.',
  },

  {
    slug: 'photo-finish',
    name: 'Photo Finish',
    description: 'The narrowest margin of victory in any of the week’s matchups.',
    requiredYahooData: ['team_week_points', 'matchup_result'],
    calculation: { type: 'smallest_margin_of_victory' },
    objective: 'minimize',
    tieBreakers: ['higher_team_points', 'commissioner_decides'],
    benchCounts: false,
    decimalsCount: true,
    negativesCount: true,
    statCorrectionsCanChangeOutcome: true,
    overridePolicy: 'always_with_reason',
    rationale:
      'Both teams in the closest game tie on the margin, so the tiebreaker decides whether the ' +
      'winner or the loser takes it. That is a league policy question, kept in configuration ' +
      'rather than hardcoded.',
  },

  {
    slug: 'bench-mob',
    name: 'Bench Mob',
    description: 'The most points left on the bench.',
    requiredYahooData: ['roster_selected_position', 'player_week_points'],
    calculation: { type: 'highest_bench_total' },
    objective: 'maximize',
    tieBreakers: ['lower_team_points', 'commissioner_decides'],
    benchCounts: true,
    decimalsCount: true,
    negativesCount: false,
    statCorrectionsCanChangeOutcome: true,
    overridePolicy: 'always_with_reason',
    rationale:
      'Injured-reserve slots count as bench, since those are also points not in the lineup. ' +
      'Negatives are excluded so a -3 defense does not reduce the total.',
  },

  {
    slug: 'ground-and-pound',
    name: 'Ground and Pound',
    description: 'The most points from starting running backs.',
    requiredYahooData: ['roster_selected_position', 'player_week_points', 'player_position'],
    calculation: { type: 'highest_position_group_total', positions: ['RB'] },
    objective: 'maximize',
    tieBreakers: ['worse_record', 'commissioner_decides'],
    benchCounts: false,
    decimalsCount: true,
    negativesCount: false,
    statCorrectionsCanChangeOutcome: true,
    overridePolicy: 'always_with_reason',
    rationale:
      'Counts a running back started in a flex slot, because the position is what matters, not ' +
      'the slot label.',
  },

  {
    slug: 'bad-beat',
    name: 'Bad Beat',
    description: 'The highest score that still lost.',
    requiredYahooData: ['team_week_points', 'matchup_result'],
    calculation: { type: 'highest_score_in_loss' },
    objective: 'maximize',
    tieBreakers: ['commissioner_decides'],
    benchCounts: false,
    decimalsCount: true,
    negativesCount: true,
    statCorrectionsCanChangeOutcome: true,
    overridePolicy: 'always_with_reason',
    rationale:
      'Only losses are eligible. A tie is not a loss, so tied teams are excluded — change the ' +
      'calculation if the league counts ties.',
  },

  {
    slug: 'tight-end-day',
    name: 'Tight End Day',
    description: 'The most points from starting tight ends.',
    requiredYahooData: ['roster_selected_position', 'player_week_points', 'player_position'],
    calculation: { type: 'highest_position_group_total', positions: ['TE'] },
    objective: 'maximize',
    tieBreakers: ['worse_record', 'commissioner_decides'],
    benchCounts: false,
    decimalsCount: true,
    negativesCount: false,
    statCorrectionsCanChangeOutcome: true,
    overridePolicy: 'always_with_reason',
    rationale: 'Includes a tight end started in a flex slot.',
  },

  {
    slug: 'defense-wins-championships',
    name: 'Defense Wins Championships',
    description: 'The most points from the starting defense.',
    requiredYahooData: ['roster_selected_position', 'player_week_points', 'player_position'],
    calculation: { type: 'highest_position_group_total', positions: ['DEF', 'DST', 'D/ST'] },
    objective: 'maximize',
    tieBreakers: ['worse_record', 'commissioner_decides'],
    benchCounts: false,
    decimalsCount: true,
    negativesCount: true,
    statCorrectionsCanChangeOutcome: true,
    overridePolicy: 'always_with_reason',
    rationale:
      'Several position codes are accepted because Yahoo’s exact defense code is unverified. ' +
      'Negatives count: a defense that gave up 40 points genuinely scored negative, and ' +
      'excluding that would flatter a bad week.',
  },

  {
    slug: 'blackjack',
    name: 'Blackjack',
    description:
      'The starter whose score comes closest to 21 without going over. Going over busts.',
    requiredYahooData: ['roster_selected_position', 'player_week_points'],
    calculation: { type: 'closest_to_target_without_exceeding', target: 21, subject: 'starter' },
    objective: 'minimize',
    tieBreakers: ['worse_record', 'split_prize'],
    benchCounts: false,
    decimalsCount: true,
    negativesCount: false,
    statCorrectionsCanChangeOutcome: true,
    overridePolicy: 'always_with_reason',
    rationale:
      'Busting disqualifies rather than penalizes, which is what makes it blackjack instead of ' +
      '"closest to 21". A 21.0 exactly wins outright. Change `subject` to team if the league ' +
      'means the whole lineup.',
  },

  // ------------------------------------------------------------------------
  // Below: proposals whose required Yahoo data is NOT available in current
  // official documentation. Each ships as a definition with no math run against
  // it, so the gap is visible in the portal instead of filled with a guess.
  // ------------------------------------------------------------------------

  {
    slug: 'overachiever',
    name: 'Overachiever',
    description: 'The team that beat its projected total by the widest margin.',
    requiredYahooData: ['team_week_points', 'team_projected_points'],
    calculation: { type: 'largest_projection_overperformance' },
    objective: 'maximize',
    tieBreakers: ['worse_record', 'commissioner_decides'],
    benchCounts: false,
    decimalsCount: true,
    negativesCount: true,
    statCorrectionsCanChangeOutcome: true,
    overridePolicy: 'always_with_reason',
    rationale:
      'BLOCKED: no current or archived official Yahoo documentation describes projected points ' +
      'as an API field. Yahoo’s website shows projections, which is not evidence of an API ' +
      'field, and scraping is out of scope. Needs a real league to confirm before it can run.',
  },

  {
    slug: 'bullseye',
    name: 'Bullseye',
    description: 'The team that finished closest to its own projected total, in either direction.',
    requiredYahooData: ['team_week_points', 'team_projected_points'],
    calculation: { type: 'closest_to_target', targetIsTeamProjection: true, subject: 'team' },
    objective: 'minimize',
    tieBreakers: ['worse_record', 'split_prize'],
    benchCounts: false,
    decimalsCount: true,
    negativesCount: true,
    statCorrectionsCanChangeOutcome: true,
    overridePolicy: 'always_with_reason',
    rationale:
      'BLOCKED for the same projection gap as Overachiever. If the league instead means a fixed ' +
      'target number, clear targetIsTeamProjection and set a target — that variant needs no ' +
      'projections and would be immediately calculable.',
  },

  {
    slug: 'air-raid',
    name: 'Air Raid',
    description: 'The most passing yards from a starting quarterback.',
    requiredYahooData: ['roster_selected_position', 'player_position', 'player_stat_by_id'],
    calculation: { type: 'highest_stat_total', yahooStatId: 4, statLabel: 'passing yards' },
    objective: 'maximize',
    tieBreakers: ['worse_record', 'commissioner_decides'],
    benchCounts: false,
    decimalsCount: false,
    negativesCount: false,
    statCorrectionsCanChangeOutcome: true,
    overridePolicy: 'always_with_reason',
    rationale:
      'BLOCKED: needs raw stats by Yahoo stat id, and no current official documentation ' +
      'publishes the id mapping. The id here is the conventional one for passing yards and is ' +
      'UNVERIFIED. A points-based variant using highest_position_group_total on QB would work ' +
      'today if the league is happy scoring quarterback points rather than yards.',
  },

  {
    slug: 'catch-everything',
    name: 'Catch Everything',
    description: 'The most receptions across starters.',
    requiredYahooData: ['roster_selected_position', 'player_stat_by_id'],
    calculation: { type: 'highest_stat_total', yahooStatId: 11, statLabel: 'receptions' },
    objective: 'maximize',
    tieBreakers: ['worse_record', 'split_prize'],
    benchCounts: false,
    decimalsCount: false,
    negativesCount: false,
    statCorrectionsCanChangeOutcome: true,
    overridePolicy: 'always_with_reason',
    rationale:
      'BLOCKED: same unverified stat-id mapping as Air Raid. The id is the conventional one for ' +
      'receptions and is UNVERIFIED.',
  },

  {
    slug: 'touchdown-dependency',
    name: 'Touchdown Dependency',
    description: 'The team whose largest share of points came from touchdowns.',
    requiredYahooData: ['roster_selected_position', 'player_stat_by_id', 'team_week_points'],
    calculation: {
      type: 'highest_stat_share_of_points',
      // Conventional ids for passing, rushing, and receiving touchdowns. All UNVERIFIED.
      yahooStatIds: [5, 10, 13],
      statLabel: 'touchdowns',
      pointsPerUnit: 6,
      // Guards the ratio: a 3-point week entirely from a touchdown would
      // otherwise post a perfect share and beat a 140-point week.
      minimumTeamPoints: 50,
    },
    objective: 'maximize',
    tieBreakers: ['worse_record', 'commissioner_decides'],
    benchCounts: false,
    decimalsCount: true,
    negativesCount: false,
    statCorrectionsCanChangeOutcome: true,
    overridePolicy: 'always_with_reason',
    rationale:
      'BLOCKED: needs touchdown counts by stat id. pointsPerUnit assumes 6 points per touchdown ' +
      'and must match the league’s actual scoring settings — a 4-point passing touchdown league ' +
      'would need separate handling per touchdown type.',
  },
];

/**
 * Turns a proposal into a definition, deriving status from what Yahoo can
 * actually supply.
 *
 * A proposal never arrives `active` on optimism: if any required capability is
 * unverified the definition is `blocked` with the specific reason, which is what
 * the portal displays instead of a fabricated winner.
 */
export function proposalToDefinition(
  proposal: ChallengeProposal,
  context: {
    isCapabilityVerified: (capability: YahooCapabilityKey) => boolean;
  },
): {
  slug: string;
  name: string;
  description: string;
  requiredYahooData: YahooCapabilityKey[];
  calculation: Calculation;
  objective: Objective;
  tieBreakers: TieBreaker[];
  benchCounts: boolean;
  decimalsCount: boolean;
  negativesCount: boolean;
  statCorrectionsCanChangeOutcome: boolean;
  overridePolicy: OverridePolicy;
  status: ChallengeStatus;
  blockedReason?: string;
  eligibility: WeeklyChallengeDefinition['eligibility'];
  weeks: number[];
} {
  const missing = proposal.requiredYahooData.filter(
    (capability) => !context.isCapabilityVerified(capability),
  );

  const base = {
    slug: proposal.slug,
    name: proposal.name,
    description: proposal.description,
    requiredYahooData: proposal.requiredYahooData,
    calculation: proposal.calculation,
    objective: proposal.objective,
    tieBreakers: proposal.tieBreakers,
    benchCounts: proposal.benchCounts,
    decimalsCount: proposal.decimalsCount,
    negativesCount: proposal.negativesCount,
    statCorrectionsCanChangeOutcome: proposal.statCorrectionsCanChangeOutcome,
    overridePolicy: proposal.overridePolicy,
    eligibility: {
      description: '',
      requiresDuesPaid: false,
      maxWinsPerSeason: 0,
      limitedToLeagueMemberIds: [],
    },
    weeks: [] as number[],
  };

  if (missing.length === 0) {
    return { ...base, status: 'active' as ChallengeStatus };
  }

  return {
    ...base,
    status: 'blocked' as ChallengeStatus,
    blockedReason:
      `Unverified Yahoo data: ${missing.join(', ')}. ` +
      `Run \`npm run verify:yahoo\` after Yahoo grants API access.`,
  };
}

export function findProposal(slug: string): ChallengeProposal | undefined {
  return CHALLENGE_PROPOSALS.find((proposal) => proposal.slug === slug);
}
