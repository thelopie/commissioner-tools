import { Alert, AlertTitle, Box, Button, Stack, Typography } from '@mui/material';
import { ApiError } from '../api/client.js';

/**
 * Error presentation.
 *
 * Branches on the backend's stable error code rather than on message text, and
 * always offers the specific next step: reconnect Yahoo, ask a commissioner, or
 * retry. "Something went wrong" tells a commissioner nothing they can act on.
 */

export interface ErrorNoticeProps {
  error: unknown;
  onRetry?: () => void;
  /** Suppresses the retry button where retrying makes no sense. */
  hideRetry?: boolean;
}

export function ErrorNotice({ error, onRetry, hideRetry }: ErrorNoticeProps): JSX.Element {
  const details = describe(error);

  const action =
    details.action === 'reconnect' ? (
      <Button size="small" variant="contained" href="/auth/yahoo/start">
        Reconnect
      </Button>
    ) : details.action === 'signin' ? (
      <Button size="small" variant="contained" href="/auth/yahoo/start">
        Sign in
      </Button>
    ) : details.action === 'retry' && onRetry && !hideRetry ? (
      <Button size="small" variant="tonal" onClick={onRetry}>
        Try again
      </Button>
    ) : undefined;

  return (
    <Alert severity={details.severity} {...(action ? { action } : {})}>
      <AlertTitle>{details.title}</AlertTitle>
      <Stack spacing={1}>
        <Typography variant="body2">{details.message}</Typography>

        {details.hint && (
          <Typography variant="caption" sx={{ opacity: 0.85 }}>
            {details.hint}
          </Typography>
        )}

        {details.fieldErrors.length > 0 && (
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {details.fieldErrors.map((fieldError) => (
              <Typography
                component="li"
                variant="body2"
                key={`${fieldError.field}:${fieldError.message}`}
              >
                <strong>{fieldError.field}</strong> {fieldError.message}
              </Typography>
            ))}
          </Box>
        )}
      </Stack>
    </Alert>
  );
}

interface Described {
  title: string;
  message: string;
  hint?: string;
  severity: 'error' | 'warning' | 'info';
  action: 'reconnect' | 'signin' | 'retry' | 'none';
  fieldErrors: Array<{ field: string; message: string }>;
}

function describe(error: unknown): Described {
  if (!(error instanceof ApiError)) {
    return {
      title: 'Unexpected problem',
      message: error instanceof Error ? error.message : 'Something failed unexpectedly.',
      severity: 'error',
      action: 'retry',
      fieldErrors: [],
    };
  }

  const base = { fieldErrors: error.fieldErrors };

  switch (error.code) {
    case 'network_error':
      return {
        ...base,
        title: 'Cannot reach the portal',
        message: error.message,
        hint: 'If you are running locally, check that the API is started.',
        severity: 'warning',
        action: 'retry',
      };

    case 'unauthenticated':
    case 'session_expired':
      return {
        ...base,
        title: 'Sign in required',
        message: error.message,
        severity: 'info',
        action: 'signin',
      };

    case 'yahoo_not_connected':
    case 'yahoo_needs_reconnect':
      return {
        ...base,
        title: 'Yahoo connection needed',
        message: error.message,
        hint: 'Your Yahoo access is read-only and can be removed again at any time.',
        severity: 'warning',
        action: 'reconnect',
      };

    case 'commissioner_required':
    case 'forbidden':
      return {
        ...base,
        title: 'Not permitted',
        message: error.message,
        hint: 'Portal roles are set in the portal, separately from Yahoo. Ask a commissioner for access.',
        severity: 'info',
        action: 'none',
      };

    case 'yahoo_rate_limited':
      return {
        ...base,
        title: 'Yahoo is rate limiting',
        message: error.message,
        hint: 'The portal backs off automatically. Waiting a moment is usually enough.',
        severity: 'warning',
        action: 'retry',
      };

    case 'yahoo_unavailable':
      return {
        ...base,
        title: 'Yahoo is not responding',
        message: error.message,
        severity: 'warning',
        action: 'retry',
      };

    case 'yahoo_capability_unverified':
    case 'challenge_blocked':
      return {
        ...base,
        title: 'Blocked pending Yahoo verification',
        message: error.message,
        hint:
          'The portal will not calculate a result from data it has not confirmed Yahoo provides. ' +
          'See Yahoo status for what is still unverified.',
        severity: 'info',
        action: 'none',
      };

    case 'yahoo_league_not_linked':
      return {
        ...base,
        title: 'No Yahoo league linked',
        message: error.message,
        severity: 'info',
        action: 'none',
      };

    case 'settled_payout_protected':
      return {
        ...base,
        title: 'This result has already been paid',
        message: error.message,
        hint: 'Changing a paid result requires an explicit override with a recorded reason.',
        severity: 'warning',
        action: 'none',
      };

    case 'version_conflict':
      return {
        ...base,
        title: 'Someone else changed this',
        message: error.message,
        severity: 'warning',
        action: 'retry',
      };

    case 'validation_failed':
      return {
        ...base,
        title: 'Check these fields',
        message: error.message,
        severity: 'info',
        action: 'none',
      };

    default:
      return {
        ...base,
        title: error.status >= 500 ? 'Server problem' : 'Request failed',
        message: error.message,
        severity: 'error',
        action: error.isTransient ? 'retry' : 'none',
      };
  }
}
