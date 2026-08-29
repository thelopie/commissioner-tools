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
import { ApiError } from '../api/client.js';
import { parseYahooLeagueId, yahooLeagueKeyFor } from '../lib/yahoo-league-url.js';
import { matchMembersToTeams } from '../lib/match-members.js';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import RefreshIcon from '@mui/icons-material/RefreshRounded';
import CheckCircleIcon from '@mui/icons-material/CheckCircleRounded';
import LinkOffIcon from '@mui/icons-material/LinkOffRounded';
import GroupsIcon from '@mui/icons-material/GroupsRounded';
import EmojiEventsIcon from '@mui/icons-material/EmojiEventsRounded';
import HowToRegIcon from '@mui/icons-material/HowToRegRounded';
import SportsFootballIcon from '@mui/icons-material/SportsFootballRounded';
import VideocamIcon from '@mui/icons-material/VideocamRounded';
import { useSearchParams } from 'react-router-dom';
import {
  useConfirmDisplayName,
  useConnection,
  useDisconnectYahoo,
  useLeagueMembers,
  useLeagueOverview,
  useManualRefresh,
  useMapLeagueMember,
  usePortalUsers,
  useSaveDraftMeeting,
  useSeasons,
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

      {isCommissioner && <DraftRoomCard />}

      {connected && <ConnectionCard />}

      {connected && <LeagueSection />}
    </Stack>
  );
}

/**
 * Where the draft is held.
 *
 * Sits outside the Yahoo gate above because it owes Yahoo nothing — the countdown
 * and the room are the portal's own, and they have to work on the evening Yahoo is
 * most likely to be the thing that is broken.
 *
 * One field, because that is the whole feature: the portal stores a URL and puts a
 * button on the countdown for the day of the draft. It creates no meeting and joins
 * none, so a link from any video service works and next year's choice is a paste
 * rather than a deploy.
 */
