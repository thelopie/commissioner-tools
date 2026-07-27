#!/usr/bin/env node
/**
 * Verifies Yahoo connectivity against a real league.
 *
 * This is the script that turns `yahoo-capabilities.json` from a set of careful
 * assumptions into observed fact. It is the only thing that should ever move a
 * capability to `verified`.
 *
 * It requires a real access token, which means completing the OAuth flow first:
 *
 *   1. npm run dev
 *   2. Sign in through the portal with YAHOO_MODE=live
 *   3. Copy the access token from the API log line "Yahoo OAuth completed"
 *      (it is redacted there — instead use the /api/yahoo/leagues endpoint, or
 *      pass a token directly as shown below)
 *
 *   node scripts/verify-yahoo.mjs --token "<access token>"
 *   node scripts/verify-yahoo.mjs --token "<token>" --league "nnn.l.nnnnnn"
 *
 * Nothing is written to the capability file automatically. The output tells you
 * exactly which entries to update, and updating them is a deliberate act.
 */

const BASE = 'https://fantasysports.yahooapis.com/fantasy/v2';

const args = process.argv.slice(2);
const token = valueOf('--token');
const leagueKeyArg = valueOf('--league');

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

if (!token) {
  console.error('\nUsage: node scripts/verify-yahoo.mjs --token "<yahoo access token>"\n');
  console.error('Complete the OAuth flow in the portal first (YAHOO_MODE=live).');
  console.error('Yahoo grants API access only after reviewing an application:');
  console.error('  https://sports.yahoo.com/developer/access/\n');
  process.exit(1);
}

const results = [];

