import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Link,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import SportsFootballIcon from '@mui/icons-material/SportsFootballRounded';
import { Link as RouterLink } from 'react-router-dom';
import type { PublicHome } from '../api/client.js';
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
      <Hero
        leagueName={home.data?.leagueName ?? 'La Liga de Lopie'}
        seasonYear={home.data?.seasonYear ?? null}
      />

      <DraftHighlights
        draftAt={home.data?.draftAt ?? null}
        order={order}
        assignments={home.data?.assignments ?? null}
      />

      <Box sx={{ textAlign: 'center' }}>
        <Button variant="outlined" href="/signin">
          Sign in
        </Button>
      </Box>
    </Stack>
  );
}

/**
 * The banner, with the league name over the artwork rather than beside it.
 *
 * Two widths so a phone does not pull down a desktop-sized image, and the text sits on
 * a gradient scrim so it stays legible over the light and dark parts of the picture.
 */
function Hero({
  leagueName,
  seasonYear,
}: {
  leagueName: string;
  seasonYear: number | null;
}): JSX.Element {
  return (
    <Box
      sx={{
        position: 'relative',
        borderRadius: 4,
        overflow: 'hidden',
        // Reserved up front so the countdown below does not jump when the image lands.
        aspectRatio: '16 / 9',
        bgcolor: 'action.hover',
      }}
    >
      <Box
        component="img"
        src="/hero-1600.webp"
        srcSet="/hero-960.webp 960w, /hero-1600.webp 1600w"
        sizes="(max-width: 760px) 100vw, 760px"
        alt=""
        sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />

      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          p: { xs: 2, sm: 3 },
          background: 'linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0) 55%)',
        }}
      >
        {/*
          The shield, badged onto the artwork rather than replacing the title.
          Signed out, this page has no top bar, so without it the league mark
          would appear nowhere on the one screen everybody sees first.
        */}
        <Box
          component="img"
          src="/logo-mark-256.webp"
          alt=""
          sx={{
            width: { xs: 52, sm: 64 },
            height: { xs: 52, sm: 64 },
            borderRadius: 2,
            mb: 1,
            display: 'block',
            objectFit: 'cover',
            border: '1px solid rgba(255,255,255,0.28)',
            boxShadow: '0 2px 12px rgba(0,0,0,0.45)',
          }}
        />

        <Typography
          variant="h1"
          id="page-title"
          tabIndex={-1}
          sx={{ outline: 'none', color: 'common.white', fontSize: { xs: '2rem', sm: '3rem' } }}
        >
          {leagueName}
        </Typography>
        {seasonYear !== null && (
          <Typography variant="body1" sx={{ color: 'rgba(255,255,255,0.85)' }}>
            {seasonYear} season
          </Typography>
        )}
      </Box>
    </Box>
  );
}

/**
 * Who drew which Little League team.
 *
 * Listed by owner because that is how the league refers to each other, and because
 * fantasy team names change on a whim while the person does not.
 */
