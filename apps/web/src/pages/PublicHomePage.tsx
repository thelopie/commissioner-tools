import { useEffect, useState } from 'react';
import {
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
import SportsBaseballIcon from '@mui/icons-material/SportsBaseballRounded';
import { usePublicHome } from '../hooks.js';

/**
 * What the league sees before signing in.
 *
 * The two things everybody actually opens the site for — how long until the draft,
 * and what order we pick in — and nothing else. No sign-in wall in front of them,
 * because twelve people who already know each other's names gain nothing from one.
 *
 * The order only arrives from the API once it is published and complete, so this
 * component never has to decide whether a partial order is safe to show.
 */
export function PublicHomePage(): JSX.Element {
  const home = usePublicHome();

  if (home.isLoading) {
    return (
      <Stack spacing={3} sx={{ maxWidth: 760, mx: 'auto' }}>
        <Skeleton height={200} sx={{ borderRadius: 4 }} />
        <Skeleton height={320} sx={{ borderRadius: 4 }} />
      </Stack>
    );
  }

  const order = home.data?.order ?? null;

  return (
    <Stack spacing={4} sx={{ maxWidth: 760, mx: 'auto' }}>
      <Stack spacing={1} alignItems="center" sx={{ textAlign: 'center' }}>
        <Typography variant="h1" id="page-title" tabIndex={-1} sx={{ outline: 'none' }}>
          {home.data?.leagueName ?? 'La Liga de Lopie'}
        </Typography>
        {home.data?.seasonYear !== null && home.data?.seasonYear !== undefined && (
          <Typography variant="body1" color="text.secondary">
            {home.data.seasonYear} season
          </Typography>
        )}
      </Stack>

      <DraftHighlights draftAt={home.data?.draftAt ?? null} order={order} />

      <Box sx={{ textAlign: 'center' }}>
        <Button variant="outlined" href="/signin">
          Sign in
        </Button>
      </Box>
    </Stack>
  );
}

/**
 * The countdown and the draft order, shared by the public page and the signed-in one.
 *
 * Signing in should never show you less than a stranger sees, which is what happened
 * when the signed-in home page led with a Yahoo connection prompt and nothing else.
 */
export function DraftHighlights({
  draftAt,
  order,
}: {
  draftAt: string | null;
  order: Array<{ draftPosition: number; manager: string; llwsTeam: string | null }> | null;
}): JSX.Element {
  return (
    <Stack spacing={4}>
      <Countdown target={draftAt} />

      {order ? (
        <DraftOrder order={order} />
      ) : (
        <Card variant="filled">
          <CardContent>
            <Stack spacing={1.5} alignItems="center" sx={{ textAlign: 'center', py: 3 }}>
              <SportsBaseballIcon color="disabled" sx={{ fontSize: 44 }} />
              <Typography variant="h6">The draft order is not set yet</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ maxWidth: '46ch' }}>
                Every manager gets a Little League World Series team at random. How far your team
                goes decides what order you pick in. It lands here as soon as the draw is done.
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}

interface Remaining {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  passed: boolean;
}

function remainingUntil(targetMs: number, nowMs: number): Remaining {
  const delta = targetMs - nowMs;
  if (delta <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0, passed: true };

  const totalSeconds = Math.floor(delta / 1000);
  return {
    days: Math.floor(totalSeconds / 86_400),
    hours: Math.floor((totalSeconds % 86_400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    passed: false,
  };
}

/**
 * Counts down to the draft.
 *
 * Ticks once a second rather than deriving from a timer that could drift: each tick
 * recomputes from the current clock, so a laptop waking from sleep shows the right
 * number immediately instead of catching up.
 */
function Countdown({ target }: { target: string | null }): JSX.Element | null {
  const targetMs = target === null ? null : Date.parse(target);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (targetMs === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [targetMs]);

  if (targetMs === null || Number.isNaN(targetMs)) return null;

  const left = remainingUntil(targetMs, now);

  // Rendered in the reader's own timezone, which is the only one they can act on.
  const when = new Date(targetMs).toLocaleString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  return (
    <Card variant="filled">
      <CardContent>
        <Stack spacing={2} alignItems="center" sx={{ textAlign: 'center' }}>
          <Typography variant="overline" color="text.secondary">
            {left.passed ? 'Draft day' : 'Draft starts in'}
          </Typography>

          {left.passed ? (
            <Typography variant="h4">It is draft time</Typography>
          ) : (
            <Stack direction="row" spacing={{ xs: 1.5, sm: 3 }} justifyContent="center">
              <Unit value={left.days} label="days" />
              <Unit value={left.hours} label="hours" />
              <Unit value={left.minutes} label="minutes" />
              <Unit value={left.seconds} label="seconds" />
            </Stack>
          )}

          <Typography variant="body2" color="text.secondary">
            {when}
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  );
}

function Unit({ value, label }: { value: number; label: string }): JSX.Element {
  return (
    <Stack spacing={0.25} alignItems="center" sx={{ minWidth: { xs: 56, sm: 72 } }}>
      <Typography
        variant="h3"
        sx={{ fontVariantNumeric: 'tabular-nums', lineHeight: 1, fontWeight: 700 }}
      >
        {String(value).padStart(2, '0')}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Stack>
  );
}

function DraftOrder({
  order,
}: {
  order: Array<{ draftPosition: number; manager: string; llwsTeam: string | null }>;
}): JSX.Element {
  return (
    <Card variant="filled">
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
            <Typography variant="h6">Draft order</Typography>
            <Chip size="small" label={`${order.length} picks`} />
          </Stack>

          <Divider />

          <Stack divider={<Divider flexItem />}>
            {order.map((entry) => (
              <Stack
                key={entry.draftPosition}
                direction="row"
                spacing={2}
                alignItems="center"
                sx={{ py: 1.25 }}
              >
                <Typography
                  variant="h6"
                  sx={{
                    width: 36,
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                    color: 'text.secondary',
                  }}
                >
                  {entry.draftPosition}
                </Typography>
                <Stack sx={{ minWidth: 0, flex: 1 }}>
                  <Typography variant="body1" sx={{ fontWeight: 600 }}>
                    {entry.manager}
                  </Typography>
                  {entry.llwsTeam && (
                    <Typography variant="body2" color="text.secondary">
                      {entry.llwsTeam}
                    </Typography>
                  )}
                </Stack>
              </Stack>
            ))}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
