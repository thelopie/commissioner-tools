import { Suspense, lazy } from 'react';
import {
  AppBar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Stack,
  Toolbar,
  Typography,
} from '@mui/material';
import { Link as RouterLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession, useSignOut } from './hooks.js';
import { ApiError } from './api/client.js';
import { ErrorNotice } from './components/ErrorNotice.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { SignInPage } from './pages/SignInPage.js';
import { SetupPage } from './pages/SetupPage.js';

// Split out of the initial bundle: reference pages a commissioner opens
// occasionally should not slow the dashboard everyone loads.
const CapabilitiesPage = lazy(() =>
  import('./pages/CapabilitiesPage.js').then((module) => ({ default: module.CapabilitiesPage })),
);
const ChallengesPage = lazy(() =>
  import('./pages/ChallengesPage.js').then((module) => ({ default: module.ChallengesPage })),
);
const AuditPage = lazy(() =>
  import('./pages/AuditPage.js').then((module) => ({ default: module.AuditPage })),
);

export function App(): JSX.Element {
  const session = useSession();
  const signOut = useSignOut();
  const location = useLocation();

  if (session.isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (session.isError) {
    return (
      <Container maxWidth="sm" sx={{ mt: 4 }}>
        <ErrorNotice error={session.error} onRetry={() => void session.refetch()} />
      </Container>
    );
  }

  const data = session.data;
  const authenticated = data?.authenticated ?? false;
  const user = data?.user ?? null;
  const isCommissioner = user?.role === 'commissioner';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh' }}>
      <AppBar
        position="sticky"
        color="default"
        elevation={0}
        sx={{ borderBottom: 1, borderColor: 'divider' }}
      >
        <Toolbar sx={{ gap: 1, flexWrap: 'wrap' }}>
          <Typography
            variant="h6"
            component={RouterLink}
            to="/"
            sx={{ textDecoration: 'none', color: 'inherit', fontWeight: 700, mr: 1 }}
          >
            Dinkel Portal
          </Typography>

          {data?.yahooMode === 'mock' && (
            // Prominent on purpose: it must be impossible to mistake mock data for
            // the real league.
            <Chip size="small" color="warning" label="Mock Yahoo data" />
          )}

          <Box sx={{ flexGrow: 1 }} />

          {authenticated && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
              <Button size="small" component={RouterLink} to="/">
                Dashboard
              </Button>
              <Button size="small" component={RouterLink} to="/challenges">
                Challenges
              </Button>
              <Button size="small" component={RouterLink} to="/yahoo-capabilities">
                Yahoo status
              </Button>
              {isCommissioner && (
                <Button size="small" component={RouterLink} to="/audit">
                  Audit
                </Button>
              )}
              {user && (
                <Chip
                  size="small"
                  variant="outlined"
                  label={`${user.displayName} · ${user.role}${user.isPrimaryCommissioner ? ' (primary)' : ''}`}
                />
              )}
              <Button size="small" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
                Sign out
              </Button>
            </Stack>
          )}
        </Toolbar>
      </AppBar>

      <Container maxWidth="lg" sx={{ py: { xs: 2, sm: 3 }, flexGrow: 1 }}>
        <Suspense
          fallback={
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 6 }}>
              <CircularProgress />
            </Box>
          }
        >
          <Routes>
            <Route
              path="/signin"
              element={authenticated ? <Navigate to="/" replace /> : <SignInPage />}
            />
            <Route
              path="/setup"
              element={
                !authenticated ? (
                  <Navigate
                    to={`/signin?returnTo=${encodeURIComponent(location.pathname)}`}
                    replace
                  />
                ) : (
                  <SetupPage />
                )
              }
            />
            <Route
              path="/"
              element={
                !authenticated ? (
                  <SignInPage />
                ) : data?.needsBootstrap ? (
                  <Navigate to="/setup" replace />
                ) : (
                  <DashboardPage />
                )
              }
            />
            <Route
              path="/challenges"
              element={authenticated ? <ChallengesPage /> : <Navigate to="/signin" replace />}
            />
            <Route
              path="/yahoo-capabilities"
              element={authenticated ? <CapabilitiesPage /> : <Navigate to="/signin" replace />}
            />
            <Route
              path="/audit"
              element={
                isCommissioner ? (
                  <AuditPage />
                ) : (
                  // A manager who guesses the URL gets an explanation, not a blank
                  // page — and the backend refuses the data regardless, so this is
                  // presentation rather than the access control itself.
                  <ErrorNotice
                    error={
                      new ApiError(
                        403,
                        'commissioner_required',
                        'Audit history is commissioner-only.',
                      )
                    }
                  />
                )
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </Container>

      <Box
        component="footer"
        sx={{ borderTop: 1, borderColor: 'divider', py: 2, px: 2, textAlign: 'center' }}
      >
        <Typography variant="caption" color="text.secondary">
          A private, noncommercial league tool. Not affiliated with or endorsed by Yahoo. Yahoo data
          is read live under read-only access and is not stored permanently.
        </Typography>
      </Box>
    </Box>
  );
}
