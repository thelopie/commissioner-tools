import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Link,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';
import {
  useChallenges,
  useConnection,
  useLeagueOverview,
  useSeedChallenges,
  useSession,
} from '../hooks.js';
import { ErrorNotice } from '../components/ErrorNotice.js';

/**
 * Weekly challenges.
 *
 * A blocked challenge shows its specific missing Yahoo field rather than an error.
 * The portal will not produce a winner from data it has not confirmed exists — an
 * invented number here would eventually decide who gets paid.
 */
export function ChallengesPage(): JSX.Element {
  const connection = useConnection();
  const overview = useLeagueOverview(connection.data?.connected ?? false);
  const seasonYear =
    overview.data?.yahoo?.seasonYear ?? overview.data?.league.currentSeasonYear ?? null;
  const challenges = useChallenges(seasonYear);
  const session = useSession();
  const seed = useSeedChallenges(seasonYear);
  const isCommissioner = session.data?.user?.role === 'commissioner';

  if (!connection.data?.connected) {
    return <Alert severity="info">Connect Yahoo to see weekly challenges.</Alert>;
  }

  if (seasonYear === null) {
    return (
      <Alert severity="info">Link a Yahoo league to a season to set up weekly challenges.</Alert>
    );
  }

  if (challenges.isLoading) return <Skeleton variant="rectangular" height={320} />;
  if (challenges.isError) {
    return <ErrorNotice error={challenges.error} onRetry={() => void challenges.refetch()} />;
  }

  const definitions = challenges.data?.definitions ?? [];
  const active = definitions.filter((definition) => definition.status === 'active');
  const blocked = definitions.filter((definition) => definition.status === 'blocked');

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h1">Weekly challenges</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {seasonYear} season · {active.length} calculable · {blocked.length} blocked
        </Typography>
      </Box>

      {definitions.length === 0 && (
        <Alert
          severity="info"
          // The action belongs on the message that describes it. Telling a
          // commissioner they "can add the rules" with no way to do it is a dead end.
          action={
            isCommissioner ? (
              <Button
                size="small"
                variant="contained"
                disabled={seed.isPending}
                onClick={() => seed.mutate()}
                sx={{ whiteSpace: 'nowrap' }}
              >
                {seed.isPending ? 'Adding…' : 'Add the 13 rules'}
              </Button>
            ) : undefined
          }
        >
          No challenge definitions yet. A commissioner can seed the thirteen proposed rules, then
          edit any of them — every rule is stored as configuration, so corrections need no code
          change.
        </Alert>
      )}

      {seed.isError && <ErrorNotice error={seed.error} hideRetry />}

      {blocked.length > 0 && (
        <Alert severity="warning">
          <Typography variant="body2">
            {blocked.length} challenge{blocked.length === 1 ? '' : 's'} cannot be calculated because
            the Yahoo data they need has not been verified against a real league. They are listed
            below with the specific gap. See <Link href="/yahoo-capabilities">Yahoo status</Link>.
          </Typography>
        </Alert>
      )}

      {active.length > 0 && (
        <Box>
          <Typography variant="h2" sx={{ mb: 1 }}>
            Calculable
          </Typography>
          <Stack spacing={1.5}>
            {active.map((definition) => (
              <ChallengeCard key={definition.slug} definition={definition} />
            ))}
          </Stack>
        </Box>
      )}

      {blocked.length > 0 && (
        <Box>
          <Typography variant="h2" sx={{ mb: 1 }}>
            Blocked
          </Typography>
          <Stack spacing={1.5}>
            {blocked.map((definition) => (
              <ChallengeCard key={definition.slug} definition={definition} />
            ))}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}

function ChallengeCard({
  definition,
}: {
  definition: NonNullable<ReturnType<typeof useChallenges>['data']>['definitions'][number];
}): JSX.Element {
  const blocked = definition.status === 'blocked';

  return (
    <Card sx={blocked ? { borderStyle: 'dashed' } : undefined}>
      <CardContent>
        <Stack spacing={1}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="h3" sx={{ flexGrow: 1 }}>
              {definition.name}
            </Typography>
            <Chip
              size="small"
              color={blocked ? 'warning' : definition.status === 'active' ? 'success' : 'default'}
              label={definition.status}
            />
          </Stack>

          <Typography variant="body2" color="text.secondary">
            {definition.description}
          </Typography>

          {blocked && definition.blockedReason && (
            <Alert severity="warning" sx={{ py: 0.5 }}>
              <Typography variant="caption">{definition.blockedReason}</Typography>
            </Alert>
          )}

          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
            <Chip
              size="small"
              variant="outlined"
              label={definition.benchCounts ? 'bench counts' : 'starters only'}
            />
            <Chip
              size="small"
              variant="outlined"
              label={definition.decimalsCount ? 'decimals count' : 'whole points'}
            />
            <Chip
              size="small"
              variant="outlined"
              label={definition.negativesCount ? 'negatives count' : 'negatives excluded'}
            />
            <Chip
              size="small"
              variant="outlined"
              label={`tiebreak: ${definition.tieBreakers.join(' → ')}`}
            />
          </Stack>

          <Typography variant="caption" color="text.secondary">
            Needs from Yahoo: {definition.requiredYahooData.join(', ')}
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  );
}
