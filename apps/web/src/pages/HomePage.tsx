import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid2';
import EmojiEventsIcon from '@mui/icons-material/EmojiEventsRounded';
import WhatshotIcon from '@mui/icons-material/WhatshotRounded';
import CompressIcon from '@mui/icons-material/CompressRounded';
import LinkOffIcon from '@mui/icons-material/LinkOffRounded';
import FormatListNumberedIcon from '@mui/icons-material/FormatListNumberedRounded';
import CampaignIcon from '@mui/icons-material/CampaignRounded';
import { Link as RouterLink } from 'react-router-dom';
import {
  useAnnouncements,
  useConnection,
  useDraftStatus,
  useLeagueMe,
  useLeagueOverview,
  useSession,
} from '../hooks.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { EmptyState, Monogram, PageHeader, RelativeTime } from '../components/primitives.js';

/**
 * Home.
 *
 * Answers the questions a league member actually opens the app with — am I winning,
 * who am I playing, where do I sit — before anything administrative.
 *
 * The first build of this screen led with Yahoo connection health and a grid of
 * team names, which is plumbing. A manager had no reason to come back.
 */
export function HomePage(): JSX.Element {
  const session = useSession();
  const connection = useConnection();
  const me = useLeagueMe(connection.data?.connected ?? false);

  const user = session.data?.user ?? null;
  const isCommissioner = user?.role === 'commissioner';
  const firstName = user?.displayName?.split(/[\s(]/)[0] ?? 'there';

  if (connection.isLoading || (connection.data?.connected && me.isLoading)) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Home" />
        <Skeleton height={190} sx={{ borderRadius: 4 }} />
        <Grid container spacing={2}>
          {Array.from({ length: 3 }, (_, index) => (
            <Grid size={{ xs: 12, sm: 4 }} key={index}>
              <Skeleton height={120} sx={{ borderRadius: 4 }} />
            </Grid>
          ))}
        </Grid>
      </Stack>
    );
  }

  // Nothing is readable without a connection, so that is the only thing to say.
  if (!connection.data?.connected) {
    return (
      <Stack spacing={3}>
        <PageHeader title={`Hi, ${firstName}`} />
        <EmptyState
          icon={<LinkOffIcon />}
          title="Connect Yahoo to see the league"
          description="Scores, matchups, and standings are read live from Yahoo under read-only access. The portal can never change anything in your league."
          action={
            <Button variant="contained" size="large" href="/auth/yahoo/start">
              Connect Yahoo
            </Button>
          }
        />
      </Stack>
    );
  }

  if (me.isError) {
    return (
      <Stack spacing={3}>
        <PageHeader title={`Hi, ${firstName}`} />
        <ErrorNotice error={me.error} onRetry={() => void me.refetch()} />
      </Stack>
    );
  }

  const data = me.data;

  if (!data?.linked) {
    return (
      <Stack spacing={3}>
        <PageHeader title={`Hi, ${firstName}`} />
        <EmptyState
          icon={<EmojiEventsIcon />}
          title="No league linked yet"
          description={
            isCommissioner
              ? 'Pick which of your Yahoo leagues this portal manages, and the standings and matchups appear here.'
              : 'A commissioner needs to link the Yahoo league before there is anything to show.'
          }
          action={
            isCommissioner ? (
              <Button variant="contained" component={RouterLink} to="/commissioner">
                Link a league
              </Button>
            ) : undefined
          }
        />
      </Stack>
    );
  }

  return (
    <Stack spacing={3}>
      <PageHeader
        title={`Hi, ${firstName}`}
        description={`${data.leagueName ?? 'Your league'} · ${data.seasonYear} season · week ${data.week}`}
      />

      {/*
        The draft turn outranks the scoreboard.
        A manager who opens the portal while it is their turn to choose a draft slot
        needs to know that before anything else, and once a year it is the single
        most time-sensitive thing the portal knows.
      */}
      <DraftTurnBanner />

      <PinnedAnnouncements />

      {data.matchup ? <MatchupHero matchup={data.matchup} you={data.you} /> : <NoTeamNotice />}

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 4 }}>
          <LeadersCard leaders={data.leaders ?? []} />
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 4 }}>
          <HighlightCard
            icon={<WhatshotIcon />}
            label="Highest score this week"
            primary={data.highestScore ? formatPoints(data.highestScore.points) : '—'}
            secondary={data.highestScore?.name ?? 'No scores yet'}
          />
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 4 }}>
          <HighlightCard
            icon={<CompressIcon />}
            label="Closest matchup"
            primary={data.closestMatchup ? formatPoints(data.closestMatchup.margin) : '—'}
            secondary={data.closestMatchup?.teams.join(' vs ') ?? 'No matchups yet'}
          />
        </Grid>
      </Grid>

      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
        <Button variant="tonal" component={RouterLink} to="/matchups">
          All matchups
        </Button>
        <Button variant="tonal" component={RouterLink} to="/standings">
          Full standings
        </Button>
        <Button variant="text" component={RouterLink} to="/challenges">
          Weekly challenges
        </Button>
      </Stack>

      <Typography variant="caption" color="text.secondary">
        Read live from Yahoo <RelativeTime value={data.fetchedAt} underline={false} />. Scores
        update as games play; nothing here is stored.
      </Typography>
    </Stack>
  );
}

