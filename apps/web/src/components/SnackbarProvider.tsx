import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Alert, Snackbar, Slide, type AlertColor } from '@mui/material';

/**
 * Transient feedback for actions that succeed.
 *
 * Without this, a successful mutation is silent: the commissioner clicks
 * "Confirm", something changes somewhere on the page, and nothing acknowledges
 * that the action landed. Errors were already surfaced inline; this covers the
 * success path, which is the more common one.
 *
 * Deliberately one at a time. Stacked toasts compete for attention and obscure
 * the thing the person was looking at.
 */

interface Toast {
  message: string;
  severity: AlertColor;
  key: number;
}

interface SnackbarContextValue {
  notify: (message: string, severity?: AlertColor) => void;
}

const SnackbarContext = createContext<SnackbarContextValue | null>(null);

export function SnackbarProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [toast, setToast] = useState<Toast | null>(null);

  const notify = useCallback((message: string, severity: AlertColor = 'success') => {
    setToast({ message, severity, key: Date.now() });
  }, []);

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <SnackbarContext.Provider value={value}>
      {children}

      <Snackbar
        key={toast?.key}
        open={toast !== null}
        // Long enough to read a sentence, short enough not to linger.
        autoHideDuration={4000}
        onClose={(_event, reason) => {
          // Ignore click-away so a stray click elsewhere does not dismiss the only
          // confirmation the person is going to get.
          if (reason === 'clickaway') return;
          setToast(null);
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        slots={{ transition: Slide }}
        sx={{
          // Clear the bottom navigation on small screens so the toast never
          // covers the nav it is reporting about.
          bottom: { xs: 88, md: 24 },
        }}
      >
        <Alert
          severity={toast?.severity ?? 'success'}
          variant="filled"
          onClose={() => setToast(null)}
          sx={{ boxShadow: 3, alignItems: 'center' }}
        >
          {toast?.message}
        </Alert>
      </Snackbar>
    </SnackbarContext.Provider>
  );
}

export function useNotify(): (message: string, severity?: AlertColor) => void {
  const context = useContext(SnackbarContext);
  if (!context) throw new Error('useNotify must be used inside SnackbarProvider');
  return context.notify;
}
