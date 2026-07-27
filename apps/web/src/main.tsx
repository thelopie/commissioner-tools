import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { ApiError } from './api/client.js';
import { theme } from './theme.js';

/**
 * Application entry point.
 *
 * Query defaults are chosen for a league tool that reads live Yahoo data:
 * short staleness (scores change), no retry on client errors (a 403 will not
 * become a 200), and no refetch storm on window focus.
 */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Yahoo data is fetched live and cached briefly server-side; the client
      // holds it just long enough to avoid refetching on every navigation.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Retrying a permission error or a missing record just delays the message.
        if (error instanceof ApiError && !error.isTransient) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      // A mutation that failed may have partially applied; retrying is the
      // caller's decision, not a default.
      retry: false,
    },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme}>
        <CssBaseline enableColorScheme />
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