/**
 * The matchup hero.
 *
 * Deliberately the largest thing on the page. During a game this is the only
 * number anyone cares about, and it should be readable at arm's length.
 */
/**
 * Shows the open draft turn, and nothing at all the rest of the year.
 *
 * The query does not poll unless a turn is open, so outside the draft this costs a
 * single cheap read and renders nothing.
 */
function DraftTurnBanner(): JSX.Element | null {
  const overview = useLeagueOverview(true);
  const status = useDraftStatus(overview.data?.league?.currentSeasonYear ?? null);

  const turn = status.data?.currentTurn;
  if (!turn) return null;

  if (turn.isYou) {
    return (
      <Alert
        severity="warning"
        icon={<FormatListNumberedIcon />}
        action={
          <Button component={RouterLink} to="/draft" size="small" variant="contained">
            Choose
          </Button>
        }
      >
        <AlertTitle>It&rsquo;s your turn to choose a draft slot</AlertTitle>
        Everyone behind you is waiting.
      </Alert>
    );
  }

  return (
    <Alert
      severity="info"
      icon={<FormatListNumberedIcon />}
      action={
        <Button component={RouterLink} to="/draft" size="small">
          View board
        </Button>
      }
    >
      Draft slots are being chosen — {turn.displayName} is up.
    </Alert>
  );
}

/**
 * Pinned announcements, on the screen everyone actually opens.
 *
 * Only pinned ones: an announcements page nobody visits is the same as no
 * announcement, but reprinting every notice on the home screen would bury the
 * scoreboard people came for.
 */
function PinnedAnnouncements(): JSX.Element | null {
  const announcements = useAnnouncements();

  const pinned = (announcements.data?.announcements ?? []).filter(
    (announcement) => announcement.pinned && announcement.status === 'published',
  );

  if (pinned.length === 0) return null;

  return (
    <Stack spacing={1}>
      {pinned.map((announcement) => (
        <Alert
          key={announcement.announcementId}
          severity="info"
          icon={<CampaignIcon />}
          action={
            <Button component={RouterLink} to="/announcements" size="small">
              All news
            </Button>
          }
        >
          <AlertTitle>{announcement.title}</AlertTitle>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
            {announcement.body}
          </Typography>
        </Alert>
      ))}
    </Stack>
  );
}

