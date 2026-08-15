import { useEffect } from 'react';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { darkTheme } from './index.js';

/**
 * Dark, always.
 *
 * This used to offer system/light/dark with a toggle in the header and the choice
 * kept in localStorage. It was reasonable and nobody wanted it: the league is one
 * dozen people looking at a scoreboard, mostly on a phone, mostly in the evening.
 * A single committed look is easier to design against than two half-tuned ones, and
 * it takes a control out of the header that was competing with the actual content.
 *
 * The light tokens are still in `tokens.ts` if this ever needs undoing — what went
 * away is the theme built from them, not the palette itself.
 */
export function ColorSchemeProvider({ children }: { children: React.ReactNode }): JSX.Element {
  // Keeps native UI — form controls, scrollbars, the flash before React mounts — in
  // step with the app rather than defaulting to the OS preference.
  useEffect(() => {
    document.documentElement.style.colorScheme = 'dark';
    document.documentElement.dataset['theme'] = 'dark';
  }, []);

  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}
