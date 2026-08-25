/**
 * Pairs Yahoo teams with the league members already stored in the portal.
 *
 * Mapping was twelve dropdowns, one per Yahoo team, filled in by hand. That is work
 * for its own sake: Yahoo returns each team's manager nickname, and those nicknames
 * are exactly the names the commissioner already entered, so the pairing is
 * derivable. A person should only be asked about the ones that genuinely are
 * ambiguous.
 *
 * Nothing here is stored. Matching happens against live Yahoo names at the moment
 * of mapping, so no fantasy team name or manager nickname is ever persisted.
 */

export interface MatchableTeam {
  yahooTeamKey: string;
  /** Yahoo's team name, e.g. "To infinity and Bijan". */
  name: string;
  /** Manager nicknames Yahoo reports for the team. */
  managerNames: string[];
  /** Already mapped, so out of scope. */
  leagueMemberId: string | null;
}

export interface MatchableMember {
  leagueMemberId: string;
  displayName: string;
  yahooTeamKey: string | null;
}

export interface Match {
  yahooTeamKey: string;
  yahooTeamName: string;
  leagueMemberId: string;
  memberName: string;
  /** Which signal produced the pairing, so the commissioner can judge it. */
  on: 'manager name';
}

export interface MatchResult {
  matches: Match[];
  /** Teams no member could be matched to, left for a human. */
  unmatchedTeams: MatchableTeam[];
  /** Members no team claimed — usually someone who left the league. */
  unmatchedMembers: MatchableMember[];
}

/** Lowercased and stripped of spacing and punctuation, so "de haan" meets "Dehaan". */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Matches on manager nickname only.
 *
 * Deliberately not on team name: fantasy team names change on a whim mid-season and
 * are nobody's actual name, so a match on one would be a coincidence dressed as a
 * fact. A wrong pairing here attributes somebody's scores to somebody else, which is
 * worse than leaving a dropdown for a person to fill in.
 *
 * Ambiguity is refused rather than guessed: if two members normalize to the same
 * name, neither is matched.
 */
export function matchMembersToTeams(
  teams: MatchableTeam[],
  members: MatchableMember[],
): MatchResult {
  const openTeams = teams.filter((team) => team.leagueMemberId === null);
  const openMembers = members.filter((member) => member.yahooTeamKey === null);

  const byName = new Map<string, MatchableMember[]>();
  for (const member of openMembers) {
    const key = normalize(member.displayName);
    byName.set(key, [...(byName.get(key) ?? []), member]);
  }

  const matches: Match[] = [];
  const claimed = new Set<string>();
  const unmatchedTeams: MatchableTeam[] = [];

  for (const team of openTeams) {
    const candidates = team.managerNames
      .map((name) => byName.get(normalize(name)) ?? [])
      // Exactly one member of that name, and not already taken by another team.
      .filter((found) => found.length === 1 && !claimed.has(found[0]!.leagueMemberId))
      .map((found) => found[0]!);

    // More than one manager on a team matching different members is ambiguous too.
    const unique = [...new Map(candidates.map((m) => [m.leagueMemberId, m])).values()];

    if (unique.length !== 1) {
      unmatchedTeams.push(team);
      continue;
    }

    const member = unique[0]!;
    claimed.add(member.leagueMemberId);
    matches.push({
      yahooTeamKey: team.yahooTeamKey,
      yahooTeamName: team.name,
      leagueMemberId: member.leagueMemberId,
      memberName: member.displayName,
      on: 'manager name',
    });
  }

  return {
    matches,
    unmatchedTeams,
    unmatchedMembers: openMembers.filter((member) => !claimed.has(member.leagueMemberId)),
  };
}
