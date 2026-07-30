import { Suspense, lazy } from 'react';
import { Box, CircularProgress, Container } from '@mui/material';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession, useSignOut } from './hooks.js';
import { ApiError } from './api/client.js';
import { ErrorNotice } from './components/ErrorNotice.js';
import { AppShell } from './components/AppShell.js';
import { HomePage } from './pages/HomePage.js';
import { MatchupsPage } from './pages/MatchupsPage.js';
import { MyTeamPage } from './pages/MyTeamPage.js';
import { DraftPage } from './pages/DraftPage.js';
import { LlwsPage } from './pages/LlwsPage.js';
import { MoneyPage } from './pages/MoneyPage.js';
import { AnnouncementsPage } from './pages/AnnouncementsPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { RecapsPage } from './pages/RecapsPage.js';
import { TransactionsPage } from './pages/TransactionsPage.js';
import { StandingsPage } from './pages/StandingsPage.js';
import { SignInPage } from './pages/SignInPage.js';
import { SetupPage } from './pages/SetupPage.js';

// Kept out of the initial bundle: reference pages a commissioner opens
// occasionally should not slow the dashboard everyone loads first.
const CommissionerPage = lazy(() =>
  import('./pages/CommissionerPage.js').then((module) => ({ default: module.CommissionerPage })),
);
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
      <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '100dvh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (session.isError) {
    return (
      <Container maxWidth="sm" sx={{ mt: 6 }}>
        <ErrorNotice error={session.error} onRetry={() => void session.refetch()} />
      </Container>
    );
  }

  const data = session.data;
  const authenticated = data?.authenticated ?? false;
  const user = data?.user ?? null;
  const isCommissioner = user?.role === 'commissioner';

  const roleLabel = user
    ? `${user.role}${user.isPrimaryCommissioner ? ' · primary' : ''}`
    : undefined;

  return (
    <AppShell
      authenticated={authenticated}
      isCommissioner={isCommissioner}
      displayName={user?.displayName}
      roleLabel={roleLabel}
      yahooMode={data?.yahooMode}
      onSignOut={() => signOut.mutate()}
      signOutPending={signOut.isPending}
    >
      <Suspense
        fallback={
          <Box sx={{ display: 'grid', placeItems: 'center', minHeight: 320 }}>
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
                <HomePage />
              )
            }
          />
          <Route
            path="/matchups"
            element={authenticated ? <MatchupsPage /> : <Navigate to="/signin" replace />}
          />
          <Route
            path="/my-team"
            element={authenticated ? <MyTeamPage /> : <Navigate to="/signin" replace />}
          />
          <Route
            path="/draft"
            element={authenticated ? <DraftPage /> : <Navigate to="/signin" replace />}
          />
          <Route
            path="/money"
            element={authenticated ? <MoneyPage /> : <Navigate to="/signin" replace />}
          />
          <Route
            path="/recaps"
            element={authenticated ? <RecapsPage /> : <Navigate to="/signin" replace />}
          />
          <Route
            path="/announcements"
            element={authenticated ? <AnnouncementsPage /> : <Navigate to="/signin" replace />}
          />
          <Route
            path="/transactions"
            element={authenticated ? <TransactionsPage /> : <Navigate to="/signin" replace />}
          />
          <Route
            path="/standings"
            element={authenticated ? <StandingsPage /> : <Navigate to="/signin" replace />}
          />
          <Route
            path="/challenges"
            element={authenticated ? <ChallengesPage /> : <Navigate to="/signin" replace />}
          />
          <Route
            path="/commissioner"
            element={
              isCommissioner ? (
                <CommissionerPage />
              ) : (
                <ErrorNotice
                  error={
                    new ApiError(
                      403,
                      'commissioner_required',
                      'Commissioner tools are commissioner-only.',
                    )
                  }
                />
              )
            }
          />
          <Route
            path="/commissioner/tasks"
            element={
              isCommissioner ? (
                <TasksPage />
              ) : (
                <ErrorNotice
                  error={
                    new ApiError(
                      403,
                      'commissioner_required',
                      'The task list is commissioner-only.',
                    )
                  }
                />
              )
            }
          />
          <Route
            path="/commissioner/llws"
            element={
              isCommissioner ? (
                <LlwsPage />
              ) : (
                <ErrorNotice
                  error={
                    new ApiError(
                      403,
                      'commissioner_required',
                      'Setting up the LLWS draw is commissioner-only. The draft board itself is open to everyone.',
                    )
                  }
                />
              )
            }
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
                // A manager who guesses the URL gets an explanation rather than a
                // blank page. The backend refuses the data regardless, so this is
                // presentation, not the access control itself.
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
    </AppShell>
  );
}
