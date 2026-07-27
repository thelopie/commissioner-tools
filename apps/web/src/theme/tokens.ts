/**
 * Material 3 design tokens.
 *
 * Kept as plain data, separate from the MUI theme, so the palette can be
 * inspected and tested without constructing a theme — and so the reasoning
 * behind each value lives next to the value.
 *
 * The defining idea of M3 is that surfaces are separated by TONE rather than by
 * drop shadow. A card is not "a white box with a shadow"; it is a slightly
 * different tone of the surface colour. That reads as calm and modern, and it
 * survives dark mode, where shadows are nearly invisible.
 */

/**
 * Tonal palettes.
 *
 * M3 generates these from a seed colour: tone 0 is black, 100 is white, and the
 * numbers are perceptual lightness. Roles then reference specific tones, which
 * is what makes light and dark themes derivable from one palette rather than
 * hand-tuned twice.
 *
 * Seed is a deep field green — a football league, not a SaaS dashboard.
 */
export const tonal = {
  primary: {
    0: '#000000',
    10: '#00210b',
    20: '#003917',
    30: '#005223',
    40: '#1b6c31',
    50: '#3a8646',
    60: '#54a15d',
    70: '#6ebc75',
    80: '#89d88e',
    90: '#a4f5a8',
    95: '#c3ffc4',
    99: '#f5fff2',
    100: '#ffffff',
  },
  secondary: {
    10: '#231a04',
    20: '#3a2f15',
    30: '#52452a',
    40: '#6b5d3f',
    50: '#857556',
    60: '#a08f6e',
    70: '#bcaa87',
    80: '#d8c5a1',
    90: '#f5e1bb',
    95: '#fff0d5',
    99: '#fffbf5',
  },
  /** Reserved for accents that must not read as "primary action". */
  tertiary: {
    10: '#001f24',
    20: '#00363d',
    30: '#004f58',
    40: '#006874',
    50: '#008391',
    60: '#00a0b0',
    70: '#22bcce',
    80: '#4fd8eb',
    90: '#9defff',
    95: '#d0f8ff',
    99: '#f5feff',
  },
  neutral: {
    0: '#000000',
    4: '#080d08',
    6: '#0d120c',
    10: '#191d18',
    12: '#1d211c',
    17: '#272b26',
    20: '#2e322c',
    22: '#333630',
    24: '#373b35',
    30: '#444842',
    40: '#5c5f58',
    50: '#757770',
    60: '#8e9189',
    70: '#a9aca3',
    80: '#c5c7be',
    87: '#d8dad0',
    90: '#e1e4d9',
    92: '#e7e9df',
    94: '#edefe4',
    96: '#f2f5ea',
    98: '#f8fbf0',
    99: '#fbfef3',
    100: '#ffffff',
  },
  neutralVariant: {
    10: '#161d13',
    20: '#2b3227',
    30: '#41493d',
    40: '#596054',
    50: '#71796c',
    60: '#8b9385',
    70: '#a6ad9f',
    80: '#c1c9b9',
    90: '#dde5d4',
    95: '#ebf3e2',
    99: '#fafff0',
  },
  error: {
    10: '#410002',
    20: '#690005',
    30: '#93000a',
    40: '#ba1a1a',
    50: '#de3730',
    60: '#ff5449',
    70: '#ff897d',
    80: '#ffb4ab',
    90: '#ffdad6',
    95: '#ffedea',
    99: '#fffbff',
  },
} as const;

/**
 * Alert container tones.
 *
 * Deliberately one step lighter than the matching `*Container` role. A container
 * tone sized for a chip is too saturated once it fills a full-width alert, which
 * made the info banner read as an error.
 */
export const alertContainer = {
  info: { light: '#e2f8ff', dark: '#0c3037' },
  success: { light: '#e3fbe6', dark: '#0d2f16' },
  warning: { light: '#fff3e2', dark: '#3a2606' },
  error: { light: '#ffeceb', dark: '#3c0c0c' },
} as const;

/** Semantic warning and success ramps. M3 defines neither, but a status UI needs both. */
export const status = {
  warning: {
    10: '#2b1700',
    20: '#472a00',
    30: '#653e00',
    40: '#855300',
    70: '#f0bb52',
    80: '#ffdead',
    90: '#ffddb3',
    95: '#ffeedf',
  },
  success: {
    10: '#002106',
    20: '#00390f',
    30: '#00531a',
    40: '#116d29',
    70: '#65c377',
    80: '#82dc91',
    90: '#9df9a9',
    95: '#c5ffca',
  },
} as const;

