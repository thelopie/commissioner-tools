import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Link,
  List,
  ListItem,
  ListItemText,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid2';
import RefreshIcon from '@mui/icons-material/Refresh';
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
import { describeOAuthError } from './SignInPage.js';

/**
 * The commissioner dashboard.
 *
 * This is the vertical slice: connection status, league selection, league
 * metadata, teams and managers, last API success or failure, and a manual refresh.
 * Everything Yahoo-derived here is read live on each load, not stored.
 */
export function DashboardPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const session = useSession();
  const connection = useConnection();

  const connected = connection.data?.connected ?? false;
  const overview = useLeagueOverview(connected);
  const refresh = useManualRefresh();

  const yahooError = params.get('yahooError');
  const isWelcome = params.get('welcome') === '1';

  const user = session.data?.user ?? null;
  const isCommissioner = user?.role === 'commissioner';

  return (
    <Stack spacing={2.5}>
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

      {user && !user.displayNameConfirmed && (
        <ConfirmNameCard userId={user.userId} suggested={user.displayName} isWelcome={isWelcome} />
      )}

      <ConnectionCard />

      {connected && overview.data?.linked === false && isCommissioner && <LeaguePickerCard />}

      {connected && overview.data?.linked === false && !isCommissioner && (
        <Alert severity="info">
          No Yahoo league is linked yet. A commissioner needs to choose one.
        </Alert>
      )}

      {connected && (
        <Card>
          <CardContent>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1, flexWrap: 'wrap' }}>
              <Typography variant="h2" sx={{ flexGrow: 1 }}>
                League
              </Typography>

              <Tooltip title="Fetch fresh data from Yahoo now, bypassing the short-lived cache">
                <span>
                  <IconButton
                    onClick={() => refresh.mutate()}
                    disabled={refresh.isPending || !overview.data?.linked}
                    aria-label="Refresh league data from Yahoo"
                  >
                    {refresh.isPending ? <CircularProgress size={20} /> : <RefreshIcon />}
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>

            {overview.isLoading && <Skeleton variant="rectangular" height={160} />}

            {overview.isError && (
              <ErrorNotice error={overview.error} onRetry={() => void overview.refetch()} />
            )}

            {refresh.isError && <ErrorNotice error={refresh.error} hideRetry />}

            {overview.data?.linked && overview.data.yahoo && (
              <LeagueDetails overview={overview.data} />
            )}
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}

