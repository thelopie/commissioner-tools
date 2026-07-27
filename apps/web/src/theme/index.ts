import { alpha, createTheme, type Theme } from '@mui/material';
import {
  alertContainer,
  darkScheme,
  lightScheme,
  motion,
  shape,
  stateLayer,
  typeScale,
  type ColorRoles,
} from './tokens.js';

/**
 * The MUI theme, built from Material 3 tokens.
 *
 * MUI's default palette is Material 2, which has no concept of surface container
 * tones or colour roles. Rather than fight that, the M3 roles are attached to the
 * theme under `vars`-adjacent custom keys and mapped onto MUI's palette where the
 * names line up, then component overrides do the rest.
 */

declare module '@mui/material/styles' {
  interface Theme {
    /** The full M3 role set for the active scheme. */
    m3: ColorRoles;
    motion: typeof motion;
    shapeScale: typeof shape;
  }
  interface ThemeOptions {
    m3?: ColorRoles;
    motion?: typeof motion;
    shapeScale?: typeof shape;
  }
  interface TypeBackground {
    surfaceContainerLowest: string;
    surfaceContainerLow: string;
    surfaceContainer: string;
    surfaceContainerHigh: string;
    surfaceContainerHighest: string;
  }
}

declare module '@mui/material/Button' {
  interface ButtonPropsVariantOverrides {
    /** M3 filled-tonal: a secondary action that still reads as a button. */
    tonal: true;
  }
}

declare module '@mui/material/Paper' {
  interface PaperPropsVariantOverrides {
    /** M3 filled card: tone instead of shadow. */
    filled: true;
  }
}

const FONT_STACK = [
  '"Inter Variable"',
  'Inter',
  '-apple-system',
  'BlinkMacSystemFont',
  '"Segoe UI"',
  'Roboto',
  '"Helvetica Neue"',
  'Arial',
  'sans-serif',
].join(', ');

