import { useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Chip,
  IconButton,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid2';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeftRounded';
import ChevronRightIcon from '@mui/icons-material/ChevronRightRounded';
import ScoreboardIcon from '@mui/icons-material/ScoreboardRounded';
import { useConnection, useLeagueOverview, useMatchups } from '../hooks.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { EmptyState, Monogram, PageHeader, RelativeTime } from '../components/primitives.js';
import { formatPoints } from './HomePage.js';

/**
 * Every matchup for a week.
 *
 * The viewer's own matchup is pulled to the front and outlined, because that is
 * the one they came to look at. A strict week order would bury it in the middle of
 * six identical cards.
 */
export function MatchupsPage(): JSX.Element {
  const connection = useConnection();
  const connected = connection.data?.connected ?? false;
  const overview = useLeagueOverview(connected);

  const currentWeek = overview.data?.yahoo?.currentWeek ?? null;
  const startWeek = overview.data?.yahoo?.startWeek ?? 1;
  const endWeek = overview.data?.yahoo?.endWeek ?? 17;

  const [week, setWeek] = useState<number | null>(null);
  const activeWeek = week ?? currentWeek;

  const matchups = useMatchups(connected ? activeWeek : null);

  if (!connected) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Matchups" />
        <EmptyState
          icon={<ScoreboardIcon />}
          title="Connect Yahoo to see matchups"
          description="Scores are read live from Yahoo and update as games play."
        />
      </Stack>
    );
  }

  const canGoBack = activeWeek !== null && activeWeek > startWeek;
  const canGoForward = activeWeek !== null && activeWeek < endWeek;

  const ordered = [...(matchups.data?.matchups ?? [])].sort(
    (a, b) => Number(b.involvesYou) - Number(a.involvesYou),
  );

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Matchups"
        description={matchups.data ? `${matchups.data.seasonYear} season` : undefined}
        action={
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Tooltip title="Previous week">
              <span>
                <IconButton
                  onClick={() => setWeek((activeWeek ?? startWeek) - 1)}
                  disabled={!canGoBack}
                  aria-label="Previous week"
                >
                  <ChevronLeftIcon />
                </IconButton>
              </span>
            </Tooltip>

            <Chip
              label={activeWeek === null ? 'Week —' : `Week ${activeWeek}`}
              color={activeWeek === currentWeek ? 'primary' : 'default'}
              sx={{ minWidth: 96 }}
            />

            <Tooltip title="Next week">
              <span>
                <IconButton
                  onClick={() => setWeek((activeWeek ?? startWeek) + 1)}
                  disabled={!canGoForward}
                  aria-label="Next week"
                >
                  <ChevronRightIcon />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        }
      />

      {matchups.isLoading && (
        <Grid container spacing={2}>
          {Array.from({ length: 6 }, (_, index) => (
            <Grid size={{ xs: 12, md: 6 }} key={index}>
              <Skeleton height={148} sx={{ borderRadius: 4 }} />
            </Grid>
          ))}
        </Grid>
      )}

      {matchups.isError && (
        <ErrorNotice error={matchups.error} onRetry={() => void matchups.refetch()} />
      )}

      {matchups.data && ordered.length === 0 && (
        <EmptyState
          icon={<ScoreboardIcon />}
          title={`No matchups in week ${activeWeek}`}
          description="Yahoo has no scoreboard for this week — usually a week outside the season, or one that has not been scheduled yet."
        />
      )}

      <Grid container spacing={2}>
        {ordered.map((matchup, index) => (
          <Grid
            size={{ xs: 12, md: 6 }}
            key={matchup.teams.map((team) => team.yahooTeamKey).join('|')}
          >
            <MatchupCard matchup={matchup} highlighted={matchup.involvesYou && index === 0} />
          </Grid>
        ))}
      </Grid>

      {matchups.data && (
        <Typography variant="caption" color="text.secondary">
          Read live from Yahoo <RelativeTime value={matchups.data.fetchedAt} underline={false} />.
          In-progress scores change as games play and Yahoo issues stat corrections for days
          afterwards.
        </Typography>
      )}
    </Stack>
  );
}

function MatchupCard({
  matchup,
  highlighted,
}: {
  matchup: NonNullable<ReturnType<typeof useMatchups>['data']>['matchups'][number];
  highlighted: boolean;
}): JSX.Element {
  const final = matchup.status === 'postevent';
  const live = matchup.status === 'midevent';

  return (
    <Card
      sx={{
        height: '100%',
        ...(highlighted
          ? {
              borderColor: 'primary.main',
              borderWidth: 2,
              bgcolor: 'background.surfaceContainerHigh',
            }
          : {}),
      }}
    >
      <CardContent>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} alignItems="center">
            {matchup.involvesYou && <Chip size="small" color="primary" label="your matchup" />}
            {live && <Chip size="small" variant="outlined" color="warning" label="live" />}
            {final && <Chip size="small" variant="outlined" label="final" />}
            {matchup.status === 'preevent' && (
              <Chip size="small" variant="outlined" label="not started" />
            )}
            <Box sx={{ flexGrow: 1 }} />
            {matchup.margin !== null && (
              <Typography variant="caption" color="text.secondary">
                by {formatPoints(matchup.margin)}
              </Typography>
            )}
          </Stack>

          <Stack spacing={1}>
            {matchup.teams.map((team) => {
              // Only mark a winner once the result is settled. Highlighting the
              // leader mid-game reads as a final result.
              const won = final && team.isWinner && !matchup.isTied;

              return (
                <Stack key={team.yahooTeamKey} direction="row" spacing={1.5} alignItems="center">
                  <Monogram name={team.name} size={36} />

                  <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <Typography
                        variant="body2"
                        noWrap
                        sx={{ fontWeight: won ? 700 : 500, minWidth: 0 }}
                      >
                        {team.name}
                      </Typography>
                      {team.isYou && <Chip size="small" color="primary" label="you" />}
                    </Stack>
                    <Typography variant="caption" color="text.secondary" noWrap display="block">
                      {team.managers.join(', ')}
                    </Typography>
                  </Box>

                  <Typography
                    variant="h3"
                    sx={{
                      fontWeight: won ? 700 : 500,
                      color: won ? 'success.main' : 'text.primary',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {team.points === null ? '—' : formatPoints(team.points)}
                  </Typography>
                </Stack>
              );
            })}
          </Stack>

          {matchup.isTied && final && (
            <Typography variant="caption" sx={{ color: 'warning.main', fontWeight: 600 }}>
              Tied
            </Typography>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
