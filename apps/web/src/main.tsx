import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';

// Self-hosted variable font. Bundled rather than loaded from a CDN so the strict
// Content-Security-Policy stays `'self'` with no external font origin.
import '@fontsource-variable/inter';

import { App } from './App.js';
import { ApiError } from './api/client.js';
import { ColorSchemeProvider } from './theme/ColorSchemeProvider.js';
import { SnackbarProvider } from './components/SnackbarProvider.js';

/**
 * Application entry point.
 *
 * Query defaults are chosen for a league tool that reads live Yahoo data: short
 * staleness because scores change, no retry on client errors because a 403 will
 * not become a 200, and no refetch storm on window focus.
 */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && !error.isTransient) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      // A failed mutation may have partially applied; retrying is the caller's
      // decision, not a default.
      retry: false,
    },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ColorSchemeProvider>
        <SnackbarProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </SnackbarProvider>
      </ColorSchemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
