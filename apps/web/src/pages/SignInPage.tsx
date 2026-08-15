import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Link,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import LockIcon from '@mui/icons-material/LockRounded';
import VisibilityIcon from '@mui/icons-material/VisibilityRounded';
import BlockIcon from '@mui/icons-material/BlockRounded';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSession } from '../hooks.js';

/**
 * Sign-in.
 *
 * The only way in is Yahoo OAuth: the Yahoo GUID is one of the few values Yahoo's
 * terms permit storing indefinitely, which makes it a natural identity anchor and
 * means this application stores no password.
 *
 * The three guarantees below are stated up front rather than buried in a privacy
 * page. Someone about to hand over account access should be able to see what the
 * portal can and cannot do before they click.
 */
export function SignInPage(): JSX.Element {
  const [params] = useSearchParams();
  const yahooError = params.get('yahooError');

  /**
   * Whether the deployment has its Yahoo credentials yet.
   *
   * Undefined while the session request is in flight, which is why the check below is
   * an explicit `=== false` — a brief flash of "not open yet" on every page load would
   * be worse than a button that is momentarily enabled.
   */
  const session = useSession();
  const notOpenYet = session.data?.yahooConfigured === false;

  return (
    <Box sx={{ maxWidth: 560, mx: 'auto', mt: { xs: 1, sm: 5 } }}>
      <Stack spacing={3}>
        <Stack spacing={1.5} alignItems="center" sx={{ textAlign: 'center' }}>
          <Box
            sx={{
              width: 64,
              height: 64,
              borderRadius: 4,
              display: 'grid',
              placeItems: 'center',
              bgcolor: 'primary.main',
              color: 'primary.contrastText',
              fontWeight: 800,
              fontSize: '1.75rem',
            }}
          >
            LL
          </Box>
          <Typography variant="h1" id="page-title" tabIndex={-1} sx={{ outline: 'none' }}>
            La Liga de Lopie
          </Typography>
          <Typography variant="body1" color="text.secondary" sx={{ maxWidth: '46ch' }}>
            League operations for a long-running fantasy football league. Yahoo stays the source of
            truth for scores and rosters; the portal owns dues, prizes, weekly challenges, and the
            draft-order workflow.
          </Typography>
        </Stack>

        {yahooError && <YahooErrorAlert code={yahooError} />}

        <Card variant="filled">
          <CardContent>
            <Stack spacing={2.5}>
              {notOpenYet ? (
                /*
                  Waiting on Yahoo's approval of the API application. Offering the
                  button anyway would send people to a Yahoo error page that gives
                  them no way to tell whose fault it is.
                */
                <Stack spacing={1.5}>
                  <Alert severity="info">
                    <AlertTitle>Not open just yet</AlertTitle>
                    The portal is waiting on its Yahoo API credentials. Everything is built and
                    ready — signing in opens as soon as Yahoo approves the connection, and your
                    commissioner will let you know.
                  </Alert>
                  <SetupSignIn />
                </Stack>
              ) : (
                <Button variant="contained" size="large" href="/auth/yahoo/start" fullWidth>
                  Sign in with Yahoo
                </Button>
              )}

              <Stack spacing={1.5}>
                <Guarantee
                  icon={<VisibilityIcon />}
                  title="Read-only access"
                  body="The portal requests read-only Fantasy permission. It cannot change your lineup, make transactions, or act as commissioner in Yahoo."
                />
                <Guarantee
                  icon={<BlockIcon />}
                  title="Nothing is warehoused"
                  body="Scores, rosters, and names are read live and cached for minutes. Yahoo's terms allow keeping only your account ID and access tokens."
                />
                <Guarantee
                  icon={<LockIcon />}
                  title="Revocable at any time"
                  body="Removing the connection deletes the stored credentials and every cached Yahoo response immediately."
                />
              </Stack>
            </Stack>
          </CardContent>
        </Card>

        <Stack direction="row" spacing={1} justifyContent="center" flexWrap="wrap" useFlexGap>
          <Chip size="small" variant="outlined" label="No passwords stored" />
          <Chip size="small" variant="outlined" label="No payments processed" />
          <Chip size="small" variant="outlined" label="Not affiliated with Yahoo" />
        </Stack>
      </Stack>
    </Box>
  );
}

/**
 * The commissioner's temporary way in, and the counterpart to `/auth/break-glass`.
 *
 * Deliberately small and folded away: the league should see the "not open yet" notice
 * and nothing that looks like a second login. It only renders while Yahoo is
 * unconfigured, and the endpoint behind it refuses once Yahoo works — so this
 * disappears on its own rather than needing to be remembered.
 */
function SetupSignIn(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/auth/break-glass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      if (!response.ok) {
        setError('That token was not accepted.');
        return;
      }

      // A full reload rather than a router navigation: the session cookie is new, and
      // every cached query in memory was fetched as a signed-out user.
      window.location.assign('/');
    } catch {
      setError('Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Box sx={{ textAlign: 'center' }}>
        <Link component="button" type="button" variant="body2" onClick={() => setOpen(true)}>
          Commissioner setup
        </Link>
      </Box>
    );
  }

  return (
    <Box component="form" onSubmit={submit}>
      <Stack spacing={1.5}>
        <TextField
          label="Setup token"
          type="password"
          size="small"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoFocus
          fullWidth
          error={Boolean(error)}
          helperText={error ?? 'Temporary, and only while Yahoo is unconfigured.'}
        />
        <Button type="submit" variant="outlined" disabled={busy || token.length === 0}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </Stack>
    </Box>
  );
}

function Guarantee({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}): JSX.Element {
  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-start">
      <Box
        sx={{
          mt: 0.25,
          width: 36,
          height: 36,
          flexShrink: 0,
          borderRadius: 999,
          display: 'grid',
          placeItems: 'center',
          bgcolor: 'background.surfaceContainerLowest',
          color: 'primary.main',
          '& svg': { fontSize: 20 },
        }}
      >
        {icon}
      </Box>
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {body}
        </Typography>
      </Box>
    </Stack>
  );
}

function YahooErrorAlert({ code }: { code: string }): JSX.Element {
  const { severity, message } = describeOAuthError(code);
  return (
    <Alert severity={severity}>
      <Typography variant="body2">{message}</Typography>
    </Alert>
  );
}

/**
 * Explains a failed OAuth attempt.
 *
 * Each case gets its own wording because the recovery differs: a declined consent
 * screen is not the same problem as an expired state or a rejected credential, and
 * one generic message would leave a user guessing which.
 */
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
      return { severity: 'warning', message: 'Yahoo did not respond. Try again shortly.' };

    case 'yahoo_rate_limited':
      return {
        severity: 'warning',
        message: 'Yahoo is rate limiting requests right now. Wait a moment and try again.',
      };

    default:
      return { severity: 'error', message: 'The Yahoo sign-in did not complete. Try again.' };
  }
}
