import { Box, Card, CardContent, Chip, Skeleton, Stack, Typography } from '@mui/material';
import HistoryIcon from '@mui/icons-material/HistoryRounded';
import { useAudit } from '../hooks.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { EmptyState, PageHeader, RelativeTime } from '../components/primitives.js';

/**
 * Privileged audit history.
 *
 * Append-only and commissioner-only. This is how a future commissioner
 * reconstructs why the league looks the way it does — who granted whom access, who
 * overrode a result, which draw seed produced this year's draft order.
 *
 * Rendered as a timeline: these are events in sequence, and a table would lose the
 * ordering that gives them meaning.
 */
export function AuditPage(): JSX.Element {
  const audit = useAudit(true);

  if (audit.isLoading) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Audit history" />
        <Stack spacing={1}>
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} height={84} sx={{ borderRadius: 4 }} />
          ))}
        </Stack>
      </Stack>
    );
  }

  if (audit.isError) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Audit history" />
        <ErrorNotice error={audit.error} onRetry={() => void audit.refetch()} />
      </Stack>
    );
  }

  const entries = audit.data?.entries ?? [];

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Audit history"
        description="Every privileged action, most recent first. Records are append-only — nothing in the portal edits or deletes them."
        action={<Chip label={`${entries.length} records`} />}
      />

      {entries.length === 0 ? (
        <EmptyState
          icon={<HistoryIcon />}
          title="Nothing recorded yet"
          description="Privileged actions — granting access, linking a league, finalizing a result, committing an import — appear here as they happen."
        />
      ) : (
        <Box
          sx={{
            position: 'relative',
            // The spine of the timeline. Behind the markers, so events read as
            // points on a sequence rather than as a list of cards.
            '&::before': {
              content: '""',
              position: 'absolute',
              left: 19,
              top: 12,
              bottom: 12,
              width: 2,
              bgcolor: 'divider',
              display: { xs: 'none', sm: 'block' },
            },
          }}
        >
          <Stack spacing={1.5}>
            {entries.map((entry) => (
              <Stack key={entry.auditLogId} direction="row" spacing={2} alignItems="flex-start">
                <Box
                  sx={{
                    display: { xs: 'none', sm: 'grid' },
                    placeItems: 'center',
                    flexShrink: 0,
                    width: 40,
                    height: 40,
                    borderRadius: 999,
                    bgcolor: 'background.default',
                    border: 2,
                    borderColor: markerColor(entry.action),
                    color: markerColor(entry.action),
                    zIndex: 1,
                    mt: 0.5,
                  }}
                >
                  <Box sx={{ width: 10, height: 10, borderRadius: 999, bgcolor: 'currentColor' }} />
                </Box>

                <Card sx={{ flexGrow: 1, minWidth: 0 }}>
                  <CardContent sx={{ py: 1.75 }}>
                    <Stack spacing={0.75}>
                      <Stack
                        direction="row"
                        spacing={1}
                        alignItems="center"
                        flexWrap="wrap"
                        useFlexGap
                      >
                        <Chip size="small" label={entry.action} color={actionColor(entry.action)} />
                        <Chip size="small" variant="outlined" label={entry.actorRole} />
                        <Box sx={{ flexGrow: 1 }} />
                        <Typography variant="caption" color="text.secondary">
                          <RelativeTime value={entry.at} />
                        </Typography>
                      </Stack>

                      <Typography variant="body2">{entry.summary}</Typography>

                      {entry.targetEntity && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
                        >
                          {entry.targetEntity}
                          {entry.targetId ? ` · ${entry.targetId}` : ''}
                        </Typography>
                      )}
                    </Stack>
                  </CardContent>
                </Card>
              </Stack>
            ))}
          </Stack>
        </Box>
      )}
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

function markerColor(action: string): string {
  const tone = actionColor(action);
  if (tone === 'warning') return 'warning.main';
  if (tone === 'error') return 'error.main';
  if (tone === 'info') return 'info.main';
  return 'divider';
}
