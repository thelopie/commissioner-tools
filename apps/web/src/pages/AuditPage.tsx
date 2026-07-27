import { Alert, Box, Card, CardContent, Chip, Skeleton, Stack, Typography } from '@mui/material';
import { useAudit } from '../hooks.js';
import { ErrorNotice } from '../components/ErrorNotice.js';

/**
 * Privileged audit history.
 *
 * Append-only and commissioner-only. This is how a future commissioner
 * reconstructs why the league looks the way it does — who granted whom access, who
 * overrode a result, which draw seed produced this year's draft order.
 */
export function AuditPage(): JSX.Element {
  const audit = useAudit(true);

  if (audit.isLoading) return <Skeleton variant="rectangular" height={400} />;
  if (audit.isError)
    return <ErrorNotice error={audit.error} onRetry={() => void audit.refetch()} />;

  const entries = audit.data?.entries ?? [];

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h1">Audit history</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          Every privileged action, most recent first. Records are append-only — nothing in the
          portal edits or deletes them.
        </Typography>
      </Box>

      {entries.length === 0 && <Alert severity="info">No audit records yet.</Alert>}

      <Stack spacing={1}>
        {entries.map((entry) => (
          <Card key={entry.auditLogId}>
            <CardContent sx={{ py: 1.5 }}>
              <Stack spacing={0.5}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Chip size="small" label={entry.action} color={actionColor(entry.action)} />
                  <Chip size="small" variant="outlined" label={entry.actorRole} />
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
                    {formatTimestamp(entry.at)}
                  </Typography>
                </Stack>

                <Typography variant="body2">{entry.summary}</Typography>

                {entry.targetEntity && (
                  <Typography variant="caption" color="text.secondary">
                    {entry.targetEntity}
                    {entry.targetId ? ` · ${entry.targetId}` : ''}
                  </Typography>
                )}
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Stack>
    </Stack>
  );
}

/** Highlights the actions that most warrant a second look. */
function actionColor(action: string): 'default' | 'warning' | 'error' | 'info' {
  if (action.includes('overridden') || action.includes('blocked')) return 'warning';
  if (action.includes('revoked') || action.includes('deleted') || action.includes('rolled_back')) {
    return 'error';
  }
  if (action.startsWith('commissioner.') || action.includes('settled')) return 'info';
  return 'default';
}

function formatTimestamp(value: string): string {
  const date = new Date(value.endsWith('Z') ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