async function probe(name, path, capabilities, check) {
  const url = `${BASE}/${path}${path.includes('?') ? '&' : '?'}format=json`;

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });

    const text = await response.text();

    if (!response.ok) {
      results.push({
        name,
        path,
        capabilities,
        status: 'failed',
        detail: `HTTP ${response.status}`,
        // Yahoo error bodies can be verbose; the first line is enough to diagnose.
        body: text.slice(0, 200),
      });
      return null;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      results.push({ name, path, capabilities, status: 'failed', detail: 'response was not JSON' });
      return null;
    }

    const verdict = check ? check(parsed) : { ok: true, detail: 'responded' };

    results.push({
      name,
      path,
      capabilities,
      status: verdict.ok ? 'verified' : 'failed',
      detail: verdict.detail,
    });

    return parsed;
  } catch (error) {
    results.push({
      name,
      path,
      capabilities,
      status: 'failed',
      detail: `request failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
}

/** Walks Yahoo's numeric-keyed collections without importing the parser. */
function items(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node;
  return Object.keys(node)
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => node[key]);
}

function flatten(node, depth = 0) {
  const merged = {};
  const absorb = (value, level) => {
    if (level > 4 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const entry of value) absorb(entry, level + 1);
      return;
    }
    if (typeof value === 'object') Object.assign(merged, value);
  };
  absorb(node, depth);
  return merged;
}

console.log('\nProbing the Yahoo Fantasy Sports API…\n');

// 1. Identity. The GUID is the one value the terms allow storing indefinitely.
await probe('user profile', 'users;use_login=1', ['(identity)'], (body) => {
  const user = flatten(items(body?.fantasy_content?.users)[0]?.user);
  return user.guid
    ? { ok: true, detail: `guid present (${String(user.guid).slice(0, 6)}…)` }
    : { ok: false, detail: 'no guid in response' };
});

// 2. League discovery. The nesting here comes from Yahoo's archived guide, not
//    current documentation, so confirming it is the point of this probe.
const leaguesBody = await probe(
  'football leagues',
  'users;use_login=1/games;game_codes=nfl/leagues',
  ['user_leagues'],
  (body) => {
    const games = items(body?.fantasy_content?.users)[0]?.user;
    const merged = flatten(games);
    const leagueNodes = items(merged.games).flatMap((game) => items(flatten(game.game).leagues));
    return leagueNodes.length > 0
      ? { ok: true, detail: `${leagueNodes.length} league(s) found` }
      : { ok: false, detail: 'no leagues returned — is this the right Yahoo account?' };
  },
);

let leagueKey = leagueKeyArg;
if (!leagueKey && leaguesBody) {
  const user = flatten(items(leaguesBody.fantasy_content.users)[0]?.user);
  for (const game of items(user.games)) {
    for (const node of items(flatten(game.game).leagues)) {
      const league = flatten(node.league);
      if (league.league_key) {
        leagueKey = String(league.league_key);
        break;
      }
    }
    if (leagueKey) break;
  }
}

if (!leagueKey) {
  console.log('No league key available, so league-scoped probes were skipped.');
  console.log('Pass one explicitly with --league to continue.\n');
} else {
  console.log(`Using league ${leagueKey}\n`);
  const encoded = encodeURIComponent(leagueKey);

  await probe('league settings', `league/${encoded}/settings`, ['league_metadata'], (body) => {
    const league = flatten(body?.fantasy_content?.league);
    return league.league_key
      ? { ok: true, detail: `current_week=${league.current_week ?? 'absent'}` }
      : { ok: false, detail: 'no league_key in response' };
  });

  const teamsBody = await probe(
    'teams and managers',
    `league/${encoded}/teams`,
    ['league_teams'],
    (body) => {
      const league = flatten(body?.fantasy_content?.league);
      const teams = items(league.teams);
      return teams.length > 0
        ? { ok: true, detail: `${teams.length} team(s)` }
        : { ok: false, detail: 'no teams returned' };
    },
  );

  const week = 1;

  await probe(
    'scoreboard / matchups',
    `league/${encoded}/scoreboard;week=${week}`,
    ['team_week_points', 'matchup_result'],
    (body) => {
      const league = flatten(body?.fantasy_content?.league);
      const matchups = items(flatten(league.scoreboard).matchups);
      if (matchups.length === 0) return { ok: false, detail: 'no matchups for that week' };

      const first = flatten(matchups[0].matchup);
      const team = flatten(items(first.teams)[0]?.team);
      const points = flatten(team.team_points).total;

      return points !== undefined
        ? { ok: true, detail: `team points present (${points})` }
        : { ok: false, detail: 'matchups returned but no team_points.total' };
    },
  );

  // The roster probe is the important one: bench detection and per-player points
  // are what most challenges depend on, and both are unverified conventions.
  let teamKey;
  if (teamsBody) {
    const league = flatten(teamsBody.fantasy_content.league);
    const team = flatten(items(league.teams)[0]?.team);
    if (team.team_key) teamKey = String(team.team_key);
  }

  if (teamKey) {
    await probe(
      'roster with bench and points',
      `team/${encodeURIComponent(teamKey)}/roster;week=${week}/players/stats;type=week;week=${week}`,
      ['roster_selected_position', 'player_week_points', 'player_position'],
      (body) => {
        const team = flatten(body?.fantasy_content?.team);
        const roster = flatten(team.roster);
        const players = items(roster.players);
        if (players.length === 0) return { ok: false, detail: 'no players in roster' };

        const slots = players.map((node) => {
          const player = flatten(node.player);
          return {
            slot: flatten(player.selected_position).position,
            points: flatten(player.player_points).total,
            position: player.display_position,
          };
        });

        const benchCodes = [...new Set(slots.map((s) => s.slot))].filter((slot) =>
          ['BN', 'IR', 'IR+', 'NA'].includes(String(slot)),
        );
        const withPoints = slots.filter((s) => s.points !== undefined).length;

        if (benchCodes.length === 0) {
          return {
            ok: false,
            detail:
              `no bench slot code found. Observed slots: ${[...new Set(slots.map((s) => s.slot))].join(', ')}. ` +
              `Update BENCH_SLOTS in packages/challenge-engine/src/inputs.ts.`,
          };
        }

        return withPoints > 0
          ? {
              ok: true,
              detail: `bench code(s) ${benchCodes.join('/')} confirmed, ${withPoints}/${slots.length} players have points`,
            }
          : { ok: false, detail: 'roster returned but no player_points.total' };
      },
    );
  }

  // Projections: no official documentation describes these as an API field, so a
  // failure here is the expected outcome and confirms the blocked challenges.
  await probe(
    'projected points (expected to be unavailable)',
    `league/${encoded}/scoreboard;week=${week}`,
    ['team_projected_points'],
    (body) => {
      const league = flatten(body?.fantasy_content?.league);
      const matchups = items(flatten(league.scoreboard).matchups);
      const team = flatten(items(flatten(matchups[0]?.matchup ?? {}).teams)[0]?.team);
      const projected = flatten(team.team_projected_points).total;

      return projected !== undefined
        ? {
            ok: true,
            detail: `projected points ARE available (${projected}) — unblock those challenges`,
          }
        : {
            ok: false,
            detail:
              'no team_projected_points, as expected. Overachiever and Bullseye stay blocked.',
          };
    },
  );

  await probe(
    'stat categories (for stat-id mapping)',
    `game/nfl/stat_categories`,
    ['player_stat_by_id'],
    (body) => {
      const game = flatten(body?.fantasy_content?.game);
      const categories = items(flatten(game.stat_categories).stats);
      return categories.length > 0
        ? {
            ok: true,
            detail: `${categories.length} stat categories — verify the ids in the proposals`,
          }
        : { ok: false, detail: 'no stat categories returned; stat-id challenges stay blocked' };
    },
  );
}

// -------------------------------------------------------------------- report

console.log('\n─────────────────────────────────────────────────────────────');
console.log(' Results');
console.log('─────────────────────────────────────────────────────────────\n');

const verified = new Set();

for (const result of results) {
  const mark = result.status === 'verified' ? '✓' : '✗';
  console.log(`${mark} ${result.name}`);
  console.log(`    ${result.path}`);
  console.log(`    ${result.detail}`);
  if (result.body) console.log(`    body: ${result.body}`);
  console.log();

  if (result.status === 'verified') {
    for (const capability of result.capabilities) {
      if (!capability.startsWith('(')) verified.add(capability);
    }
  }
}

console.log('─────────────────────────────────────────────────────────────\n');

if (verified.size === 0) {
  console.log('Nothing was verified. yahoo-capabilities.json should stay as it is.\n');
  process.exit(1);
}

console.log('Capabilities observed working. Update yahoo-capabilities.json:\n');
console.log('  "verifiedCapabilities": [');
console.log(
  [...verified]
    .sort()
    .map((capability) => `    "${capability}"`)
    .join(',\n'),
);
console.log('  ]\n');
console.log('Also set testStatus to "verified" on the matching resource entries,');
console.log('and update lastReviewedAt. Do this by hand — an automatic edit would');
console.log('remove the human review this file exists to record.\n');

if (!verified.has('player_week_points') || !verified.has('roster_selected_position')) {
  console.log('Note: most challenges need BOTH roster_selected_position and');
  console.log('player_week_points. Until both are verified they stay blocked.\n');
}
