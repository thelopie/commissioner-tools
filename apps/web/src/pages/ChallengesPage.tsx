import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Link,
  Skeleton,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import EmojiEventsIcon from '@mui/icons-material/EmojiEventsRounded';
import LockIcon from '@mui/icons-material/LockRounded';
import CheckCircleIcon from '@mui/icons-material/CheckCircleRounded';
import {
  useActivateChallenges,
  useCapabilities,
  useChallenges,
  useConnection,
  useLeagueOverview,
  useSeedChallenges,
  useSession,
} from '../hooks.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { useNotify } from '../components/SnackbarProvider.js';
import { EmptyState, PageHeader, SectionHeader } from '../components/primitives.js';
import { ChallengeResultsPanel } from './ChallengeResultsPanel.js';

/**
 * Weekly challenges.
 *
 * A blocked challenge shows the specific Yahoo field it is missing rather than an
 * error. The portal will not produce a winner from data it has not confirmed
 * exists — an invented number here would eventually decide who gets paid.
 */
export function ChallengesPage(): JSX.Element {
  const connection = useConnection();
  const overview = useLeagueOverview(connection.data?.connected ?? false);
  const seasonYear =
    overview.data?.yahoo?.seasonYear ?? overview.data?.league.currentSeasonYear ?? null;

  const challenges = useChallenges(seasonYear);
  const session = useSession();
  const seed = useSeedChallenges(seasonYear);
  const notify = useNotify();

  const isCommissioner = session.data?.user?.role === 'commissioner';
  const capabilities = useCapabilities();
  const activate = useActivateChallenges(seasonYear);

  /**
   * The tab lives in the URL so a link can point at either view.
   *
   * Results are the default: someone opening "Challenges" during the season wants
   * to know who won this week. The rulebook is read once a year.
   */
  const [params, setParams] = useSearchParams();
  const tab = params.get('view') === 'rules' ? 'rules' : 'results';

  useEffect(() => {
    if (seed.isSuccess) notify(`Added ${seed.data.seeded.length} challenge definitions.`);
  }, [seed.isSuccess, seed.data, notify]);

  if (!connection.data?.connected) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Weekly challenges" />
        <EmptyState
          icon={<EmojiEventsIcon />}
          title="Connect Yahoo first"
          description="Challenges are calculated from live Yahoo data, so the portal needs a connection before it can show them."
          action={
            <Button variant="contained" href="/auth/yahoo/start">
              Connect Yahoo
            </Button>
          }
        />
      </Stack>
    );
  }

  if (seasonYear === null) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Weekly challenges" />
        <EmptyState
          icon={<EmojiEventsIcon />}
          title="No season linked"
          description="Link a Yahoo league to a season on the dashboard, and the weekly challenges for that season appear here."
          action={
            <Button variant="tonal" href="/">
              Go to the dashboard
            </Button>
          }
        />
      </Stack>
    );
  }

  if (challenges.isLoading) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Weekly challenges" />
        <Stack spacing={1.5}>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} height={152} sx={{ borderRadius: 4 }} />
          ))}
        </Stack>
      </Stack>
    );
  }

  if (challenges.isError) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Weekly challenges" />
        <ErrorNotice error={challenges.error} onRetry={() => void challenges.refetch()} />
      </Stack>
    );
  }

  const definitions = challenges.data?.definitions ?? [];
  const verified = new Set(capabilities.data?.verifiedCapabilities ?? []);
  const hasData = (definition: { requiredYahooData: string[] }): boolean =>
    definition.requiredYahooData.every((capability) => verified.has(capability));

  /**
   * Counted against the live capability matrix, not the stored status.
   *
   * A definition's status is written once. If a capability is later withdrawn, the
   * stored status still says active while the API refuses to calculate it — so
   * trusting the status here would have the header claim eight calculable
   * challenges that produce nothing. The API re-checks; so must the count.
   */
  const active = definitions.filter(
    (definition) => definition.status === 'active' && hasData(definition),
  );
  const blocked = definitions.filter(
    (definition) => definition.status === 'blocked' || !hasData(definition),
  );

  /**
   * Blocked challenges whose Yahoo requirements are now all verified.
   *
   * Status was derived when the definition was seeded and is never re-derived, so
   * this comparison is the only thing that notices the matrix has moved on.
   */
  const unblockable = blocked.filter(
    (definition) => definition.status === 'blocked' && hasData(definition),
  );

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Weekly challenges"
        description={`${seasonYear} season`}
        action={
          definitions.length > 0 ? (
            <Stack direction="row" spacing={1}>
              <Chip
                icon={<CheckCircleIcon />}
                color={active.length > 0 ? 'success' : 'default'}
                label={`${active.length} calculable`}
              />
              <Chip
                icon={<LockIcon />}
                color={blocked.length > 0 ? 'warning' : 'default'}
                label={`${blocked.length} blocked`}
              />
            </Stack>
          ) : undefined
        }
      />

      <Tabs
        value={tab}
        onChange={(_, next) => setParams(next === 'rules' ? { view: 'rules' } : {})}
        sx={{ borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab value="results" label="Results" />
        <Tab value="rules" label={`Rules (${definitions.length})`} />
      </Tabs>

      {tab === 'results' && <ChallengeResultsPanel seasonYear={seasonYear} />}

      {tab === 'rules' && definitions.length === 0 && (
        <EmptyState
          icon={<EmojiEventsIcon />}
          title="No challenges yet"
          description={
            isCommissioner
              ? 'Add the thirteen proposed rules to get started. Every rule is stored as configuration — bench counting, decimals, negatives, tiebreakers — so correcting one is an edit here, never a code change.'
              : 'A commissioner needs to add the league’s weekly challenges.'
          }
          action={
            isCommissioner ? (
              <Button
                variant="contained"
                size="large"
                disabled={seed.isPending}
                onClick={() => seed.mutate()}
              >
                {seed.isPending ? 'Adding…' : 'Add the 13 rules'}
              </Button>
            ) : undefined
          }
        />
      )}

      {tab === 'rules' && seed.isError && <ErrorNotice error={seed.error} hideRetry />}

      {tab === 'rules' && isCommissioner && unblockable.length > 0 && (
        <Alert
          severity="success"
          action={
            <Button
              size="small"
              variant="contained"
              disabled={activate.isPending}
              onClick={() =>
                activate.mutate(
                  unblockable.map((definition) => definition.slug),
                  {
                    onSuccess: (data) =>
                      notify(
                        data.refused.length === 0
                          ? `Activated ${data.activated.length} challenge${
                              data.activated.length === 1 ? '' : 's'
                            }.`
                          : `Activated ${data.activated.length}, refused ${data.refused.length}.`,
                        data.refused.length === 0 ? 'success' : 'warning',
                      ),
                    onError: (error) => notify(error.message, 'error'),
                  },
                )
              }
            >
              {activate.isPending ? 'Activating…' : `Activate ${unblockable.length}`}
            </Button>
          }
        >
          <AlertTitle>
            Yahoo now confirms the data{' '}
            {unblockable.length === 1 ? 'a rule needs' : 'these rules need'}
          </AlertTitle>
          <Typography variant="body2">
            {unblockable.length} blocked{' '}
            {unblockable.length === 1 ? 'challenge is' : 'challenges are'} calculable now that their
            Yahoo fields are verified. They stay blocked until you turn them on.
          </Typography>
        </Alert>
      )}

      {tab === 'rules' && blocked.length > 0 && (
        <Alert severity="warning">
          <AlertTitle>
            {blocked.length} {blocked.length === 1 ? 'challenge is' : 'challenges are'} waiting on
            Yahoo
          </AlertTitle>
          <Typography variant="body2">
            The Yahoo data they need has not been verified against a real league yet, so nothing is
            calculated for them. Each one below names the specific gap. See{' '}
            <Link href="/yahoo-capabilities">Yahoo status</Link>.
          </Typography>
        </Alert>
      )}

      {tab === 'rules' && active.length > 0 && (
        <Box>
          <SectionHeader title="Calculable" count={active.length} />
          <Stack spacing={1.5}>
            {active.map((definition) => (
              <ChallengeCard key={definition.slug} definition={definition} />
            ))}
          </Stack>
        </Box>
      )}

      {tab === 'rules' && blocked.length > 0 && (
        <Box>
          <SectionHeader title="Blocked" count={blocked.length} />
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
    <Card
      sx={{
        // A muted left border marks "not running" without greying out the content,
        // which would make the rules themselves harder to read.
        borderLeft: 4,
        borderLeftStyle: 'solid',
        borderLeftColor: blocked ? 'warning.main' : 'success.main',
      }}
    >
      <CardContent>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="h3" sx={{ flexGrow: 1, minWidth: 0 }}>
              {definition.name}
            </Typography>
            <Chip
              size="small"
              color={blocked ? 'warning' : 'success'}
              label={blocked ? 'blocked' : 'calculable'}
            />
          </Stack>

          <Typography variant="body2" color="text.secondary">
            {definition.description}
          </Typography>

          {blocked && definition.blockedReason && (
            <Box
              sx={{
                p: 1.5,
                borderRadius: 2,
                bgcolor: 'background.surfaceContainerHighest',
                color: 'text.secondary',
              }}
            >
              <Typography variant="caption" sx={{ display: 'block', lineHeight: 1.5 }}>
                {definition.blockedReason}
              </Typography>
            </Box>
          )}

          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
            <RuleChip
              label={definition.benchCounts ? 'bench counts' : 'starters only'}
              hint="Whether players on the bench contribute to the value."
            />
            <RuleChip
              label={definition.decimalsCount ? 'decimals' : 'whole points'}
              hint="Whether fractional points count, or scores round first."
            />
            <RuleChip
              label={definition.negativesCount ? 'negatives count' : 'negatives excluded'}
              hint="Whether a negative score is eligible."
            />
            <RuleChip
              label={definition.tieBreakers.join(' → ')}
              hint="Tiebreakers, applied in order until one separates the leaders."
            />
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

function RuleChip({ label, hint }: { label: string; hint: string }): JSX.Element {
  return (
    <Tooltip title={hint}>
      <Chip size="small" variant="outlined" label={label} />
    </Tooltip>
  );
}
