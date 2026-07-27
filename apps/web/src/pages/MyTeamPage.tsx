import { useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Chip,
  Divider,
  IconButton,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid2';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeftRounded';
import ChevronRightIcon from '@mui/icons-material/ChevronRightRounded';
import GroupsIcon from '@mui/icons-material/GroupsRounded';
import { useConnection, useLeagueOverview, useRoster } from '../hooks.js';
import type { RosterSlot } from '../api/client.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { EmptyState, PageHeader, RelativeTime, SectionHeader } from '../components/primitives.js';
import { formatPoints } from './HomePage.js';

/**
 * The signed-in user's lineup for a week.
 *
 * "Who did I start, and what did my bench do" is the question a manager asks right
 * after a loss, and the answer requires no portal setup at all — Yahoo's
 * `is_current_login` flag identifies the team.
 */
export function MyTeamPage(): JSX.Element {
  const connection = useConnection();
  const connected = connection.data?.connected ?? false;
  const overview = useLeagueOverview(connected);

  const currentWeek = overview.data?.yahoo?.currentWeek ?? null;
  const startWeek = overview.data?.yahoo?.startWeek ?? 1;
  const endWeek = overview.data?.yahoo?.endWeek ?? 17;

  /**
   * Null means "whatever week Yahoo says it is", resolved server-side. Only once
   * the user steps through weeks does this hold a number.
   */
  const [week, setWeek] = useState<number | null>(null);
  const roster = useRoster(connected, week);

  const shownWeek = roster.data?.week ?? currentWeek;
  const canGoBack = shownWeek !== null && shownWeek > startWeek;
  const canGoForward = shownWeek !== null && shownWeek < endWeek;

  if (!connected) {
    return (
      <Stack spacing={3}>
        <PageHeader title="My team" />
        <EmptyState
          icon={<GroupsIcon />}
          title="Connect Yahoo to see your roster"
          description="Your lineup is read live from Yahoo each time you open this page."
        />
      </Stack>
    );
  }

  const header = (
    <PageHeader
      title="My team"
      description={roster.data?.team ? roster.data.team.name : undefined}
      action={
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Tooltip title="Previous week">
            <span>
              <IconButton
                onClick={() => setWeek((shownWeek ?? startWeek) - 1)}
                disabled={!canGoBack}
                aria-label="Previous week"
              >
                <ChevronLeftIcon />
              </IconButton>
            </span>
          </Tooltip>

          <Chip
            label={shownWeek === null ? 'Week —' : `Week ${shownWeek}`}
            color={shownWeek === currentWeek ? 'primary' : 'default'}
            sx={{ minWidth: 96 }}
          />

          <Tooltip title="Next week">
            <span>
              <IconButton
                onClick={() => setWeek((shownWeek ?? startWeek) + 1)}
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
  );

  if (roster.isLoading) {
    return (
      <Stack spacing={3}>
        {header}
        <Skeleton height={420} sx={{ borderRadius: 4 }} />
      </Stack>
    );
  }

  if (roster.isError) {
    return (
      <Stack spacing={3}>
        {header}
        <ErrorNotice error={roster.error} onRetry={() => void roster.refetch()} />
      </Stack>
    );
  }

  // Yahoo marks no team as this user's. Normal for a commissioner who does not play.
  if (roster.data && !roster.data.team) {
    return (
      <Stack spacing={3}>
        {header}
        <EmptyState
          icon={<GroupsIcon />}
          title="No team in this league"
          description="Yahoo does not list you as a manager in the linked league, so there is no lineup to show. Standings and matchups still work."
        />
      </Stack>
    );
  }

  const starters = (roster.data?.slots ?? []).filter((slot) => slot.isStarter);
  const bench = (roster.data?.slots ?? []).filter((slot) => !slot.isStarter);

  return (
    <Stack spacing={3}>
      {header}

      <Grid container spacing={2}>
        <Grid size={{ xs: 6, md: 4 }}>
          <PointsCard
            label="Starters"
            points={roster.data?.startersPoints ?? null}
            caption="what counted"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 4 }}>
          <PointsCard
            label="Bench"
            points={roster.data?.benchPoints ?? null}
            caption="left on the bench"
          />
        </Grid>
      </Grid>

      <Box>
        <SectionHeader title="Starters" count={starters.length} />
        <Card>
          <CardContent sx={{ py: 1 }}>
            <Stack divider={<Divider flexItem />}>
              {starters.map((slot, index) => (
                <SlotRow key={`${slot.playerName}-${index}`} slot={slot} />
              ))}
              {starters.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                  Yahoo reported no starters for this week.
                </Typography>
              )}
            </Stack>
          </CardContent>
        </Card>
      </Box>

      {bench.length > 0 && (
        <Box>
          <SectionHeader title="Bench" count={bench.length} />
          <Card sx={{ bgcolor: 'background.surfaceContainerLow' }}>
            <CardContent sx={{ py: 1 }}>
              <Stack divider={<Divider flexItem />}>
                {bench.map((slot, index) => (
                  <SlotRow key={`${slot.playerName}-${index}`} slot={slot} muted />
                ))}
              </Stack>
            </CardContent>
          </Card>
        </Box>
      )}

      <Typography variant="caption" color="text.secondary">
        Read live from Yahoo <RelativeTime value={roster.data?.fetchedAt} underline={false} />.
        Rosters are not stored — Yahoo issues stat corrections for days after a game, so points
        shown here can still change.
      </Typography>
    </Stack>
  );
}

