import { useEffect, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  IconButton,
  Link,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid2';
import RefreshIcon from '@mui/icons-material/RefreshRounded';
import CheckCircleIcon from '@mui/icons-material/CheckCircleRounded';
import LinkOffIcon from '@mui/icons-material/LinkOffRounded';
import GroupsIcon from '@mui/icons-material/GroupsRounded';
import EmojiEventsIcon from '@mui/icons-material/EmojiEventsRounded';
import HowToRegIcon from '@mui/icons-material/HowToRegRounded';
import SportsFootballIcon from '@mui/icons-material/SportsFootballRounded';
import { useSearchParams } from 'react-router-dom';
import {
  useConfirmDisplayName,
  useConnection,
  useDisconnectYahoo,
  useLeagueOverview,
  useManualRefresh,
  useSelectLeague,
  useSession,
  useYahooLeagues,
} from '../hooks.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { useNotify } from '../components/SnackbarProvider.js';
import {
  DataPoint,
  EmptyState,
  Monogram,
  PageHeader,
  RelativeTime,
  SectionHeader,
} from '../components/primitives.js';
import { describeOAuthError } from './SignInPage.js';

/**
 * Commissioner tools.
 *
 * The administrative surface: connection health, league linking, team mapping.
 * Deliberately NOT the home screen — a league member has no reason to look at
 * OAuth token rotation counts, and leading with them was the reason the first
 * build gave managers nothing to come back for.
 *
 * Ordered by what needs a decision, not by what is easy to render.
 */
export function CommissionerPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const session = useSession();
  const connection = useConnection();

  const connected = connection.data?.connected ?? false;
  const overview = useLeagueOverview(connected);

  const yahooError = params.get('yahooError');
  const isWelcome = params.get('welcome') === '1';

  const user = session.data?.user ?? null;
  const isCommissioner = user?.role === 'commissioner';
  const needsName = user !== null && !user.displayNameConfirmed;
  const needsLeague = connected && overview.data?.linked === false;

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Commissioner tools"
        description={
          overview.data?.league.name
            ? `${overview.data.league.name} · Yahoo connection, league linking, and team mapping.`
            : 'Yahoo connection, league linking, and team mapping.'
        }
      />

      {yahooError && (
        <Alert
          severity={describeOAuthError(yahooError).severity}
          onClose={() => {
            params.delete('yahooError');
            setParams(params, { replace: true });
          }}
        >
          {describeOAuthError(yahooError).message}
        </Alert>
      )}

      {/* Things asking for a decision, before anything informational. */}
      {(needsName || needsLeague || !connected) && (
        <Stack spacing={2}>
          <SectionHeader title="Needs your attention" />

          {needsName && user && (
            <ConfirmNameCard
              userId={user.userId}
              suggested={user.displayName}
              isWelcome={isWelcome}
            />
          )}

          {!connected && <ConnectPrompt status={connection.data?.status} />}

          {needsLeague && isCommissioner && <LeaguePicker />}

          {needsLeague && !isCommissioner && (
            <Alert severity="info">
              No Yahoo league is linked yet. A commissioner needs to choose one.
            </Alert>
          )}
        </Stack>
      )}

      {connected && <ConnectionCard />}

      {connected && <LeagueSection />}
    </Stack>
  );
}

/**
 * Display-name confirmation.
 *
 * Prefilled from Yahoo and confirmed here, at which point it becomes portal data.
 * This is the only durable name in the system: a finalized 2021 challenge result
 * still needs a label after that manager has left the league.
 */
function ConfirmNameCard({
  userId,
  suggested,
  isWelcome,
}: {
  userId: string;
  suggested: string;
  isWelcome: boolean;
}): JSX.Element {
  const [name, setName] = useState(suggested);
  const confirm = useConfirmDisplayName(userId);
  const notify = useNotify();

  useEffect(() => {
    if (confirm.isSuccess) notify('Display name saved.');
  }, [confirm.isSuccess, notify]);

  return (
    <Card variant="filled" sx={{ borderLeft: 4, borderColor: 'primary.main' }}>
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h3">
              {isWelcome ? 'Welcome — confirm your name' : 'Confirm your display name'}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, maxWidth: '62ch' }}>
              Prefilled from Yahoo. Confirm or change it, and it becomes your portal name — used on
              league records that outlive the Yahoo connection. It is the only name the portal
              stores.
            </Typography>
          </Box>

          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.5}
            alignItems={{ sm: 'center' }}
          >
            <TextField
              label="Display name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              size="small"
              fullWidth
              sx={{ maxWidth: { sm: 320 } }}
            />
            <Button
              variant="contained"
              disabled={name.trim().length === 0 || confirm.isPending}
              onClick={() => confirm.mutate(name.trim())}
              sx={{ flexShrink: 0 }}
            >
              {confirm.isPending ? 'Saving…' : 'Confirm'}
            </Button>
          </Stack>

          {confirm.isError && <ErrorNotice error={confirm.error} hideRetry />}
        </Stack>
      </CardContent>
    </Card>
  );
}

