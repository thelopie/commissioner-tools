import {
  Box,
  Card,
  CardContent,
  Chip,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import LeaderboardIcon from '@mui/icons-material/LeaderboardRounded';
import { useConnection, useLeagueOverview, useStandings } from '../hooks.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { EmptyState, Monogram, PageHeader, RelativeTime } from '../components/primitives.js';
import { formatPoints } from './HomePage.js';

/**
 * League standings.
 *
 * A table on wider screens and stacked cards on a phone. A twelve-row, six-column
 * table forced into 390px is unreadable however carefully it scrolls, so the small
 * layout is a different shape rather than the same shape compressed.
 */
export function StandingsPage(): JSX.Element {
  const connection = useConnection();
  const connected = connection.data?.connected ?? false;
  const standings = useStandings(connected);
  const overview = useLeagueOverview(connected);

  /**
   * The playoff cut, from Yahoo's own `num_playoff_teams`.
   *
   * Null when Yahoo does not report it, in which case no line is drawn. Guessing
   * six would draw a confident line in the wrong place.
   */
  const playoffLine = overview.data?.yahoo?.numPlayoffTeams ?? null;

  if (!connected) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Standings" />
        <EmptyState
          icon={<LeaderboardIcon />}
          title="Connect Yahoo to see standings"
          description="Standings are read live from Yahoo each time you open this page."
        />
      </Stack>
    );
  }

  if (standings.isLoading) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Standings" />
        <Skeleton height={520} sx={{ borderRadius: 4 }} />
      </Stack>
    );
  }

  if (standings.isError) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Standings" />
        <ErrorNotice error={standings.error} onRetry={() => void standings.refetch()} />
      </Stack>
    );
  }

  const rows = standings.data?.standings ?? [];

  if (rows.length === 0) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Standings" />
        <EmptyState
          icon={<LeaderboardIcon />}
          title="No standings yet"
          description="Yahoo has no standings for this league yet — usually because the season has not started."
        />
      </Stack>
    );
  }

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Standings"
        description={`${standings.data?.seasonYear} season`}
        action={<Chip label={`${rows.length} teams`} />}
      />

      {/* Wide layout: a real table. */}
      <Card sx={{ display: { xs: 'none', md: 'block' } }}>
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 56 }}>#</TableCell>
                <TableCell>Team</TableCell>
                <TableCell align="right">Record</TableCell>
                <TableCell align="right">Streak</TableCell>
                <TableCell align="right">Points for</TableCell>
                <TableCell align="right">Against</TableCell>
                <TableCell align="right">Diff</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row, index) => {
                const diff =
                  row.pointsFor !== null && row.pointsAgainst !== null
                    ? Math.round((row.pointsFor - row.pointsAgainst) * 10) / 10
                    : null;

                return (
                  <TableRow
                    key={row.yahooTeamKey}
                    sx={{
                      bgcolor: row.isYou ? 'background.surfaceContainerHigh' : undefined,
                      // The playoff cut is the line everyone watches. All three
                      // border properties must be conditional together — setting
                      // colour and style unconditionally drew a dashed green line
                      // under every row.
                      ...(playoffLine !== null && index + 1 === playoffLine
                        ? {
                            '& td': {
                              borderBottomWidth: 2,
                              borderBottomColor: 'primary.main',
                              borderBottomStyle: 'dashed',
                            },
                          }
                        : {}),
                    }}
                  >
                    <TableCell sx={{ fontWeight: 700, color: 'text.secondary' }}>
                      {row.rank ?? index + 1}
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1.25} alignItems="center">
                        <Monogram name={row.name} size={32} />
                        <Box sx={{ minWidth: 0 }}>
                          <Stack direction="row" spacing={0.75} alignItems="center">
                            <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                              {row.name}
                            </Typography>
                            {row.isYou && <Chip size="small" color="primary" label="you" />}
                          </Stack>
                          <Typography variant="caption" color="text.secondary" noWrap>
                            {row.managers.join(', ')}
                          </Typography>
                        </Box>
                      </Stack>
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {row.record ?? '—'}
                    </TableCell>
                    <TableCell align="right">
                      {row.streak ? (
                        <Chip
                          size="small"
                          variant="outlined"
                          color={row.streak.startsWith('W') ? 'success' : 'default'}
                          label={row.streak}
                        />
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                      {row.pointsFor === null ? '—' : formatPoints(row.pointsFor)}
                    </TableCell>
                    <TableCell align="right" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
                      {row.pointsAgainst === null ? '—' : formatPoints(row.pointsAgainst)}
                    </TableCell>
                    <TableCell
                      align="right"
                      sx={{
                        whiteSpace: 'nowrap',
                        fontWeight: 600,
                        color:
                          diff === null
                            ? 'text.secondary'
                            : diff >= 0
                              ? 'success.main'
                              : 'error.main',
                      }}
                    >
                      {diff === null ? '—' : `${diff >= 0 ? '+' : ''}${formatPoints(diff)}`}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>

      {/* Narrow layout: one card per team, not a squeezed table. */}
      <Stack spacing={1} sx={{ display: { xs: 'flex', md: 'none' } }}>
        {rows.map((row, index) => (
          <Card
            key={row.yahooTeamKey}
            sx={{
              bgcolor: row.isYou ? 'background.surfaceContainerHigh' : undefined,
              borderColor: row.isYou ? 'primary.main' : undefined,
            }}
          >
            <CardContent sx={{ py: 1.5 }}>
              <Stack direction="row" spacing={1.5} alignItems="center">
                <Typography
                  variant="h3"
                  sx={{ width: 28, textAlign: 'center', color: 'text.secondary', fontWeight: 700 }}
                >
                  {row.rank ?? index + 1}
                </Typography>
                <Monogram name={row.name} size={36} />

                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                  <Stack direction="row" spacing={0.75} alignItems="center">
                    <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>
                      {row.name}
                    </Typography>
                    {row.isYou && <Chip size="small" color="primary" label="you" />}
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    {row.record ?? '—'}
                    {row.pointsFor !== null && ` · ${formatPoints(row.pointsFor)} pts`}
                    {row.streak && ` · ${row.streak}`}
                  </Typography>
                </Box>
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Stack>

      {playoffLine !== null && (
        <Typography variant="caption" color="text.secondary">
          The dashed line marks the playoff cut — Yahoo reports {playoffLine} playoff spots.
        </Typography>
      )}

      <Typography variant="caption" color="text.secondary">
        Read live from Yahoo <RelativeTime value={standings.data?.fetchedAt} underline={false} />.
        Standings are not stored — a season&rsquo;s final order is recorded separately so
        draft-order tiebreakers still work years later.
      </Typography>
    </Stack>
  );
}