/**
 * Shape scale.
 *
 * M3 Expressive uses noticeably rounder, more varied corners than M2. The
 * variety is the point: a chip at 8px next to a card at 16px next to a pill
 * button reads as deliberate hierarchy rather than one radius applied everywhere.
 */
export const shape = {
  none: 0,
  extraSmall: 4,
  small: 8,
  medium: 12,
  large: 16,
  extraLarge: 28,
  /** Pill. M3 buttons are fully rounded. */
  full: 999,
} as const;

/**
 * Motion tokens.
 *
 * "Emphasized" is M3's signature curve: it decelerates hard at the end, which
 * makes movement feel like it has weight instead of sliding to a stop.
 */
export const motion = {
  easing: {
    emphasized: 'cubic-bezier(0.2, 0, 0, 1)',
    emphasizedDecelerate: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
    emphasizedAccelerate: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
  },
  duration: {
    short: 150,
    medium: 250,
    long: 400,
    extraLong: 550,
  },
} as const;

/**
 * State-layer opacities.
 *
 * M3 expresses interaction by overlaying the content colour at a set opacity
 * rather than by swapping in a different colour, so every component responds
 * consistently without per-component colour decisions.
 */
export const stateLayer = {
  hover: 0.08,
  focus: 0.1,
  pressed: 0.1,
  dragged: 0.16,
  disabledContent: 0.38,
  disabledContainer: 0.12,
} as const;

/**
 * Type scale.
 *
 * M3's five roles each in three sizes. Line heights are generous because this is
 * read on a phone, one-handed, during a game.
 */
export const typeScale = {
  displayLarge: { fontSize: '3.5rem', lineHeight: 1.14, letterSpacing: '-0.02em', fontWeight: 400 },
  displayMedium: {
    fontSize: '2.8rem',
    lineHeight: 1.16,
    letterSpacing: '-0.015em',
    fontWeight: 400,
  },
  displaySmall: {
    fontSize: '2.25rem',
    lineHeight: 1.22,
    letterSpacing: '-0.01em',
    fontWeight: 400,
  },

  headlineLarge: { fontSize: '2rem', lineHeight: 1.25, letterSpacing: '-0.01em', fontWeight: 500 },
  headlineMedium: {
    fontSize: '1.75rem',
    lineHeight: 1.29,
    letterSpacing: '-0.005em',
    fontWeight: 500,
  },
  headlineSmall: { fontSize: '1.5rem', lineHeight: 1.33, letterSpacing: '0em', fontWeight: 500 },

  titleLarge: { fontSize: '1.375rem', lineHeight: 1.27, letterSpacing: '0em', fontWeight: 500 },
  titleMedium: { fontSize: '1rem', lineHeight: 1.5, letterSpacing: '0.009em', fontWeight: 600 },
  titleSmall: { fontSize: '0.875rem', lineHeight: 1.43, letterSpacing: '0.007em', fontWeight: 600 },

  bodyLarge: { fontSize: '1rem', lineHeight: 1.5, letterSpacing: '0.031em', fontWeight: 400 },
  bodyMedium: { fontSize: '0.875rem', lineHeight: 1.43, letterSpacing: '0.018em', fontWeight: 400 },
  bodySmall: { fontSize: '0.75rem', lineHeight: 1.33, letterSpacing: '0.033em', fontWeight: 400 },

  labelLarge: { fontSize: '0.875rem', lineHeight: 1.43, letterSpacing: '0.007em', fontWeight: 600 },
  labelMedium: { fontSize: '0.75rem', lineHeight: 1.33, letterSpacing: '0.042em', fontWeight: 600 },
  labelSmall: {
    fontSize: '0.6875rem',
    lineHeight: 1.45,
    letterSpacing: '0.045em',
    fontWeight: 600,
  },
} as const;

/**
 * Colour roles for one scheme.
 *
 * This is the M3 role set. Components reference roles, never raw tones, so the
 * scheme can change without touching a component.
 */
export interface ColorRoles {
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;

  secondary: string;
  onSecondary: string;
  secondaryContainer: string;
  onSecondaryContainer: string;

  tertiary: string;
  onTertiary: string;
  tertiaryContainer: string;
  onTertiaryContainer: string;

  error: string;
  onError: string;
  errorContainer: string;
  onErrorContainer: string;

  warning: string;
  onWarning: string;
  warningContainer: string;
  onWarningContainer: string;

