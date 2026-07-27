import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { CssBaseline, ThemeProvider, useMediaQuery } from '@mui/material';
import { darkTheme, lightTheme } from './index.js';

/**
 * Colour-scheme control.
 *
 * Three states rather than two: `system` is the default and the one most people
 * want, with explicit light and dark as overrides. A binary toggle silently
 * discards the OS preference, which is the wrong default for something checked on
 * a phone at night.
 *
 * The choice persists in localStorage. This is a display preference with no
 * privacy weight, so it does not belong on the server.
 */

export type ColorSchemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'dinkel:color-scheme';

interface ColorSchemeContextValue {
  preference: ColorSchemePreference;
  /** What is actually rendering, after resolving `system`. */
  resolved: 'light' | 'dark';
  setPreference: (next: ColorSchemePreference) => void;
  /** Cycles system → light → dark → system. */
  cycle: () => void;
}

const ColorSchemeContext = createContext<ColorSchemeContextValue | null>(null);

function readStored(): ColorSchemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    // Private browsing can throw on localStorage access. A missing preference is
    // not worth failing a render over.
  }
  return 'system';
}

export function ColorSchemeProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const [preference, setPreferenceState] = useState<ColorSchemePreference>(readStored);

  const resolved: 'light' | 'dark' =
    preference === 'system' ? (prefersDark ? 'dark' : 'light') : preference;

  const setPreference = useCallback((next: ColorSchemePreference) => {
    setPreferenceState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Preference simply will not persist. Not worth surfacing.
    }
  }, []);

  const cycle = useCallback(() => {
    setPreference(preference === 'system' ? 'light' : preference === 'light' ? 'dark' : 'system');
  }, [preference, setPreference]);

  // Keep the native UI (form controls, scrollbars) in step with the app.
  useEffect(() => {
    document.documentElement.style.colorScheme = resolved;
    document.documentElement.dataset['theme'] = resolved;
  }, [resolved]);

  const value = useMemo(
    () => ({ preference, resolved, setPreference, cycle }),
    [preference, resolved, setPreference, cycle],
  );

  return (
    <ColorSchemeContext.Provider value={value}>
      <ThemeProvider theme={resolved === 'dark' ? darkTheme : lightTheme}>
        <CssBaseline enableColorScheme />
        {children}
      </ThemeProvider>
    </ColorSchemeContext.Provider>
  );
}

export function useColorScheme(): ColorSchemeContextValue {
  const context = useContext(ColorSchemeContext);
  if (!context) throw new Error('useColorScheme must be used inside ColorSchemeProvider');
  return context;
}