function ConnectPrompt({ status }: { status?: string | undefined }): JSX.Element {
  const needsReconnect = status === 'needs_reconnect';

  return (
    <EmptyState
      icon={<LinkOffIcon />}
      title={needsReconnect ? 'Yahoo access needs renewing' : 'Connect your Yahoo account'}
      description={
        needsReconnect
          ? 'Reconnecting takes a moment and changes nothing in your league. The portal only ever reads.'
          : 'The portal requests read-only Fantasy access so it can show live scores, rosters, and standings. It can never change anything in Yahoo.'
      }
      action={
        <Button variant="contained" size="large" href="/auth/yahoo/start">
          {needsReconnect ? 'Reconnect Yahoo' : 'Connect Yahoo'}
        </Button>
      }
    />
  );
}

/** Connection health: last success, last failure, token rotation. */
function ConnectionCard(): JSX.Element {
  const connection = useConnection();
  const disconnect = useDisconnectYahoo();
  const notify = useNotify();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (disconnect.isSuccess) notify('Yahoo connection removed and cached data cleared.');
  }, [disconnect.isSuccess, notify]);

  if (connection.isLoading) {
    return (
      <Card>
        <CardContent>
          <Skeleton width={180} height={28} />
          <Skeleton height={72} sx={{ mt: 1.5 }} />
        </CardContent>
      </Card>
    );
  }

  if (connection.isError) {
    return (
      <Card>
        <CardContent>
          <ErrorNotice error={connection.error} onRetry={() => void connection.refetch()} />
        </CardContent>
      </Card>
    );
  }

  const data = connection.data;
  const hasFailure = Boolean(data?.lastFailureAt);

  return (
    <Card>
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap" useFlexGap>
            <CheckCircleIcon sx={{ color: 'success.main' }} />
            <Typography variant="h2" sx={{ flexGrow: 1 }}>
              Yahoo connection
            </Typography>
            <Chip size="small" color="success" label="Connected" />
            <Chip size="small" variant="outlined" label="read-only" />
          </Stack>

          <Grid container spacing={2}>
            <Grid size={{ xs: 6, sm: 4, md: 3 }}>
              <DataPoint
                label="Last success"
                value={<RelativeTime value={data?.lastSuccessAt} />}
              />
            </Grid>
            <Grid size={{ xs: 6, sm: 4, md: 3 }}>
              <DataPoint
                label="Last failure"
                value={hasFailure ? <RelativeTime value={data?.lastFailureAt} /> : 'None'}
                tone={hasFailure ? 'warning' : 'muted'}
                {...(hasFailure && data?.lastFailureReason
                  ? { hint: `Reason: ${data.lastFailureReason}` }
                  : {})}
              />
            </Grid>
            <Grid size={{ xs: 6, sm: 4, md: 3 }}>
              <DataPoint
                label="Token refreshed"
                value={<RelativeTime value={data?.lastRefreshedAt} />}
              />
            </Grid>
            <Grid size={{ xs: 6, sm: 4, md: 3 }}>
              <DataPoint
                label="Token rotations"
                value={String(data?.refreshTokenRotations ?? 0)}
                hint="Yahoo may issue a new refresh token on renewal. The portal handles either behavior."
              />
            </Grid>
          </Grid>

          <Divider />

          <Stack spacing={1.5}>
            {!confirming ? (
              <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
                <Button
                  size="small"
                  color="error"
                  variant="outlined"
                  onClick={() => setConfirming(true)}
                >
                  Remove connection
                </Button>
                <Typography variant="caption" color="text.secondary">
                  Deletes the stored credentials and every cached Yahoo response for your account.
                </Typography>
              </Stack>
            ) : (
              // Two-step rather than a browser confirm(): this deletes credentials,
              // and a mis-click should not be enough to do it.
              <Alert severity="warning">
                <AlertTitle>Remove the Yahoo connection?</AlertTitle>
                <Typography variant="body2" sx={{ mb: 1.5 }}>
                  Stored credentials and all cached Yahoo data are deleted immediately. League
                  records stay. You can reconnect at any time.
                </Typography>
                <Stack direction="row" spacing={1}>
                  <Button
                    size="small"
                    color="error"
                    variant="contained"
                    disabled={disconnect.isPending}
                    onClick={() => {
                      disconnect.mutate();
                      setConfirming(false);
                    }}
                  >
                    {disconnect.isPending ? 'Removing…' : 'Remove'}
                  </Button>
                  <Button size="small" variant="text" onClick={() => setConfirming(false)}>
                    Keep it
                  </Button>
                </Stack>
              </Alert>
            )}

            {disconnect.isError && <ErrorNotice error={disconnect.error} hideRetry />}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

/** League selection. Nothing hardcoded — these come from the user's own account. */
function LeaguePicker(): JSX.Element {
  const leagues = useYahooLeagues(true);
  const select = useSelectLeague();
  const notify = useNotify();

  useEffect(() => {
    if (select.isSuccess) notify('League linked.');
  }, [select.isSuccess, notify]);

  return (
    <Card variant="filled" sx={{ borderLeft: 4, borderColor: 'primary.main' }}>
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h3">Choose the league</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
              These are the football leagues your Yahoo account can see.
            </Typography>
          </Box>

          {leagues.isLoading && (
            <Stack spacing={1.5}>
              <Skeleton height={92} />
              <Skeleton height={92} />
            </Stack>
          )}

          {leagues.isError && (
            <ErrorNotice error={leagues.error} onRetry={() => void leagues.refetch()} />
          )}

          {leagues.data?.leagues.length === 0 && (
            <Alert severity="info">
              Yahoo returned no football leagues for this account. If you expected some, check that
              you signed in with the right Yahoo account.
            </Alert>
          )}

          <Stack spacing={1.5}>
            {leagues.data?.leagues.map((league) => (
              <Card
                key={league.yahooLeagueKey}
                sx={{ bgcolor: 'background.surfaceContainerLowest' }}
              >
                <CardContent sx={{ py: 2 }}>
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={2}
                    alignItems={{ sm: 'center' }}
                  >
                    <Monogram name={league.name} size={44} />

                    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                      <Typography variant="subtitle1" noWrap sx={{ fontWeight: 700 }}>
                        {league.name}
                      </Typography>
                      <Stack
                        direction="row"
                        spacing={0.75}
                        sx={{ mt: 0.75 }}
                        flexWrap="wrap"
                        useFlexGap
                      >
                        {league.season !== null && <Chip size="small" label={`${league.season}`} />}
                        {league.teamCount !== null && (
                          <Chip size="small" label={`${league.teamCount} teams`} />
                        )}
                        {league.isYahooCommissioner && (
                          <Tooltip title="Yahoo says you are its commissioner. This grants nothing in the portal — portal roles are set here.">
                            <Chip size="small" color="info" label="Yahoo commissioner" />
                          </Tooltip>
                        )}
                        {league.isFinished && (
                          <Chip size="small" variant="outlined" label="finished" />
                        )}
                      </Stack>
                    </Box>

                    <Button
                      variant="contained"
                      disabled={select.isPending || league.season === null}
                      onClick={() =>
                        select.mutate({
                          yahooLeagueKey: league.yahooLeagueKey,
                          yahooGameKey: league.yahooGameKey,
                          seasonYear: league.season!,
                        })
                      }
                      sx={{ flexShrink: 0 }}
                    >
                      {select.isPending ? 'Linking…' : 'Use this league'}
                    </Button>
                  </Stack>
                </CardContent>
              </Card>
            ))}
          </Stack>

          {select.isError && <ErrorNotice error={select.error} hideRetry />}
        </Stack>
      </CardContent>
    </Card>
  );
}

/** Live league state: metadata, teams, managers, and a manual refresh. */
function LeagueSection(): JSX.Element {
  const overview = useLeagueOverview(true);
  const refresh = useManualRefresh();
  const notify = useNotify();

  useEffect(() => {
    if (refresh.isSuccess) notify('Refreshed from Yahoo.');
  }, [refresh.isSuccess, notify]);

  if (overview.isLoading) {
    return (
      <Box>
        <SectionHeader title="League" />
        <Card>
          <CardContent>
            <Skeleton width={240} height={32} />
            <Skeleton width={360} height={24} sx={{ mt: 1 }} />
            <Grid container spacing={2} sx={{ mt: 2 }}>
              {Array.from({ length: 6 }, (_, index) => (
                <Grid size={{ xs: 12, sm: 6, md: 4 }} key={index}>
                  <Skeleton height={96} />
                </Grid>
              ))}
            </Grid>
          </CardContent>
        </Card>
      </Box>
    );
  }

  if (overview.isError) {
    return (
      <Box>
        <SectionHeader title="League" />
        <ErrorNotice error={overview.error} onRetry={() => void overview.refetch()} />
      </Box>
    );
  }

  if (!overview.data?.linked || !overview.data.yahoo) return <></>;

  const yahoo = overview.data.yahoo;
  const unmapped = yahoo.teams.filter((team) => team.leagueMemberId === null).length;

  return (
    <Box>
      <SectionHeader
        title="League"
        action={
          <Tooltip title="Fetch fresh data from Yahoo now, bypassing the short-lived cache">
            <span>
              <IconButton
                onClick={() => refresh.mutate()}
                disabled={refresh.isPending}
                aria-label="Refresh league data from Yahoo"
              >
                {refresh.isPending ? <CircularProgress size={20} /> : <RefreshIcon />}
              </IconButton>
            </span>
          </Tooltip>
        }
      />

      <Stack spacing={2}>
        <Collapse in={refresh.isError} unmountOnExit>
          <Box>
            {refresh.isError && (
              // A failed refresh is usually transient, so the notice offers the
              // retry directly rather than telling the user to find the button.
              <ErrorNotice error={refresh.error} onRetry={() => refresh.mutate()} />
            )}
          </Box>
        </Collapse>

        <Grid container spacing={2}>
          <StatTile icon={<SportsFootballIcon />} label="Week" value={yahoo.currentWeek ?? '—'} />
          <StatTile
            icon={<GroupsIcon />}
            label="Teams"
            value={yahoo.teamCount ?? yahoo.teams.length}
          />
          <StatTile
            icon={<EmojiEventsIcon />}
            label="Playoffs"
            value={yahoo.playoffStartWeek === null ? '—' : `Week ${yahoo.playoffStartWeek}`}
          />
          <StatTile icon={<HowToRegIcon />} label="Draft" value={yahoo.draftStatus ?? '—'} />
        </Grid>

        {unmapped > 0 && (
          <Alert severity="info">
            <AlertTitle>
              {unmapped} of {yahoo.teams.length} teams not yet mapped
            </AlertTitle>
            <Typography variant="body2">
              Mapping Yahoo teams to portal members is what lets league records survive after a
              manager leaves — challenge results are keyed to portal members, not to Yahoo teams.
            </Typography>
          </Alert>
        )}

        <Box>
          <SectionHeader title="Teams and managers" count={yahoo.teams.length} />
          <Grid container spacing={1.5}>
            {yahoo.teams.map((team) => (
              <Grid size={{ xs: 12, sm: 6, lg: 4 }} key={team.yahooTeamKey}>
                <Card sx={{ height: '100%' }}>
                  <CardContent sx={{ py: 2 }}>
                    <Stack direction="row" spacing={1.5} alignItems="flex-start">
                      <Monogram name={team.name} />
                      <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 700 }} noWrap>
                          {team.name}
                        </Typography>
                        {team.managers.map((manager) => (
                          <Stack
                            key={manager.nickname}
                            direction="row"
                            spacing={0.5}
                            alignItems="center"
                            flexWrap="wrap"
                            useFlexGap
                            sx={{ mt: 0.5 }}
                          >
                            <Typography variant="body2" color="text.secondary" noWrap>
                              {manager.nickname}
                            </Typography>
                            {manager.isYou && <Chip size="small" color="primary" label="you" />}
                            {manager.isYahooCommissioner && (
                              <Chip size="small" variant="outlined" label="Yahoo comm." />
                            )}
                          </Stack>
                        ))}
                        {team.leagueMemberId === null && (
                          <Typography
                            variant="caption"
                            sx={{ color: 'warning.main', mt: 0.5, display: 'block' }}
                          >
                            not mapped
                          </Typography>
                        )}
                      </Box>
                    </Stack>
                  </CardContent>
                </Card>
              </Grid>
            ))}
          </Grid>
        </Box>

        <Typography variant="caption" color="text.secondary">
          Read live from Yahoo{' '}
          {overview.data.fetchedAt && (
            <RelativeTime value={overview.data.fetchedAt} underline={false} />
          )}
          . Team and manager names come from Yahoo on every load and are not stored — see{' '}
          <Link href="/yahoo-capabilities">Yahoo status</Link> for what the portal can and cannot
          read.
        </Typography>
      </Stack>
    </Box>
  );
}

function StatTile({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
}): JSX.Element {
  return (
    <Grid size={{ xs: 6, md: 3 }}>
      <Card variant="filled" sx={{ height: '100%' }}>
        <CardContent sx={{ py: 2 }}>
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{ color: 'text.secondary', mb: 0.5 }}
          >
            {icon}
            <Typography
              variant="caption"
              sx={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}
            >
              {label}
            </Typography>
          </Stack>
          <Typography variant="h2" sx={{ fontWeight: 600, textTransform: 'capitalize' }}>
            {value}
          </Typography>
        </CardContent>
      </Card>
    </Grid>
  );
}