function PointsCard({
  label,
  points,
  caption,
}: {
  label: string;
  points: number | null;
  caption: string;
}): JSX.Element {
  return (
    <Card variant="filled" sx={{ height: '100%' }}>
      <CardContent>
        <Typography
          variant="caption"
          sx={{
            color: 'text.secondary',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            fontWeight: 700,
          }}
        >
          {label}
        </Typography>
        <Typography
          variant="h1"
          sx={{ fontWeight: 600, mt: 0.5, fontVariantNumeric: 'tabular-nums' }}
        >
          {points === null ? '—' : formatPoints(points)}
        </Typography>
        <Typography variant="body2" color="text.secondary" noWrap>
          {caption}
        </Typography>
      </CardContent>
    </Card>
  );
}

function SlotRow({ slot, muted = false }: { slot: RosterSlot; muted?: boolean }): JSX.Element {
  return (
    <Stack direction="row" spacing={1.5} alignItems="center" sx={{ py: 1.25 }}>
      {/* The slot code, not the player's position — the lineup is what matters here. */}
      <Chip
        size="small"
        label={slot.selectedPosition}
        variant={muted ? 'outlined' : 'filled'}
        color={muted ? 'default' : 'primary'}
        sx={{
          /**
           * A fixed width, not a minimum.
           *
           * `W/R/T` is wider than `QB`, so a minimum let one row's chip push its
           * player name out of the column the other twelve rows share.
           */
          width: 56,
          flexShrink: 0,
          fontWeight: 700,
          '& .MuiChip-label': { px: 0.5, fontSize: '0.6875rem' },
        }}
      />

      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={0.75} alignItems="center">
          <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
            {slot.playerName}
          </Typography>
          {slot.injuryStatus && (
            <Chip size="small" variant="outlined" color="warning" label={slot.injuryStatus} />
          )}
        </Stack>
        <Typography variant="caption" color="text.secondary" noWrap display="block">
          {[slot.displayPosition, slot.nflTeam].filter(Boolean).join(' · ') || '—'}
        </Typography>
      </Box>

      <Typography
        variant="body1"
        sx={{
          fontWeight: 700,
          fontVariantNumeric: 'tabular-nums',
          color: muted ? 'text.secondary' : 'text.primary',
        }}
      >
        {slot.points === null ? '—' : formatPoints(slot.points)}
      </Typography>
    </Stack>
  );
}