function LlwsMapping({
  assignments,
  hasOrder,
}: {
  assignments: PublicHome['assignments'];
  hasOrder: boolean;
}): JSX.Element | null {
  const entries = assignments?.entries ?? [];
  if (entries.length === 0) return null;

  return (
    <Card variant="filled">
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
            <Typography variant="h6">Little League draw</Typography>
            <Chip size="small" label={`${entries.length} managers`} />
          </Stack>

          {!hasOrder && (
            <Typography variant="body2" color="text.secondary">
              Each manager drew one team at random. Whoever&rsquo;s team lasts longest picks their
              draft slot first — ties go to the worse finisher last season, then to the recorded
              random seed.
              {assignments && assignments.stillPlaying > 0 && (
                <>
                  {' '}
                  <strong>
                    {assignments.stillPlaying} still playing, so those places can still move.
                  </strong>
                </>
              )}
            </Typography>
          )}

          <Divider />

          <Stack divider={<Divider flexItem />}>
            {entries.map((entry) => (
              <Stack
                key={entry.manager}
                direction="row"
                spacing={2}
                alignItems="center"
                justifyContent="space-between"
                sx={{ py: 1.25 }}
              >
                <Stack
                  direction="row"
                  spacing={1.5}
                  alignItems="center"
                  sx={{ minWidth: 0, flex: 1 }}
                >
                  <StandingBadge standing={entry.standing} />
                  <Typography variant="body1" noWrap sx={{ fontWeight: 600 }}>
                    {entry.manager}
                  </Typography>
                </Stack>
                <Stack sx={{ textAlign: 'right', minWidth: 0 }}>
                  <Typography
                    variant="body2"
                    sx={{
                      /*
                        Struck through once the team is out: it stops mattering, the
                        position it earned does not. Keyed on being out rather than on
                        having a settled position — a team tied with another is still
                        out, and leaving it unstruck said it was still playing.
                      */
                      textDecoration: isOut(entry.standing) ? 'line-through' : 'none',
                      color: isOut(entry.standing) ? 'text.disabled' : 'text.primary',
                    }}
                  >
                    {entry.llwsTeam}
                  </Typography>
                  {entry.region && (
                    <Typography variant="caption" color="text.secondary">
                      {entry.region}
                    </Typography>
                  )}
                </Stack>
              </Stack>
            ))}
          </Stack>

          {/*
            Small, last, and off to one side. The people who want to audit a random
            draw are a minority of a twelve-person league, and the rest should not
            have to scroll past cryptographic reassurance to reach the countdown.
          */}
          <Tooltip title="Every pairing came from one recorded random seed. Same seed, same draw — so it can be re-run and checked.">
            <Link
              component={RouterLink}
              to="/draw"
              variant="caption"
              color="text.secondary"
              sx={{ alignSelf: 'flex-start' }}
            >
              How this draw was made
            </Link>
          </Tooltip>
        </Stack>
      </CardContent>
    </Card>
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
  assignments,
}: {
  draftAt: string | null;
  order: Array<{ draftPosition: number; manager: string; llwsTeam: string | null }> | null;
  assignments: PublicHome['assignments'];
}): JSX.Element {
  return (
    <Stack spacing={4}>
      <Countdown target={draftAt} />

      {order ? (
        <DraftOrder order={order} />
      ) : assignments && assignments.entries.length > 0 /*
          The draw has happened but the tournament decides the order, so there is
          nothing to put here yet. The mapping below explains what everyone is
          waiting on; a second card saying "not set yet" would just repeat it.
        */ ? null : (
        <Card variant="filled">
          <CardContent>
            <Stack spacing={1.5} alignItems="center" sx={{ textAlign: 'center', py: 3 }}>
              <SportsFootballIcon color="disabled" sx={{ fontSize: 44 }} />
              <Typography variant="h6">The draft order is not set yet</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ maxWidth: '46ch' }}>
                Every manager gets a Little League World Series team at random. How far your team
                goes decides what order you pick in. It lands here as soon as the draw is done.
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      )}

      <LlwsMapping assignments={assignments} hasOrder={order !== null} />
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

  /*
    Retired the day after the draft. "It is draft time" shouted from the home page
    for the rest of the season would be worse than showing nothing, and the draft
    order below it is the part that still matters in October.
  */
  if (now - targetMs > 24 * 60 * 60 * 1000) return null;

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

/** Whether the team is out of the tournament, tied or not. */
function isOut(
  standing: NonNullable<PublicHome['assignments']>['entries'][number]['standing'],
): boolean {
  return standing !== null && standing.pending !== 'playing';
}

/**
 * Where a manager stands: a settled position, or the range still in play.
 *
 * A locked position and a range are visually distinct on purpose. "2nd" and
 * "1st–6th" mean very different things to somebody deciding whether to care yet,
 * and a single number for both would read as settled when it is not.
 */
function StandingBadge({
  standing,
}: {
  standing: NonNullable<PublicHome['assignments']>['entries'][number]['standing'];
}): JSX.Element | null {
  if (standing === null) return null;

  const ordinal = (value: number): string => {
    // 11th, 12th and 13th break the naive rule, so they are handled first.
    const teen = value % 100;
    if (teen >= 11 && teen <= 13) return `${value}th`;
    const last = value % 10;
    return `${value}${last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'}`;
  };

  const label = standing.locked ? ordinal(standing.best) : `${standing.best}–${standing.worst}`;

  /*
    A tie is not the same as an open question. Teams knocked out together will never
    narrow — who picks first among them comes from prior-season finish and the seed —
    so it is worth saying rather than leaving a range that looks like it might move.
  */
  const hint =
    standing.pending === 'tied'
      ? 'Out together with others — the tiebreakers decide the order within this range.'
      : standing.pending === 'playing'
        ? 'Still playing, so this narrows as other teams go out.'
        : 'Settled.';

  return (
    <Tooltip title={hint}>
      <Box
        sx={{
          minWidth: 52,
          px: 0.75,
          py: 0.25,
          borderRadius: 1.5,
          textAlign: 'center',
          flexShrink: 0,
          bgcolor: standing.locked ? 'action.selected' : 'transparent',
          border: 1,
          borderColor: standing.locked ? 'transparent' : 'divider',
          borderStyle: standing.locked ? 'solid' : 'dashed',
        }}
      >
        <Typography
          variant="caption"
          sx={{
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            color: standing.locked ? 'text.primary' : 'text.secondary',
          }}
        >
          {label}
        </Typography>
      </Box>
    </Tooltip>
  );
}
