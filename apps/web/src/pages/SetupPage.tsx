import { useState } from 'react';
import { Alert, Box, Button, Card, CardContent, Stack, TextField, Typography } from '@mui/material';
import { useBootstrap, useSession } from '../hooks.js';
import { ErrorNotice } from '../components/ErrorNotice.js';

/**
 * One-time commissioner setup.
 *
 * The first authenticated user claims the league and becomes primary
 * commissioner. Guarded by a conditional write on the backend, so two people
 * running setup simultaneously cannot both succeed.
 */
export function SetupPage(): JSX.Element {
  const session = useSession();
  const bootstrap = useBootstrap();

  const [leagueName, setLeagueName] = useState('Dinkel');
  const [timezone, setTimezone] = useState(
    // A sensible default from the browser; the commissioner can correct it.
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
  );

  if (session.data && !session.data.needsBootstrap) {
    return (
      <Alert severity="info" sx={{ mt: 2 }}>
        This portal has already been set up.
      </Alert>
    );
  }

  return (
    <Box sx={{ maxWidth: 560, mx: 'auto', mt: { xs: 1, sm: 4 } }}>
      <Card>
        <CardContent>
          <Stack spacing={2.5}>
            <Typography variant="h1">Set up the portal</Typography>

            <Typography variant="body2" color="text.secondary">
              You are the first person to sign in, so you will become the primary commissioner. That
              is a portal role, held here and independent of who runs the league in Yahoo — you can
              grant, revoke, and transfer it later.
            </Typography>

            <TextField
              label="League name"
              value={leagueName}
              onChange={(event) => setLeagueName(event.target.value)}
              helperText="Your own name for the league. Not read from Yahoo."
              fullWidth
              required
            />

            <TextField
              label="Time zone"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              helperText="Used for deadlines and weekly boundaries."
              fullWidth
            />

            {bootstrap.isError && <ErrorNotice error={bootstrap.error} hideRetry />}

            <Button
              variant="contained"
              size="large"
              disabled={leagueName.trim().length === 0 || bootstrap.isPending}
              onClick={() => bootstrap.mutate({ leagueName: leagueName.trim(), timezone })}
            >
              {bootstrap.isPending ? 'Setting up…' : 'Create the league and claim commissioner'}
            </Button>

            <Typography variant="caption" color="text.secondary">
              Next you will connect a Yahoo league. Nothing about the league, season, or teams is
              hardcoded — you choose from the leagues your Yahoo account can see.
            </Typography>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
