import { Avatar, Box, Card, CardContent, Stack, Tooltip, Typography, alpha } from '@mui/material';
import { useTheme } from '@mui/material/styles';

/**
 * Small building blocks used across pages.
 *
 * Each exists because the same pattern appeared three or more times, and having
 * one implementation is what keeps spacing, tone, and wording consistent between
 * screens.
 */

/**
 * A page heading with optional supporting text and trailing actions.
 *
 * `id="page-title"` on the heading is the focus target after a route change, so
 * keyboard and screen-reader users land on the new page's title rather than
 * staying wherever the previous page left them.
 */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}): JSX.Element {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={2}
      alignItems={{ sm: 'flex-start' }}
      justifyContent="space-between"
      sx={{ mb: 1 }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h1" id="page-title" tabIndex={-1} sx={{ outline: 'none' }}>
          {title}
        </Typography>
        {description && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, maxWidth: '68ch' }}>
            {description}
          </Typography>
        )}
      </Box>
      {action && <Box sx={{ flexShrink: 0 }}>{action}</Box>}
    </Stack>
  );
}

/** A titled section within a page. */
export function SectionHeader({
  title,
  count,
  action,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
}): JSX.Element {
  return (
    <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 1.5 }}>
      <Typography variant="h2">{title}</Typography>
      {count !== undefined && (
        <Box
          sx={{
            px: 1,
            minWidth: 26,
            textAlign: 'center',
            borderRadius: 999,
            bgcolor: 'background.surfaceContainerHighest',
            color: 'text.secondary',
            typography: 'labelMedium',
            fontSize: '0.75rem',
            fontWeight: 700,
            lineHeight: '22px',
          }}
        >
          {count}
        </Box>
      )}
      <Box sx={{ flexGrow: 1 }} />
      {action}
    </Stack>
  );
}

/**
 * Empty state.
 *
 * Always paired with exactly one action. An empty state that only explains the
 * emptiness leaves the person to work out what to do next, which is the mistake
 * the original challenges page made.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}): JSX.Element {
  return (
    <Card variant="filled">
      <CardContent>
        <Stack spacing={2} alignItems="center" sx={{ textAlign: 'center', py: { xs: 3, sm: 5 } }}>
          <Box
            sx={{
              width: 64,
              height: 64,
              borderRadius: 999,
              display: 'grid',
              placeItems: 'center',
              bgcolor: 'background.surfaceContainerLowest',
              color: 'text.secondary',
              '& svg': { fontSize: 30 },
            }}
          >
            {icon}
          </Box>
          <Typography variant="h3">{title}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: '46ch' }}>
            {description}
          </Typography>
          {action}
        </Stack>
      </CardContent>
    </Card>
  );
}

/**
 * A labelled value, for status grids.
 *
 * The label is deliberately smaller and quieter than the value: someone scanning
 * for "when did this last work" should find the timestamp first.
 */
export function DataPoint({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'default' | 'muted' | 'warning';
}): JSX.Element {
  const body = (
    <Box sx={{ minWidth: 0 }}>
      <Typography
        variant="caption"
        sx={{
          color: 'text.secondary',
          display: 'block',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontWeight: 600,
          fontSize: '0.6875rem',
        }}
      >
        {label}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          mt: 0.25,
          fontWeight: 500,
          color:
            tone === 'muted'
              ? 'text.secondary'
              : tone === 'warning'
                ? 'warning.main'
                : 'text.primary',
          wordBreak: 'break-word',
        }}
      >
        {value}
      </Typography>
    </Box>
  );

  return hint ? <Tooltip title={hint}>{body}</Tooltip> : body;
}

/**
 * Monogram avatar with a colour derived from the name.
 *
 * Deterministic hashing rather than random assignment, so a team keeps the same
 * colour across loads and becomes recognisable at a glance in a twelve-team grid.
 */
export function Monogram({ name, size = 40 }: { name: string; size?: number }): JSX.Element {
  const theme = useTheme();

  /**
   * The first LETTER of each word, not the first character.
   *
   * Filtering words that merely contain a letter still took `part[0]`, so
   * "Josh (commissioner)" rendered as "J(" — a punctuation mark inside an avatar.
   */
  const initials =
    name
      .split(/\s+/)
      .map((part) => /[a-z0-9]/i.exec(part)?.[0])
      .filter((letter): letter is string => letter !== undefined)
      .slice(0, 2)
      .map((letter) => letter.toUpperCase())
      .join('') || '?';

  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }

  // Spread across the hue wheel while holding saturation and lightness, so every
  // monogram has the same visual weight and none fights the primary colour.
  const hue = hash % 360;
  const isDark = theme.palette.mode === 'dark';
  const background = `hsl(${hue} 42% ${isDark ? 26 : 88}%)`;
  const foreground = `hsl(${hue} 58% ${isDark ? 84 : 24}%)`;

  return (
    <Avatar
      aria-hidden
      sx={{
        width: size,
        height: size,
        bgcolor: background,
        color: foreground,
        fontSize: size * 0.36,
        border: `1px solid ${alpha(foreground, 0.18)}`,
      }}
    >
      {initials}
    </Avatar>
  );
}

/**
 * A timestamp shown as elapsed time, with the exact value on hover.
 *
 * "2 min ago" answers the question people actually have about a status line;
 * the precise timestamp is still there when it matters.
 */
export function RelativeTime({
  value,
  fallback = 'Never',
  underline = true,
}: {
  value: string | null | undefined;
  fallback?: string;
  /** Off when the value sits inside a sentence, where an underline reads as an error. */
  underline?: boolean;
}): JSX.Element {
  if (!value) return <>{fallback}</>;

  // Stored timestamps are UTC without a zone suffix.
  const date = new Date(value.endsWith('Z') ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return <>{value}</>;

  return (
    <Tooltip title={date.toLocaleString()}>
      <Box
        component="span"
        sx={underline ? { borderBottom: '1px dotted', borderColor: 'divider' } : undefined}
      >
        {formatRelative(date)}
      </Box>
    </Tooltip>
  );
}

export function formatRelative(date: Date, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);

  if (seconds < 0) return 'just now';
  if (seconds < 45) return 'just now';
  if (seconds < 90) return '1 min ago';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? 'yesterday' : `${days} days ago`;

  const months = Math.round(days / 30);
  if (months < 12) return months === 1 ? '1 month ago' : `${months} months ago`;

  const years = Math.round(months / 12);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}