/**
 * Display-name confirmation.
 *
 * Prefilled from the Yahoo nickname and confirmed here, at which point it becomes
 * portal data. This is the one durable name in the system: a finalized 2021
 * challenge result still needs a label after that manager has left the league or
 * the Yahoo connection has lapsed.
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

  return (
    <Card sx={{ borderColor: 'primary.main' }}>
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h3">
            {isWelcome ? 'Welcome â€” confirm your name' : 'Confirm your display name'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            We prefilled this from Yahoo. Confirm or change it, and it becomes your portal name â€”
            used on league records that outlive the Yahoo connection. This is the only name the
            portal stores; everything else about your Yahoo profile stays with Yahoo.
          </Typography>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              label="Display name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              size="small"
              fullWidth
            />
            <Button
              variant="contained"
              disabled={name.trim().length === 0 || confirm.isPending}
              onClick={() => confirm.mutate(name.trim())}
              sx={{ whiteSpace: 'nowrap' }}
            >
              {confirm.isPending ? 'Savingâ€¦' : 'Confirm'}
            </Button>
          </Stack>

          {confirm.isError && <ErrorNotice error={confirm.error} hideRetry />}
        </Stack>
      </CardContent>
    </Card>
  );
}

/** Connection status, including last success and last failure. */
function ConnectionCard(): JSX.Element {
  const connection = useConnection();
  const disconnect = useDisconnectYahoo();

  if (connection.isLoading) {
    return (
      <Card>
        <CardContent>
          <Skeleton height={80} />
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
  const connected = data?.connected ?? false;
  const needsReconnect = data?.status === 'needs_reconnect';

  return (
    <Card>
      <CardContent>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
            <Typography variant="h2" sx={{ flexGrow: 1 }}>
              Yahoo connection
            </Typography>

            <Chip
              size="small"
              color={connected ? 'success' : needsReconnect ? 'warning' : 'default'}
              label={connected ? 'Connected' : needsReconnect ? 'Needs reconnect' : 'Not connected'}
            />

            {data?.yahooMode === 'mock' && <Chip size="small" color="warning" label="mock mode" />}
          </Stack>

          {!connected && (
            <Stack spacing={1} alignItems="flex-start">
              <Typography variant="body2" color="text.secondary">
                {needsReconnect
                  ? 'Yahoo access needs renewing. Reconnecting takes a moment and changes nothing in your league.'
                  : 'Connect a Yahoo account with read-only Fantasy access to load league data.'}
              </Typography>
              <Button variant="contained" href="/auth/yahoo/start">
                {needsReconnect ? 'Reconnect Yahoo' : 'Connect Yahoo'}
              </Button>
            </Stack>
          )}

          {connected && (
            <>
              <Grid container spacing={1.5}>
                <StatusField
                  label="Last successful request"
                  value={formatTimestamp(data?.lastSuccessAt)}
                />
                <StatusField
                  label="Last failure"
                  value={
                    data?.lastFailureAt
                      ? `${formatTimestamp(data.lastFailureAt)} (${data.lastFailureReason ?? 'unknown'})`
                      : 'None'
                  }
                />
                <StatusField
                  label="Last token refresh"
                  value={formatTimestamp(data?.lastRefreshedAt)}
                />
                <StatusField
                  label="Refresh-token rotations"
                  value={String(data?.refreshTokenRotations ?? 0)}
                  // Worth surfacing: Yahoo documents rotation as optional, so this
                  // is evidence of what actually happens in practice.
                  hint="Yahoo may issue a new refresh token on renewal; the portal handles either behavior."
                />
                <StatusField label="Granted scope" value={data?.grantedScope ?? 'not reported'} />
                <StatusField
                  label="Capability list reviewed"
                  value={data?.capabilityMatrixReviewedAt ?? 'unknown'}
                />
              </Grid>

              <Divider />

              <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                <Button
                  size="small"
                  color="error"
                  variant="outlined"
                  onClick={() => disconnect.mutate()}
                  disabled={disconnect.isPending}
                >
                  {disconnect.isPending ? 'Removingâ€¦' : 'Remove Yahoo connection'}
                </Button>
                <Typography variant="caption" color="text.secondary">
                  Deletes the stored credentials and every cached Yahoo response for your account.
                </Typography>
              </Stack>

              {disconnect.isError && <ErrorNotice error={disconnect.error} hideRetry />}
            </>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

/** League selection. Nothing is hardcoded â€” these come from the user's account. */
function LeaguePickerCard(): JSX.Element {
  const leagues = useYahooLeagues(true);
  const select = useSelectLeague();

  return (
    <Card sx={{ borderColor: 'primary.main' }}>
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h2">Choose the league</Typography>
          <Typography variant="body2" color="text.secondary">
            These are the football leagues your Yahoo account can see. Pick the one this portal
            manages.
          </Typography>

          {leagues.isLoading && <Skeleton height={120} />}

          {leagues.isError && (
            <ErrorNotice error={leagues.error} onRetry={() => void leagues.refetch()} />
          )}

          {leagues.data?.leagues.length === 0 && (
            <Alert severity="info">
              Yahoo returned no football leagues for this account. If you expected some, check that
              you signed in with the right Yahoo account.
            </Alert>
          )}

          <Stack spacing={1}>
            {leagues.data?.leagues.map((league) => (
              <Card key={league.yahooLeagueKey} variant="outlined">
                <CardContent sx={{ py: 1.5 }}>
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1.5}
                    alignItems={{ sm: 'center' }}
                  >
                    <Box sx={{ flexGrow: 1 }}>
                      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                        {league.name}
                      </Typography>
                      <Stack direction="row" spacing={0.75} sx={{ mt: 0.5, flexWrap: 'wrap' }}>
                        {league.season !== null && (
                          <Chip size="small" label={`${league.season} season`} />
                        )}
                        {league.teamCount !== null && (
                          <Chip size="small" label={`${league.teamCount} teams`} />
                        )}
                        {league.isYahooCommissioner && (
                          <Tooltip title="Yahoo says you are its commissioner. This grants nothing in the portal â€” portal roles are set here.">
                            <Chip size="small" color="info" label="Yahoo commissioner" />
                          </Tooltip>
                        )}
                        {league.isFinished && <Chip size="small" label="finished" />}
                      </Stack>
                    </Box>

                    <Button
                      variant="contained"
                      size="small"
                      disabled={select.isPending || league.season === null}
                      onClick={() =>
                        select.mutate({
                          yahooLeagueKey: league.yahooLeagueKey,
                          yahooGameKey: league.yahooGameKey,
                          seasonYear: league.season!,
                        })
                      }
                    >
                      {select.isPending ? 'Linkingâ€¦' : 'Use this league'}
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

function LeagueDetails({
  overview,
}: {
  overview: NonNullable<ReturnType<typeof useLeagueOverview>['data']>;
}): JSX.Element {
  const yahoo = overview.yahoo!;
  const unmapped = yahoo.teams.filter((team) => team.leagueMemberId === null).length;

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h3">{yahoo.name}</Typography>
        <Stack direction="row" spacing={0.75} sx={{ mt: 0.75, flexWrap: 'wrap' }}>
          {yahoo.season !== null && <Chip size="small" label={`${yahoo.season} season`} />}
          {yahoo.currentWeek !== null && <Chip size="small" label={`week ${yahoo.currentWeek}`} />}
          {yahoo.teamCount !== null && <Chip size="small" label={`${yahoo.teamCount} teams`} />}
          {yahoo.scoringType && <Chip size="small" label={yahoo.scoringType} />}
          {yahoo.playoffStartWeek !== null && (
            <Chip size="small" label={`playoffs week ${yahoo.playoffStartWeek}`} />
          )}
          {yahoo.draftStatus && <Chip size="small" label={`draft: ${yahoo.draftStatus}`} />}
        </Stack>
      </Box>

      {unmapped > 0 && (
        <Alert severity="info">
          {unmapped} of {yahoo.teams.length} Yahoo teams are not yet mapped to portal members.
          Mapping them is what lets league records survive after a manager leaves â€” challenge
          results are keyed to portal members, not to Yahoo teams.
        </Alert>
      )}

      <Divider />

      <Box>
        <Typography variant="h3" sx={{ mb: 1 }}>
          Teams and managers
        </Typography>
        <Grid container spacing={1.5}>
          {yahoo.teams.map((team) => (
            <Grid size={{ xs: 12, sm: 6, md: 4 }} key={team.yahooTeamKey}>
              <Card variant="outlined" sx={{ height: '100%' }}>
                <CardContent sx={{ py: 1.5 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                    {team.name}
                  </Typography>
                  <List dense disablePadding>
                    {team.managers.map((manager) => (
                      <ListItem key={manager.nickname} disableGutters sx={{ py: 0.25 }}>
                        <ListItemText
                          primary={
                            <Stack
                              direction="row"
                              spacing={0.5}
                              alignItems="center"
                              flexWrap="wrap"
                            >
                              <Typography variant="body2">{manager.nickname}</Typography>
                              {manager.isYou && <Chip size="small" color="primary" label="you" />}
                              {manager.isYahooCommissioner && (
                                <Chip size="small" label="Yahoo comm." />
                              )}
                            </Stack>
                          }
                        />
                      </ListItem>
                    ))}
                  </List>
                  {team.leagueMemberId === null && (
                    <Typography variant="caption" color="warning.main">
                      not mapped to a portal member
                    </Typography>
                  )}
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Box>

      <Typography variant="caption" color="text.secondary">
        Read live from Yahoo
        {overview.fetchedAt ? ` at ${new Date(overview.fetchedAt).toLocaleTimeString()}` : ''}. Team
        and manager names come from Yahoo on every load and are not stored â€” see{' '}
        <Link href="/yahoo-capabilities">Yahoo status</Link> for what the portal can and cannot
        read.
      </Typography>
    </Stack>
  );
}

function StatusField({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): JSX.Element {
  const content = (
    <Box>
      <Typography variant="caption" color="text.secondary" display="block">
        {label}
      </Typography>
      <Typography variant="body2">{value}</Typography>
    </Box>
  );

  return (
    <Grid size={{ xs: 12, sm: 6, md: 4 }}>
      {hint ? <Tooltip title={hint}>{content}</Tooltip> : content}
    </Grid>
  );
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'Never';
  // Timestamps are stored without a zone suffix; they are UTC.
  const date = new Date(value.endsWith('Z') ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
