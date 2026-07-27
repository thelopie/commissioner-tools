import { Alert, Box, Button, Card, CardContent, Stack, Typography } from '@mui/material';
import { useSearchParams } from 'react-router-dom';

/**
 * Sign-in.
 *
 * The only way in is Yahoo OAuth: the Yahoo GUID is the one Yahoo value the terms
 * permit storing indefinitely, which makes it a natural identity anchor and means
 * this application never stores a password.
 *
 * Portal roles are separate and Dinkel-owned — signing in with Yahoo does not
 * grant commissioner access, even to Yahoo's own league commissioner.
 */
export function SignInPage(): JSX.Element {
  const [params] = useSearchParams();
  const yahooError = params.get('yahooError');

  return (
    <Box sx={{ maxWidth: 520, mx: 'auto', mt: { xs: 2, sm: 6 } }}>
      <Card>
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h1">Dinkel Portal</Typography>
            <Typography variant="body1" color="text.secondary">
              League operations for a long-running fantasy football league. Yahoo stays the source
              of truth for scores and rosters; the portal owns dues, prizes, weekly challenges, and
              the draft-order workflow.
            </Typography>

            {yahooError && <YahooErrorAlert code={yahooError} />}

            <Button variant="contained" size="large" href="/auth/yahoo/start" fullWidth>
              Sign in with Yahoo
            </Button>

            <Typography variant="caption" color="text.secondary">
              The portal requests read-only Fantasy access. It cannot change your lineup, make
              transactions, or act as commissioner in Yahoo — no Yahoo API endpoint for those is
              documented, and the portal does not request write access. You can remove the
              connection at any time, which deletes the stored credentials and any cached Yahoo
              data.
            </Typography>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}

/**
 * Explains a failed OAuth attempt.
 *
 * Each case gets its own wording because the recovery differs: a declined consent
 * screen is not the same problem as an expired state or a rejected credential, and
 * one generic message would leave a user guessing which.
 */
function YahooErrorAlert({ code }: { code: string }): JSX.Element {
  const { severity, message } = describeOAuthError(code);

  return (
    <Alert severity={severity}>
      <Typography variant="body2">{message}</Typography>
    </Alert>
  );
}

export function describeOAuthError(code: string): {
  severity: 'error' | 'warning' | 'info';
  message: string;
} {
  switch (code) {
    case 'oauth_denied':
      return {
        severity: 'info',
        message:
          'You declined access on Yahoo’s screen, so nothing was connected. Sign in again if that was not intended.',
      };

    case 'oauth_state_expired':
      return {
        severity: 'warning',
        message: 'That sign-in attempt timed out before it finished. Start again.',
      };

    case 'oauth_state_reused':
      return {
        severity: 'warning',
        message: 'That sign-in link had already been used. Start a fresh sign-in.',
      };

    case 'oauth_state_invalid':
    case 'oauth_state_missing':
      return {
        severity: 'warning',
        message:
          'That sign-in attempt could not be verified, so it was rejected. Start again from this page.',
      };

    case 'oauth_exchange_failed':
      return {
        severity: 'error',
        message:
          'Yahoo accepted the sign-in but the portal could not complete it. Try again — if it keeps ' +
          'failing, the Yahoo application credentials may need attention.',
      };

    case 'yahoo_needs_reconnect':
      return {
        severity: 'warning',
        message: 'Your previous Yahoo authorization is no longer valid. Sign in again to renew it.',
      };

    case 'yahoo_unavailable':
      return {
        severity: 'warning',
        message: 'Yahoo did not respond. Try again shortly.',
      };

    case 'yahoo_rate_limited':
      return {
        severity: 'warning',
        message: 'Yahoo is rate limiting requests right now. Wait a moment and try again.',
      };

    default:
      return {
        severity: 'error',
        message: 'The Yahoo sign-in did not complete. Try again.',
      };
  }
}
