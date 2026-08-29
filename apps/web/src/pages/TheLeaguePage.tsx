import {
  Alert,
  Card,
  CardContent,
  Chip,
  Divider,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { useLeagueOverview, useLedger, usePublicHome } from '../hooks.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { EmptyState, PageHeader } from '../components/primitives.js';
import EmojiEventsIcon from '@mui/icons-material/EmojiEventsRounded';

/**
 * Where everyone stands over a whole season, and who has won what over the years.
 *
 * The one question the portal could not answer was "am I up or down". Challenges
 * were thirteen separate weeks, dues were an admin page, and nothing added them
 * together. This does, and nothing else.
 *
 * Deliberately not a second challenges page: no rules, no weekly detail, no
 * calculate button. If you want to know what this week is, that page owns it, and
 * duplicating it here would give both screens half a job.
 */
export function TheLeaguePage(): JSX.Element {
  const overview = useLeagueOverview(true);
  const publicHome = usePublicHome();

  const seasonYear =
    overview.data?.yahoo?.seasonYear ??
    overview.data?.league.currentSeasonYear ??
    publicHome.data?.seasonYear ??
    null;

  const ledger = useLedger(seasonYear);

  if (ledger.isLoading) {
    return (
      <Stack spacing={3}>
        <PageHeader title="The League" />
        <Skeleton height={320} sx={{ borderRadius: 4 }} />
      </Stack>
    );
  }

  if (ledger.isError) {
    return (
      <Stack spacing={3}>
        <PageHeader title="The League" />
        <ErrorNotice error={ledger.error} onRetry={() => void ledger.refetch()} />
      </Stack>
    );
  }

  const entries = ledger.data?.entries ?? [];
  const history = ledger.data?.history ?? [];

  return (
    <Stack spacing={4}>
      <PageHeader
        title="The League"
        description="Who is up, who is down, and who has to live with it."
      />

      {entries.length === 0 ? (
        <EmptyState
          icon={<EmojiEventsIcon />}
          title="Nothing to add up yet"
          description="Once dues are recorded and challenges start being won, everyone's running total appears here."
        />
      ) : (
        <SeasonTable entries={entries} seasonYear={ledger.data?.seasonYear ?? null} />
      )}

      <RecordBooks history={history} />
    </Stack>
  );
}

const money = (cents: number): string => {
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(abs % 100 === 0 ? 0 : 2)}`;
};

function SeasonTable({
  entries,
  seasonYear,
}: {
  entries: NonNullable<ReturnType<typeof useLedger>['data']>['entries'];
  seasonYear: number | null;
}): JSX.Element {
  const anyMoney = entries.some((entry) => entry.wonCents > 0);

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} alignItems="baseline" justifyContent="space-between">
        <Typography variant="h3">{seasonYear} so far</Typography>
        <Typography variant="caption" color="text.secondary">
          Net is prizes won minus what you are in for.
        </Typography>
      </Stack>

      {!anyMoney && (
        <Alert severity="info">
          No prize money has been recorded yet, so everyone is simply down their dues. Set what a
          challenge pays on the <RouterLink to="/money">dues and prizes</RouterLink> page and these
          fill in as weeks are won.
        </Alert>
      )}

      <Card>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Manager</TableCell>
                <TableCell align="right">Challenges</TableCell>
                <TableCell align="right">Won</TableCell>
                <TableCell align="right">Dues</TableCell>
                <TableCell align="right">Net</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map((entry) => {
                const duesSettled = entry.duesPaidCents >= entry.duesOwedCents;

                return (
                  <TableRow key={entry.leagueMemberId}>
                    <TableCell sx={{ fontWeight: 600 }}>{entry.name}</TableCell>

                    <TableCell align="right">
                      {entry.challengesWon === 0 ? (
                        <Typography variant="body2" color="text.disabled">
                          —
                        </Typography>
                      ) : (
                        <Chip size="small" label={entry.challengesWon} />
                      )}
                    </TableCell>

                    <TableCell align="right">
                      {entry.wonCents === 0 ? '—' : money(entry.wonCents)}
                    </TableCell>

                    <TableCell align="right">
                      <Tooltip
                        title={
                          duesSettled
                            ? 'Dues settled'
                            : `${money(entry.duesOwedCents - entry.duesPaidCents)} outstanding`
                        }
                      >
                        <Chip
                          size="small"
                          variant={duesSettled ? 'filled' : 'outlined'}
                          color={duesSettled ? 'success' : 'warning'}
                          label={duesSettled ? 'paid' : money(entry.duesOwedCents - entry.duesPaidCents)}
                        />
                      </Tooltip>
                    </TableCell>

                    <TableCell
                      align="right"
                      sx={{
                        fontWeight: 700,
                        whiteSpace: 'nowrap',
                        color:
                          entry.netCents > 0
                            ? 'success.main'
                            : entry.netCents < 0
                              ? 'error.main'
                              : 'text.secondary',
                      }}
                    >
                      {entry.netCents > 0 ? '+' : ''}
                      {money(entry.netCents)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>
    </Stack>
  );
}

/**
 * The record books.
 *
 * Champion, runner-up and Sacko, from the finish order the league already records
 * for the draft-order tiebreaker. Nothing new is stored to produce this.
 */
function RecordBooks({
  history,
}: {
  history: NonNullable<ReturnType<typeof useLedger>['data']>['history'];
}): JSX.Element {
  return (
    <Stack spacing={1.5}>
      <Typography variant="h3">The record books</Typography>

      {history.length === 0 ? (
        <Alert severity="info">
          No finished seasons are recorded yet. Once a season&rsquo;s final order is saved, its
          champion, runner-up and Sacko appear here for good.
        </Alert>
      ) : (
        <Stack spacing={1.5}>
          {history.map((season) => (
            <Card key={season.seasonYear} variant="filled">
              <CardContent>
                <Stack spacing={1.5}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="h6">{season.seasonYear}</Typography>
                    <Chip size="small" variant="outlined" label={`${season.teamCount} teams`} />
                  </Stack>

                  <Divider />

                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={{ xs: 1.5, sm: 4 }}
                    divider={<Divider orientation="vertical" flexItem />}
                  >
                    <Honour label="Champion" name={season.champion} tone="success.main" />
                    {season.runnerUp && (
                      <Honour label="Runner-up" name={season.runnerUp} tone="text.primary" />
                    )}
                    {season.sacko && (
                      <Honour
                        label="Sacko"
                        name={season.sacko}
                        tone="error.main"
                        hint="Last place. Carried until somebody else earns it."
                      />
                    )}
                  </Stack>
                </Stack>
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function Honour({
  label,
  name,
  tone,
  hint,
}: {
  label: string;
  name: string;
  tone: string;
  hint?: string;
}): JSX.Element {
  const body = (
    <Stack spacing={0.25}>
      <Typography variant="overline" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body1" sx={{ fontWeight: 700, color: tone }}>
        {name}
      </Typography>
    </Stack>
  );

  return hint ? <Tooltip title={hint}>{body}</Tooltip> : body;
}
