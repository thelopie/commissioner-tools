import { createTheme } from '@mui/material';

/**
 * Theme.
 *
 * Mobile-first: managers check this on a phone during games, so touch targets are
 * comfortable and the type scale stays readable at small sizes. Light and dark
 * both work, following the device setting.
 */
export const theme = createTheme({
  colorSchemes: { light: true, dark: true },
  cssVariables: { colorSchemeSelector: 'class' },
  palette: {
    primary: { main: '#1b5e20' },
    secondary: { main: '#8d6e63' },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily:
      '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    h1: { fontSize: '1.75rem', fontWeight: 700 },
    h2: { fontSize: '1.4rem', fontWeight: 700 },
    h3: { fontSize: '1.15rem', fontWeight: 600 },
    body2: { fontSize: '0.9rem' },
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      // Comfortable on a phone without looking oversized on a desktop.
      styleOverrides: { root: { textTransform: 'none', minHeight: 42 } },
    },
    MuiCard: {
      defaultProps: { variant: 'outlined' },
    },
    MuiChip: {
      styleOverrides: { root: { fontWeight: 600 } },
    },
    MuiTableCell: {
      styleOverrides: { root: { paddingLeft: 12, paddingRight: 12 } },
    },
  },
});