function MatchupHero({
  matchup,
  you,
}: {
  matchup: NonNullable<NonNullable<ReturnType<typeof useLeagueMe>['data']>['matchup']>;
  you: NonNullable<ReturnType<typeof useLeagueMe>['data']>['you'];
}): JSX.Element {
  const yourPoints = matchup.you.points;
  const theirPoints = matchup.opponent?.points ?? null;

  const winning = yourPoints !== null && theirPoints !== null ? yourPoints > theirPoints : null;
  const final = matchup.status === 'postevent';

  const verdict = matchup.isTied
    ? 'Tied'
    : winning === null
      ? 'Not started'
      : final
        ? winning
          ? 'Won'
          : 'Lost'
        : winning
          ? 'Ahead'
          : 'Behind';

  return (
    <Card
      variant="filled"
      sx={{
        borderLeft: 5,
        borderLeftStyle: 'solid',
        borderLeftColor: matchup.isTied
          ? 'warning.main'
          : winning === null
            ? 'divider'
            : winning
              ? 'success.main'
              : 'error.main',
      }}
    >
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
            <Typography
              variant="caption"
              sx={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}
              color="text.secondary"
            >
              Your matchup
            </Typography>
            <Chip
              size="small"
              color={
                matchup.isTied
                  ? 'warning'
                  : winning === null
                    ? 'default'
                    : winning
                      ? 'success'
                      : 'error'
              }
              label={verdict}
            />
            {final && <Chip size="small" variant="outlined" label="final" />}
            {matchup.status === 'midevent' && <Chip size="small" variant="outlined" label="live" />}
          </Stack>

          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={{ xs: 2, sm: 3 }}
            alignItems={{ sm: 'center' }}
          >
            <Side name={matchup.you.name} points={yourPoints} isYou />

            <Typography
              variant="h2"
              color="text.secondary"
              sx={{ textAlign: 'center', flexShrink: 0, opacity: 0.5 }}
            >
              vs
            </Typography>

            {matchup.opponent ? (
              <Side
                name={matchup.opponent.name}
                points={theirPoints}
                {...(matchup.opponent.managers[0] ? { manager: matchup.opponent.managers[0] } : {})}
              />
            ) : (
              <Box sx={{ flex: 1 }}>
                <Typography variant="body2" color="text.secondary">
                  No opponent this week — a bye.
                </Typography>
              </Box>
            )}
          </Stack>

          {you && (
            <>
              <Divider />
              <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
                {you.rank !== null && <Stat label="Rank" value={`#${you.rank}`} />}
                {you.record && <Stat label="Record" value={you.record} />}
                {you.streak && <Stat label="Streak" value={you.streak} />}
                {you.pointsFor !== null && (
                  <Stat label="Points for" value={formatPoints(you.pointsFor)} />
                )}
                {you.pointsAgainst !== null && (
                  <Stat label="Against" value={formatPoints(you.pointsAgainst)} />
                )}
              </Stack>
            </>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

function Side({
  name,
  points,
  manager,
  isYou,
}: {
  name: string;
  points: number | null;
  manager?: string;
  isYou?: boolean;
}): JSX.Element {
  return (
    <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
      <Monogram name={name} size={48} />
      <Box sx={{ minWidth: 0 }}>
        <Stack direction="row" spacing={0.75} alignItems="center">
          <Typography variant="subtitle1" noWrap sx={{ fontWeight: 700 }}>
            {name}
          </Typography>
          {isYou && <Chip size="small" color="primary" label="you" />}
        </Stack>
        {manager && (
          <Typography variant="caption" color="text.secondary" noWrap display="block">
            {manager}
          </Typography>
        )}
        <Typography variant="h1" sx={{ fontWeight: 600, lineHeight: 1.1, mt: 0.25 }}>
          {points === null ? '—' : formatPoints(points)}
        </Typography>
      </Box>
    </Stack>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <Box>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{
          display: 'block',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontWeight: 700,
        }}
      >
        {label}
      </Typography>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        {value}
      </Typography>
    </Box>
  );
}

/**
 * Shown when Yahoo does not mark any team as the viewer's.
 *
 * The normal case for a commissioner who does not play, and for a member reading
 * through someone else's connection. Saying so beats rendering an empty hero.
 */
function NoTeamNotice(): JSX.Element {
  return (
    <Alert severity="info">
      Yahoo did not identify a team as yours in this league, so there is no personal matchup to
      show. The league&rsquo;s standings and matchups are still below.
    </Alert>
  );
}

function LeadersCard({
  leaders,
}: {
  leaders: Array<{ rank: number | null; name: string; record: string | null; isYou: boolean }>;
}): JSX.Element {
  return (
    <Card sx={{ height: '100%' }}>
      <CardContent>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}
        >
          Top of the table
        </Typography>

        <Stack spacing={1.25} sx={{ mt: 1.5 }}>
          {leaders.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No standings yet.
            </Typography>
          )}

          {leaders.map((leader) => (
            <Stack key={leader.name} direction="row" spacing={1.5} alignItems="center">
              <Typography
                variant="subtitle2"
                sx={{ width: 22, color: 'text.secondary', fontWeight: 700 }}
              >
                {leader.rank ?? '–'}
              </Typography>
              <Typography variant="body2" noWrap sx={{ flexGrow: 1, minWidth: 0, fontWeight: 500 }}>
                {leader.name}
              </Typography>
              {leader.isYou && <Chip size="small" color="primary" label="you" />}
              <Typography variant="body2" color="text.secondary">
                {leader.record ?? ''}
              </Typography>
            </Stack>
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
}

function HighlightCard({
  icon,
  label,
  primary,
  secondary,
}: {
  icon: React.ReactNode;
  label: string;
  primary: string;
  secondary: string;
}): JSX.Element {
  return (
    <Card variant="filled" sx={{ height: '100%' }}>
      <CardContent>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ color: 'text.secondary' }}>
          {icon}
          <Typography
            variant="caption"
            sx={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}
          >
            {label}
          </Typography>
        </Stack>
        <Typography variant="h1" sx={{ fontWeight: 600, mt: 0.5 }}>
          {primary}
        </Typography>
        <Typography variant="body2" color="text.secondary" noWrap>
          {secondary}
        </Typography>
      </CardContent>
    </Card>
  );
}

/** Fantasy scores are quoted to a tenth; whole numbers should not gain a `.0`. */
export function formatPoints(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