function DraftRoomCard(): JSX.Element | null {
  const seasons = useSeasons();
  const notify = useNotify();

  /*
    The newest season, which is the one being drafted. Same fallback the rest of the
    portal uses: `currentSeasonYear` is only ever set by linking a Yahoo league, so
    keying off it would leave this blank on a portal that has not linked one.
  */
  const season = [...(seasons.data?.seasons ?? [])].sort((a, b) => b.seasonYear - a.seasonYear)[0];

  const saved = season?.draftMeetingUrl ?? '';
  const [url, setUrl] = useState(saved);
  const [touched, setTouched] = useState(false);

  // Adopt the stored value once it arrives, unless the commissioner is mid-edit.
  useEffect(() => {
    if (!touched) setUrl(saved);
  }, [saved, touched]);

  const save = useSaveDraftMeeting(season?.seasonYear ?? null);

  if (!season) return null;

  const trimmed = url.trim();
  const valid = trimmed === '' || /^https:\/\/\S+$/.test(trimmed);
  const changed = trimmed !== saved;

  return (
    <Stack spacing={2}>
      <SectionHeader title="Draft day" />

      <Card variant="filled">
        <CardContent>
          <Stack spacing={2}>
            <Stack direction="row" spacing={1.5} alignItems="flex-start">
              <VideocamIcon color="primary" />
              <Stack spacing={0.5}>
                <Typography variant="h3">The draft room</Typography>
                <Typography variant="body2" color="text.secondary">
                  Paste the meeting link. On the day of the draft the countdown turns into a button
                  that opens it, for anyone signed in. Leave it empty and the countdown stays as it
                  is.
                </Typography>
              </Stack>
            </Stack>

            <TextField
              label="Meeting link"
              placeholder="https://meet.google.com/…"
              value={url}
              onChange={(event) => {
                setTouched(true);
                setUrl(event.target.value);
              }}
              fullWidth
              error={!valid}
              helperText={
                valid
                  ? 'Members only — it is never shown to a signed-out visitor.'
                  : 'Needs to be a full https:// link.'
              }
            />

            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button
                variant="contained"
                disabled={!valid || !changed || save.isPending}
                onClick={() => {
                  save.mutate(trimmed, {
                    onSuccess: () => {
                      setTouched(false);
                      notify(
                        trimmed === '' ? 'Draft room link removed.' : 'Draft room link saved.',
                      );
                    },
                    onError: () => notify('Could not save that link.', 'error'),
                  });
                }}
              >
                {save.isPending ? 'Saving…' : trimmed === '' && saved !== '' ? 'Remove' : 'Save'}
              </Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
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
            <Stack spacing={2}>
              <ErrorNotice error={leagues.error} onRetry={() => void leagues.refetch()} />
              {/*
                The list cannot load, but the key is knowable: it is in the URL of
                the league on Yahoo's own site. Offering manual entry here means
                setup is not held hostage to a permission the commissioner does not
                control.
              */}
              {leagues.error instanceof ApiError && leagues.error.isFantasyUnauthorized && (
                <ManualLeagueKey
                  onSubmit={(input) => select.mutate(input)}
                  pending={select.isPending}
                  error={select.error}
                />
              )}
            </Stack>
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

        {unmapped > 0 && <MatchAllTeams teams={yahoo.teams} seasonYear={yahoo.seasonYear} />}

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
                        <MemberMapping
                          seasonYear={yahoo.seasonYear}
                          yahooTeamKey={team.yahooTeamKey}
                          yahooTeamName={team.name}
                          leagueMemberId={team.leagueMemberId}
                        />
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

/**
 * Maps one Yahoo team to a portal member.
 *
 * The mapping is the hinge the whole portal turns on: challenge results, dues and
 * draft records are keyed to the portal member, so a manager who leaves the league
 * — or a Yahoo connection that lapses — does not erase their history.
 *
 * Two ways in, and neither copies Yahoo data into a permanent record: link an
 * existing portal user, or type the league's own name for someone who has never
 * signed in. The Yahoo nickname is shown on the card as live context only.
 */
function MemberMapping({
  seasonYear,
  yahooTeamKey,
  yahooTeamName,
  leagueMemberId,
}: {
  seasonYear: number;
  yahooTeamKey: string;
  yahooTeamName: string;
  leagueMemberId: string | null;
}): JSX.Element {
  const members = useLeagueMembers(seasonYear);
  const users = usePortalUsers();
  const session = useSession();
  const map = useMapLeagueMember(seasonYear);
  const notify = useNotify();

  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState('');
  const [typedName, setTypedName] = useState('');

  const mapped = members.data?.members.find((member) => member.leagueMemberId === leagueMemberId);

  /** Members with no Yahoo team yet — the usual case after a CSV import. */
  const unmappedMembers = (members.data?.members ?? []).filter(
    (member) => member.yahooTeamKey === null,
  );

  /**
   * The signed-in user, offered explicitly.
   *
   * `/api/users` finds portal users THROUGH their league membership, so before the
   * first member exists it returns nothing — including the commissioner doing the
   * mapping. Without this the first team could only be mapped by typing a name,
   * which would create a nameless duplicate of an account that already exists.
   */
  const self = session.data?.user ?? null;
  const selfAlreadyMember =
    self !== null && (members.data?.members ?? []).some((member) => member.userId === self.userId);

  if (leagueMemberId !== null) {
    return (
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.75 }}>
        <CheckCircleIcon sx={{ fontSize: 15, color: 'success.main' }} />
        <Typography variant="caption" color="text.secondary" noWrap>
          {mapped?.displayName ?? 'mapped'}
        </Typography>
      </Stack>
    );
  }

  const submit = (): void => {
    const chosen = unmappedMembers.find((member) => member.leagueMemberId === userId);

    map.mutate(
      {
        yahooTeamKey,
        // Linking an existing member reuses its id; a portal user or a typed name
        // creates one.
        ...(chosen
          ? {
              leagueMemberId: chosen.leagueMemberId,
              ...(chosen.userId ? { userId: chosen.userId } : {}),
              ...(chosen.userId ? {} : { legacyManagerName: chosen.displayName }),
            }
          : userId
            ? { userId }
            : { legacyManagerName: typedName.trim() }),
      },
      {
        onSuccess: () => {
          notify(`Mapped ${yahooTeamName}.`, 'success');
          setOpen(false);
          setUserId('');
          setTypedName('');
        },
        onError: (error) => notify(error.message, 'error'),
      },
    );
  };

  const canSubmit = userId !== '' || typedName.trim().length > 0;

  return (
    <>
      <Button size="small" variant="outlined" sx={{ mt: 0.75 }} onClick={() => setOpen(true)}>
        Map to a member
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Map {yahooTeamName}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              Link this Yahoo team to the person who owns it. Records stay attached to the person,
              not to the Yahoo team.
            </Typography>

            <FormControl size="small" fullWidth>
              <InputLabel id={`member-${yahooTeamKey}`}>Existing person</InputLabel>
              <Select
                labelId={`member-${yahooTeamKey}`}
                label="Existing person"
                value={userId}
                onChange={(event) => {
                  setUserId(event.target.value);
                  if (event.target.value) setTypedName('');
                }}
              >
                <MenuItem value="">
                  <em>Nobody yet — type a name below</em>
                </MenuItem>

                {self !== null && !selfAlreadyMember && (
                  <MenuItem value={self.userId}>{self.displayName} · you</MenuItem>
                )}

                {unmappedMembers.map((member) => (
                  <MenuItem key={member.leagueMemberId} value={member.leagueMemberId}>
                    {member.displayName}
                  </MenuItem>
                ))}

                {(users.data?.users ?? [])
                  .filter(
                    (user) =>
                      !(members.data?.members ?? []).some(
                        (member) => member.userId === user.userId,
                      ),
                  )
                  .map((user) => (
                    <MenuItem key={user.userId} value={user.userId}>
                      {user.displayName} · portal user
                    </MenuItem>
                  ))}
              </Select>
            </FormControl>

            <TextField
              size="small"
              label="Or the league's own name for them"
              placeholder="How the league refers to this manager"
              helperText="Use this for someone who has never signed in. Type your league's name for them, not their Yahoo nickname."
              value={typedName}
              onChange={(event) => {
                setTypedName(event.target.value);
                if (event.target.value) setUserId('');
              }}
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={!canSubmit || map.isPending} onClick={submit}>
            {map.isPending ? 'Mapping…' : 'Map'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
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

/**
 * Manual entry of a Yahoo league key.
 *
 * Only shown when the league list cannot be read. The key is visible in the URL of
 * the league on Yahoo's site, so a commissioner can supply it themselves rather than
 * waiting on an API permission — and `nfl` works as the game key, meaning the season
 * number does not have to be hunted down as well.
 *
 * The link is recorded unverified in this state, because with the API closed nothing
 * can tell a correct key from an incorrect one. It is checked on the first read that
 * succeeds.
 */
function ManualLeagueKey({
  onSubmit,
  pending,
  error,
}: {
  onSubmit: (input: { yahooLeagueKey: string; yahooGameKey: string; seasonYear: number }) => void;
  pending: boolean;
  error: unknown;
}): JSX.Element {
  const [leagueId, setLeagueId] = useState('');
  const [seasonYear, setSeasonYear] = useState(String(new Date().getFullYear()));

  // Extraction lives in its own tested module: the first version read the team
  // number out of `/f1/17255/10` and would have linked the wrong league.
  const parsedId = parseYahooLeagueId(leagueId);
  const valid = parsedId !== null && /^\d{4}$/.test(seasonYear);

  return (
    <Card sx={{ bgcolor: 'background.surfaceContainerLowest' }}>
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              Enter the league yourself
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Open the league on Yahoo and copy the number from the address bar — in
              <code> football.fantasysports.yahoo.com/f1/123456</code> it is <code>123456</code>.
              Pasting the whole address works too.
            </Typography>
          </Box>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              label="League ID or URL"
              size="small"
              fullWidth
              value={leagueId}
              onChange={(event) => setLeagueId(event.target.value)}
            />
            <TextField
              label="Season"
              size="small"
              sx={{ width: { sm: 120 } }}
              value={seasonYear}
              onChange={(event) => setSeasonYear(event.target.value)}
            />
          </Stack>

          {parsedId !== null && (
            <Typography variant="caption" color="text.secondary">
              Will link <code>{yahooLeagueKeyFor(parsedId)}</code> — check that is your league
              before continuing, since it cannot be verified until Yahoo opens up.
            </Typography>
          )}

          {error instanceof ApiError && <Alert severity="error">{error.message}</Alert>}

          <Box>
            <Button
              variant="contained"
              disabled={!valid || pending}
              onClick={() =>
                onSubmit({
                  yahooLeagueKey: yahooLeagueKeyFor(parsedId!),
                  yahooGameKey: 'nfl',
                  seasonYear: Number(seasonYear),
                })
              }
            >
              {pending ? 'Linking…' : 'Link this league'}
            </Button>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

/**
 * Maps every Yahoo team the portal can work out by itself.
 *
 * Twelve dropdowns filled in by hand was work for its own sake: Yahoo reports each
 * team's manager nickname, and those are the names the commissioner already entered.
 * Only the genuinely ambiguous ones should reach a person.
 *
 * Shown as a proposal rather than done silently — it decides which manager owns which
 * scores for a season, so it is worth a glance before it is applied.
 */
function MatchAllTeams({
  teams,
  seasonYear,
}: {
  seasonYear: number;
  teams: Array<{
    yahooTeamKey: string;
    name: string;
    leagueMemberId: string | null;
    managers: Array<{ nickname: string }>;
  }>;
}): JSX.Element | null {
  const members = useLeagueMembers(seasonYear);
  const map = useMapLeagueMember(seasonYear);
  const notify = useNotify();
  const [applying, setApplying] = useState(false);

  const result = matchMembersToTeams(
    teams.map((team) => ({
      yahooTeamKey: team.yahooTeamKey,
      name: team.name,
      managerNames: team.managers.map((manager) => manager.nickname),
      leagueMemberId: team.leagueMemberId,
    })),
    (members.data?.members ?? []).map((member) => ({
      leagueMemberId: member.leagueMemberId,
      displayName: member.displayName,
      yahooTeamKey: member.yahooTeamKey,
    })),
  );

  if (result.matches.length === 0) return null;

  const apply = async (): Promise<void> => {
    setApplying(true);
    let done = 0;

    // Sequential on purpose: each write reads the member list to check for a clash,
    // and firing twelve at once would have them racing each other.
    for (const match of result.matches) {
      try {
        await map.mutateAsync({
          yahooTeamKey: match.yahooTeamKey,
          leagueMemberId: match.leagueMemberId,
          legacyManagerName: match.memberName,
        });
        done += 1;
      } catch {
        // Reported below rather than thrown: one clash should not abandon the rest.
      }
    }

    setApplying(false);
    notify(
      done === result.matches.length
        ? `Mapped ${done} teams.`
        : `Mapped ${done} of ${result.matches.length}. Map the rest by hand.`,
      done === result.matches.length ? 'success' : 'warning',
    );
  };

  return (
    <Alert severity="success" icon={<HowToRegIcon />}>
      <AlertTitle>
        {result.matches.length} {result.matches.length === 1 ? 'team' : 'teams'} can be mapped
        automatically
      </AlertTitle>

      <Typography variant="body2" sx={{ mb: 1 }}>
        Matched on manager name, never on the fantasy team name — those change mid-season and
        agreeing with a person&rsquo;s name would be coincidence.
      </Typography>

      <Stack spacing={0.25} sx={{ mb: 1.5 }}>
        {result.matches.map((match) => (
          <Typography key={match.yahooTeamKey} variant="caption" color="text.secondary">
            {match.yahooTeamName} → <strong>{match.memberName}</strong>
          </Typography>
        ))}
      </Stack>

      {result.unmatchedTeams.length > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
          {result.unmatchedTeams.length} still need doing by hand.
        </Typography>
      )}

      <Button variant="contained" size="small" disabled={applying} onClick={() => void apply()}>
        {applying ? 'Mapping…' : 'Map these'}
      </Button>
    </Alert>
  );
}
