/**
 * Pulls a Yahoo league id out of whatever the commissioner pasted.
 *
 * Needed because the league list cannot be read while the Yahoo application has no
 * Fantasy authorization, so the id is typed in by hand — and what people have to
 * hand is the address bar, not a bare number.
 *
 * The first attempt at this took the last run of digits in the string, which is
 * wrong for the most ordinary URL there is: `/f1/17255/10` ends with the *team*
 * number, so it read 10 as the league. Yahoo's own path is the only reliable
 * signal, so that is what is matched, and anything ambiguous is refused rather
 * than guessed at.
 */

/** Yahoo's league path, e.g. `football.fantasysports.yahoo.com/f1/17255/10`. */
const LEAGUE_PATH = /\/f1\/(\d+)/;

/** A bare id, typed rather than pasted. */
const BARE_ID = /^\d+$/;

/**
 * @returns the league id, or null when the input is not something to guess about.
 */
export function parseYahooLeagueId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const fromPath = LEAGUE_PATH.exec(trimmed);
  if (fromPath?.[1]) return fromPath[1];

  if (BARE_ID.test(trimmed)) return trimmed;

  return null;
}

/**
 * The league key the Fantasy API expects.
 *
 * `nfl` stands in for the numeric season game key, which Yahoo accepts and which
 * saves asking for a value nobody has ever seen.
 */
export function yahooLeagueKeyFor(leagueId: string): string {
  return `nfl.l.${leagueId}`;
}
