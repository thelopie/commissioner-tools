import { Box, Button, Card, CardContent, Divider, Skeleton, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { usePublicHome } from '../hooks.js';

/**
 * How to check the draw was not rigged.
 *
 * Deliberately its own page rather than a panel on the home page. Almost nobody will
 * read it, and the handful who want to should not cost everyone else a wall of
 * cryptographic small print above the countdown — but the answer has to exist
 * somewhere, or "it was random" is just the commissioner's word.
 */
export function DrawVerificationPage(): JSX.Element {
  const home = usePublicHome();

  if (home.isLoading) {
    return (
      <Stack spacing={3} sx={{ maxWidth: 720, mx: 'auto' }}>
        <Skeleton height={340} sx={{ borderRadius: 4 }} />
      </Stack>
    );
  }

  const seed = home.data?.assignments?.seed ?? null;
  const drawnAt = home.data?.assignments?.drawnAt ?? null;

  return (
    <Stack spacing={3} sx={{ maxWidth: 720, mx: 'auto' }}>
      <Stack spacing={1}>
        <Typography variant="h1" id="page-title" tabIndex={-1} sx={{ outline: 'none' }}>
          How the draw works
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Every manager was paired with a Little League team by a computer, not by the
          commissioner. Here is how to confirm that.
        </Typography>
      </Stack>

      {seed === null ? (
        <Card variant="filled">
          <CardContent>
            <Typography variant="body2" color="text.secondary">
              The draw has not been published yet. This page fills in once it has.
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <Card variant="filled">
          <CardContent>
            <Stack spacing={2}>
              <Typography variant="h6">The seed</Typography>

              <Box
                sx={{
                  p: 1.5,
                  borderRadius: 2,
                  bgcolor: 'action.hover',
                  fontFamily: 'monospace',
                  fontSize: '0.9rem',
                  // A long opaque string on a phone must wrap rather than overflow.
                  wordBreak: 'break-all',
                }}
              >
                {seed}
              </Box>

              {drawnAt && (
                <Typography variant="caption" color="text.secondary">
                  Recorded {new Date(`${drawnAt}Z`).toLocaleString()}
                </Typography>
              )}

              <Divider />

              <Typography variant="body2" color="text.secondary">
                This string was generated before the draw ran and saved with it. Feeding the same
                seed into the same shuffle always produces exactly the same pairings — so the seed
                plus the list of managers and teams is enough to reproduce the result. Change any
                one of the three and the whole draw comes out different, which is what makes
                quietly swapping a single pairing impossible to hide.
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      )}

      <Card variant="filled">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6">Checking it yourself</Typography>

            <Typography variant="body2" color="text.secondary">
              The shuffle is a Fisher–Yates pass driven by mulberry32, seeded by an xmur3 hash of
              the string above. Both manager list and team list are shuffled, then paired in order
              — shuffling only the teams would have let the result depend on whatever order the
              managers happened to be typed in.
            </Typography>

            <Typography variant="body2" color="text.secondary">
              The code is public and the algorithm is about forty lines. Anyone who wants to
              re-run it can, and any signed-in manager can hit Verify on the draw page, which
              recomputes the pairings from this seed and compares them to what is stored.
            </Typography>

            <Box>
              <Button
                variant="outlined"
                size="small"
                href="https://github.com/thelopie/commissioner-tools/blob/main/packages/draft-order/src/random.ts"
                target="_blank"
                rel="noreferrer noopener"
              >
                Read the shuffle
              </Button>
            </Box>
          </Stack>
        </CardContent>
      </Card>

      <Card variant="filled">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6">What happens next</Typography>
            <Typography variant="body2" color="text.secondary">
              Draft order is decided by how far your Little League team goes. The manager whose
              team lasts longest chooses their draft slot first — choosing first is not the same as
              picking first overall, they simply get first choice of slot. If two teams go out in
              the same round, the tie goes to whoever finished worse in the league last season,
              and if that somehow ties too, back to this same seed.
            </Typography>
          </Stack>
        </CardContent>
      </Card>

      <Box>
        <Button component={RouterLink} to="/" variant="text">
          Back to the league
        </Button>
      </Box>
    </Stack>
  );
}
