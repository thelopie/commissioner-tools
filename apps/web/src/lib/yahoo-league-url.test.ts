import { describe, expect, it } from 'vitest';
import { parseYahooLeagueId, yahooLeagueKeyFor } from './yahoo-league-url.js';

describe('parseYahooLeagueId', () => {
  it('reads the league, not the team, from a full league URL', () => {
    /*
      The case that broke the first version. `/f1/17255/10` ends with the team
      number, so taking the last run of digits produced a league id of 10.
    */
    expect(parseYahooLeagueId('https://football.fantasysports.yahoo.com/f1/17255/10')).toBe('17255');
  });

  it('handles the league URL without a team on the end', () => {
    expect(parseYahooLeagueId('https://football.fantasysports.yahoo.com/f1/17255')).toBe('17255');
  });

  it('handles a deeper path and a query string', () => {
    expect(parseYahooLeagueId('https://football.fantasysports.yahoo.com/f1/17255/10/team?week=3')).toBe(
      '17255',
    );
  });

  it('accepts a bare id, which is what someone typing rather than pasting gives', () => {
    expect(parseYahooLeagueId('17255')).toBe('17255');
    expect(parseYahooLeagueId('  17255  ')).toBe('17255');
  });

  it('refuses anything ambiguous instead of guessing', () => {
    // A wrong league id silently stores a link to somebody else's league.
    expect(parseYahooLeagueId('')).toBeNull();
    expect(parseYahooLeagueId('my league')).toBeNull();
    expect(parseYahooLeagueId('https://football.fantasysports.yahoo.com/')).toBeNull();
    expect(parseYahooLeagueId('league 17255 maybe')).toBeNull();
  });
});

describe('yahooLeagueKeyFor', () => {
  it('uses the game code in place of the numeric season key', () => {
    expect(yahooLeagueKeyFor('17255')).toBe('nfl.l.17255');
  });
});