function buildTheme(scheme: ColorRoles, mode: 'light' | 'dark'): Theme {
  const base = createTheme({
    m3: scheme,
    motion,
    shapeScale: shape,

    breakpoints: {
      values: { xs: 0, sm: 600, md: 900, lg: 1240, xl: 1600 },
    },

    palette: {
      mode,
      primary: {
        main: scheme.primary,
        contrastText: scheme.onPrimary,
        light: scheme.primaryContainer,
        dark: scheme.onPrimaryContainer,
      },
      secondary: {
        main: scheme.secondary,
        contrastText: scheme.onSecondary,
      },
      error: { main: scheme.error, contrastText: scheme.onError },
      warning: { main: scheme.warning, contrastText: scheme.onWarning },
      success: { main: scheme.success, contrastText: scheme.onSuccess },
      info: { main: scheme.tertiary, contrastText: scheme.onTertiary },
      background: {
        default: scheme.background,
        paper: scheme.surfaceContainerLow,
        surfaceContainerLowest: scheme.surfaceContainerLowest,
        surfaceContainerLow: scheme.surfaceContainerLow,
        surfaceContainer: scheme.surfaceContainer,
        surfaceContainerHigh: scheme.surfaceContainerHigh,
        surfaceContainerHighest: scheme.surfaceContainerHighest,
      },
      text: {
        primary: scheme.onSurface,
        secondary: scheme.onSurfaceVariant,
        disabled: alpha(scheme.onSurface, stateLayer.disabledContent),
      },
      divider: scheme.outlineVariant,
      action: {
        active: scheme.onSurfaceVariant,
        hover: alpha(scheme.onSurface, stateLayer.hover),
        hoverOpacity: stateLayer.hover,
        selected: alpha(scheme.primary, stateLayer.focus),
        selectedOpacity: stateLayer.focus,
        focus: alpha(scheme.onSurface, stateLayer.focus),
        focusOpacity: stateLayer.focus,
        disabled: alpha(scheme.onSurface, stateLayer.disabledContent),
        disabledBackground: alpha(scheme.onSurface, stateLayer.disabledContainer),
      },
    },

    shape: { borderRadius: shape.medium },

    typography: {
      fontFamily: FONT_STACK,
      // MUI's variants mapped onto the M3 scale, so `variant="h1"` and friends
      // land on real M3 sizes instead of Material 2 ones.
      h1: typeScale.headlineLarge,
      h2: typeScale.headlineSmall,
      h3: typeScale.titleLarge,
      h4: typeScale.titleMedium,
      h5: typeScale.titleSmall,
      h6: typeScale.titleSmall,
      subtitle1: typeScale.titleMedium,
      subtitle2: typeScale.titleSmall,
      body1: typeScale.bodyLarge,
      body2: typeScale.bodyMedium,
      caption: typeScale.bodySmall,
      overline: { ...typeScale.labelSmall, textTransform: 'uppercase' },
      button: { ...typeScale.labelLarge, textTransform: 'none' },
    },

    // M3 replaces shadow-based elevation with surface tones, so the shadow scale
    // is flattened. A couple of low levels remain for genuinely floating things
    // (menus, snackbars) where a shadow is the only depth cue available.
    shadows: [
      'none',
      '0px 1px 2px rgba(0,0,0,0.10), 0px 1px 3px 1px rgba(0,0,0,0.06)',
      '0px 1px 2px rgba(0,0,0,0.10), 0px 2px 6px 2px rgba(0,0,0,0.06)',
      '0px 4px 8px 3px rgba(0,0,0,0.08), 0px 1px 3px rgba(0,0,0,0.10)',
      '0px 6px 10px 4px rgba(0,0,0,0.08), 0px 2px 3px rgba(0,0,0,0.10)',
      ...(Array(20).fill(
        '0px 8px 12px 6px rgba(0,0,0,0.08), 0px 4px 4px rgba(0,0,0,0.10)',
      ) as string[]),
    ] as Theme['shadows'],

    transitions: {
      easing: {
        easeInOut: motion.easing.emphasized,
        easeOut: motion.easing.emphasizedDecelerate,
        easeIn: motion.easing.emphasizedAccelerate,
        sharp: motion.easing.standard,
      },
      duration: {
        shortest: motion.duration.short,
        shorter: motion.duration.short,
        short: motion.duration.medium,
        standard: motion.duration.medium,
        complex: motion.duration.long,
        enteringScreen: motion.duration.medium,
        leavingScreen: motion.duration.short,
      },
    },
  });

  return createTheme(base, {
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          ':root': {
            colorScheme: mode,
          },
          body: {
            backgroundColor: scheme.background,
            color: scheme.onSurface,
            // Long-form text at small sizes benefits noticeably on macOS.
            WebkitFontSmoothing: 'antialiased',
          },
          // A visible, consistent focus ring everywhere. Keyboard users should
          // never have to hunt for where they are.
          '*:focus-visible': {
            outline: `3px solid ${alpha(scheme.primary, 0.6)}`,
            outlineOffset: 2,
            borderRadius: shape.extraSmall,
          },
          // Honour the OS setting rather than animating regardless.
          '@media (prefers-reduced-motion: reduce)': {
            '*, *::before, *::after': {
              animationDuration: '0.01ms !important',
              animationIterationCount: '1 !important',
              transitionDuration: '0.01ms !important',
              scrollBehavior: 'auto !important',
            },
          },
          // Wide content scrolls inside its own container; the page never does.
          '::-webkit-scrollbar': { width: 10, height: 10 },
          '::-webkit-scrollbar-thumb': {
            backgroundColor: alpha(scheme.onSurface, 0.2),
            borderRadius: shape.full,
          },
          '::-webkit-scrollbar-track': { backgroundColor: 'transparent' },
        },
      },

      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: {
            // Pill buttons are the single most recognisable M3 signal.
            borderRadius: shape.full,
            minHeight: 40,
            paddingInline: 24,
            transition: `background-color ${motion.duration.short}ms ${motion.easing.standard}, box-shadow ${motion.duration.short}ms ${motion.easing.standard}`,
          },
          sizeSmall: { minHeight: 32, paddingInline: 16 },
          sizeLarge: { minHeight: 48, paddingInline: 28 },
          containedPrimary: {
            backgroundColor: scheme.primary,
            color: scheme.onPrimary,
            '&:hover': { backgroundColor: alpha(scheme.primary, 0.92) },
          },
          outlined: {
            borderColor: scheme.outline,
            color: scheme.primary,
            '&:hover': {
              backgroundColor: alpha(scheme.primary, stateLayer.hover),
              borderColor: scheme.outline,
            },
          },
          text: {
            color: scheme.primary,
            paddingInline: 12,
            '&:hover': { backgroundColor: alpha(scheme.primary, stateLayer.hover) },
          },
        },
        variants: [
          {
            props: { variant: 'tonal' },
            style: {
              backgroundColor: scheme.secondaryContainer,
              color: scheme.onSecondaryContainer,
              '&:hover': {
                backgroundColor: alpha(scheme.onSecondaryContainer, 0.12),
              },
              '&.Mui-disabled': {
                backgroundColor: alpha(scheme.onSurface, stateLayer.disabledContainer),
                color: alpha(scheme.onSurface, stateLayer.disabledContent),
              },
            },
          },
        ],
      },

      MuiIconButton: {
        styleOverrides: {
          root: {
            borderRadius: shape.full,
            color: scheme.onSurfaceVariant,
            '&:hover': { backgroundColor: alpha(scheme.onSurface, stateLayer.hover) },
          },
        },
      },

      MuiCard: {
        defaultProps: { variant: 'outlined' },
        styleOverrides: {
          root: {
            borderRadius: shape.large,
            borderColor: scheme.outlineVariant,
            backgroundColor: scheme.surfaceContainerLow,
            backgroundImage: 'none',
          },
        },
        variants: [
          {
            props: { variant: 'filled' },
            style: {
              // Tone, not shadow. This is the M3 filled card.
              backgroundColor: scheme.surfaceContainerHighest,
              border: 'none',
            },
          },
          {
            props: { variant: 'elevation' },
            style: {
              backgroundColor: scheme.surfaceContainerLow,
              border: 'none',
            },
          },
        ],
      },

      MuiCardContent: {
        styleOverrides: {
          root: { padding: 20, '&:last-child': { paddingBottom: 20 } },
        },
      },

      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none' },
          rounded: { borderRadius: shape.large },
        },
      },

      MuiChip: {
        styleOverrides: {
          root: {
            borderRadius: shape.small,
            height: 28,
            fontWeight: 600,
            fontSize: typeScale.labelMedium.fontSize,
            letterSpacing: typeScale.labelMedium.letterSpacing,
          },
          outlined: { borderColor: scheme.outlineVariant, color: scheme.onSurfaceVariant },
          // Scoped to the default colour on purpose. An unscoped `filled` rule wins
          // on specificity over colorWarning/colorSuccess and silently turned every
          // semantic chip grey.
          filled: {
            '&.MuiChip-colorDefault': {
              backgroundColor: scheme.surfaceContainerHighest,
              color: scheme.onSurfaceVariant,
            },
          },
          // Each scoped by variant. Unscoped, the colour rules also set a
          // background on OUTLINED chips, which turned every outlined semantic chip
          // solid — the mirror image of the `filled` problem noted above.
          colorSuccess: {
            '&.MuiChip-filled': {
              backgroundColor: scheme.successContainer,
              color: scheme.onSuccessContainer,
            },
            '&.MuiChip-outlined': {
              color: scheme.success,
              borderColor: alpha(scheme.success, 0.5),
            },
          },
          colorWarning: {
            '&.MuiChip-filled': {
              backgroundColor: scheme.warningContainer,
              color: scheme.onWarningContainer,
            },
            '&.MuiChip-outlined': {
              color: scheme.warning,
              borderColor: alpha(scheme.warning, 0.5),
            },
          },
          colorError: {
            '&.MuiChip-filled': {
              backgroundColor: scheme.errorContainer,
              color: scheme.onErrorContainer,
            },
            '&.MuiChip-outlined': { color: scheme.error, borderColor: alpha(scheme.error, 0.5) },
          },
          colorInfo: {
            '&.MuiChip-filled': {
              backgroundColor: scheme.tertiaryContainer,
              color: scheme.onTertiaryContainer,
            },
            '&.MuiChip-outlined': {
              color: scheme.tertiary,
              borderColor: alpha(scheme.tertiary, 0.5),
            },
          },
          colorPrimary: {
            '&.MuiChip-filled': {
              backgroundColor: scheme.primaryContainer,
              color: scheme.onPrimaryContainer,
            },
            '&.MuiChip-outlined': {
              color: scheme.primary,
              borderColor: alpha(scheme.primary, 0.5),
            },
          },
        },
      },

      MuiAlert: {
        variants: [
          {
            props: { severity: 'info' },
            style: {
              backgroundColor: alertContainer.info[mode],
              color: scheme.onTertiaryContainer,
              border: `1px solid ${alpha(scheme.tertiary, 0.25)}`,
              '& .MuiAlert-icon': { color: scheme.tertiary },
            },
          },
          {
            props: { severity: 'success' },
            style: {
              backgroundColor: alertContainer.success[mode],
              color: scheme.onSuccessContainer,
              border: `1px solid ${alpha(scheme.success, 0.25)}`,
              '& .MuiAlert-icon': { color: scheme.success },
            },
          },
          {
            props: { severity: 'warning' },
            style: {
              backgroundColor: alertContainer.warning[mode],
              color: scheme.onWarningContainer,
              border: `1px solid ${alpha(scheme.warning, 0.3)}`,
              '& .MuiAlert-icon': { color: scheme.warning },
            },
          },
          {
            props: { severity: 'error' },
            style: {
              backgroundColor: alertContainer.error[mode],
              color: scheme.onErrorContainer,
              border: `1px solid ${alpha(scheme.error, 0.25)}`,
              '& .MuiAlert-icon': { color: scheme.error },
            },
          },
        ],
        styleOverrides: {
          root: {
            borderRadius: shape.medium,
            alignItems: 'flex-start',
            paddingBlock: 12,
          },
          message: { paddingBlock: 0, width: '100%' },
          action: { alignItems: 'center', paddingTop: 0 },
        },
      },

      MuiAlertTitle: {
        styleOverrides: {
          root: { ...typeScale.titleSmall, marginBottom: 2 },
        },
      },

      MuiTextField: {
        defaultProps: { variant: 'outlined' },
      },

      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: shape.small,
            backgroundColor: scheme.surfaceContainerLowest,
            '& .MuiOutlinedInput-notchedOutline': { borderColor: scheme.outline },
            '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: scheme.onSurfaceVariant },
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
              borderWidth: 2,
              borderColor: scheme.primary,
            },
          },
        },
      },

      MuiTooltip: {
        defaultProps: { arrow: true, enterDelay: 400 },
        styleOverrides: {
          tooltip: {
            backgroundColor: scheme.inverseSurface,
            color: scheme.inverseOnSurface,
            borderRadius: shape.extraSmall,
            ...typeScale.bodySmall,
            paddingInline: 10,
            paddingBlock: 6,
            maxWidth: 300,
          },
          arrow: { color: scheme.inverseSurface },
        },
      },

      MuiDivider: {
        styleOverrides: { root: { borderColor: scheme.outlineVariant } },
      },

      MuiSkeleton: {
        defaultProps: { animation: 'wave' },
        styleOverrides: {
          root: { backgroundColor: alpha(scheme.onSurface, 0.08), borderRadius: shape.small },
        },
      },

      MuiTableCell: {
        styleOverrides: {
          root: { borderColor: scheme.outlineVariant, paddingInline: 12, paddingBlock: 10 },
          head: {
            ...typeScale.labelLarge,
            color: scheme.onSurfaceVariant,
            backgroundColor: scheme.surfaceContainer,
          },
        },
      },

      MuiLinearProgress: {
        styleOverrides: {
          root: {
            borderRadius: shape.full,
            height: 6,
            backgroundColor: scheme.surfaceContainerHighest,
          },
          bar: { borderRadius: shape.full },
        },
      },

      MuiSnackbarContent: {
        styleOverrides: {
          root: {
            backgroundColor: scheme.inverseSurface,
            color: scheme.inverseOnSurface,
            borderRadius: shape.extraSmall,
            ...typeScale.bodyMedium,
          },
        },
      },

      MuiLink: {
        defaultProps: { underline: 'hover' },
        styleOverrides: { root: { color: scheme.primary, fontWeight: 500 } },
      },

      MuiAvatar: {
        styleOverrides: {
          root: { ...typeScale.labelLarge, fontWeight: 700 },
        },
      },
    },
  });
}

export const lightTheme = buildTheme(lightScheme, 'light');
export const darkTheme = buildTheme(darkScheme, 'dark');

export { lightScheme, darkScheme, motion, shape, typeScale, stateLayer };