  success: string;
  onSuccess: string;
  successContainer: string;
  onSuccessContainer: string;

  background: string;
  onBackground: string;

  surface: string;
  onSurface: string;
  surfaceVariant: string;
  onSurfaceVariant: string;

  /** The five container tones that replace elevation shadows. */
  surfaceContainerLowest: string;
  surfaceContainerLow: string;
  surfaceContainer: string;
  surfaceContainerHigh: string;
  surfaceContainerHighest: string;

  outline: string;
  outlineVariant: string;

  inverseSurface: string;
  inverseOnSurface: string;
}

export const lightScheme: ColorRoles = {
  primary: tonal.primary[40],
  onPrimary: tonal.primary[100],
  primaryContainer: tonal.primary[90],
  onPrimaryContainer: tonal.primary[10],

  secondary: tonal.secondary[40],
  onSecondary: tonal.neutral[100],
  secondaryContainer: tonal.secondary[90],
  onSecondaryContainer: tonal.secondary[10],

  tertiary: tonal.tertiary[40],
  onTertiary: tonal.neutral[100],
  tertiaryContainer: tonal.tertiary[90],
  onTertiaryContainer: tonal.tertiary[10],

  error: tonal.error[40],
  onError: tonal.neutral[100],
  errorContainer: tonal.error[90],
  onErrorContainer: tonal.error[10],

  warning: status.warning[40],
  onWarning: tonal.neutral[100],
  warningContainer: status.warning[90],
  onWarningContainer: status.warning[10],

  success: status.success[40],
  onSuccess: tonal.neutral[100],
  successContainer: status.success[90],
  onSuccessContainer: status.success[10],

  background: tonal.neutral[98],
  onBackground: tonal.neutral[10],

  surface: tonal.neutral[98],
  onSurface: tonal.neutral[10],
  surfaceVariant: tonal.neutralVariant[90],
  onSurfaceVariant: tonal.neutralVariant[30],

  surfaceContainerLowest: tonal.neutral[100],
  surfaceContainerLow: tonal.neutral[96],
  surfaceContainer: tonal.neutral[94],
  surfaceContainerHigh: tonal.neutral[92],
  surfaceContainerHighest: tonal.neutral[90],

  outline: tonal.neutralVariant[50],
  outlineVariant: tonal.neutralVariant[80],

  inverseSurface: tonal.neutral[20],
  inverseOnSurface: tonal.neutral[94],
};

export const darkScheme: ColorRoles = {
  // Dark mode uses lighter tones for colour roles and darker ones for surfaces —
  // a true tonal dark theme, not an inverted light one.
  primary: tonal.primary[80],
  onPrimary: tonal.primary[20],
  primaryContainer: tonal.primary[30],
  onPrimaryContainer: tonal.primary[90],

  secondary: tonal.secondary[80],
  onSecondary: tonal.secondary[20],
  secondaryContainer: tonal.secondary[30],
  onSecondaryContainer: tonal.secondary[90],

  tertiary: tonal.tertiary[80],
  onTertiary: tonal.tertiary[20],
  tertiaryContainer: tonal.tertiary[30],
  onTertiaryContainer: tonal.tertiary[90],

  error: tonal.error[80],
  onError: tonal.error[20],
  errorContainer: tonal.error[30],
  onErrorContainer: tonal.error[90],

  warning: status.warning[80],
  onWarning: status.warning[20],
  warningContainer: status.warning[30],
  onWarningContainer: status.warning[90],

  success: status.success[80],
  onSuccess: status.success[20],
  successContainer: status.success[30],
  onSuccessContainer: status.success[90],

  background: tonal.neutral[6],
  onBackground: tonal.neutral[90],

  surface: tonal.neutral[6],
  onSurface: tonal.neutral[90],
  surfaceVariant: tonal.neutralVariant[30],
  onSurfaceVariant: tonal.neutralVariant[80],

  surfaceContainerLowest: tonal.neutral[4],
  surfaceContainerLow: tonal.neutral[10],
  surfaceContainer: tonal.neutral[12],
  surfaceContainerHigh: tonal.neutral[17],
  surfaceContainerHighest: tonal.neutral[22],

  outline: tonal.neutralVariant[60],
  outlineVariant: tonal.neutralVariant[30],

  inverseSurface: tonal.neutral[90],
  inverseOnSurface: tonal.neutral[20],
};

/** Breakpoint at which the navigation rail replaces the bottom bar. */
export const RAIL_BREAKPOINT = 900;
export const RAIL_WIDTH = 88;
