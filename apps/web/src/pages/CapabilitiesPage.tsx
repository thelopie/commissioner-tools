import {
  Alert,
  AlertTitle,
  Box,
  Card,
  CardContent,
  Chip,
  Divider,
  Link,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid2';
import ShieldIcon from '@mui/icons-material/ShieldRounded';
import TimerIcon from '@mui/icons-material/TimerRounded';
import EditOffIcon from '@mui/icons-material/EditOffRounded';
import { useCapabilities } from '../hooks.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { PageHeader, SectionHeader } from '../components/primitives.js';

/**
 * What the portal can and cannot read from Yahoo.
 *
 * Surfaced in the UI rather than buried in a file, because "why is this challenge
 * blocked?" is a question a commissioner will ask, and the honest answer is a
 * specific unverified capability — not a bug.
 *
 * Presented as cards rather than a table. The limitations are the substance here
 * and they are paragraphs, which a table squeezes into unreadable columns on a
 * phone.
 */
export function CapabilitiesPage(): JSX.Element {
  const capabilities = useCapabilities();

  if (capabilities.isLoading) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Yahoo status" />
        <Grid container spacing={2}>
          {Array.from({ length: 3 }, (_, index) => (
            <Grid size={{ xs: 12, md: 4 }} key={index}>
              <Skeleton height={140} sx={{ borderRadius: 4 }} />
            </Grid>
          ))}
        </Grid>
        <Stack spacing={1.5}>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} height={132} sx={{ borderRadius: 4 }} />
          ))}
        </Stack>
      </Stack>
    );
  }

  if (capabilities.isError) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Yahoo status" />
        <ErrorNotice error={capabilities.error} onRetry={() => void capabilities.refetch()} />
      </Stack>
    );
  }

  const data = capabilities.data;
  if (!data) return <Alert severity="info">No capability information available.</Alert>;

  const verified = data.resources.filter((resource) => resource.testStatus === 'verified').length;

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Yahoo status"
        description={`Reviewed ${data.lastReviewedAt}. This list is not documentation — the portal reads it at runtime and refuses to calculate anything that depends on an unverified capability.`}
        action={
          <Chip
            color={verified > 0 ? 'success' : 'warning'}
            label={`${verified} of ${data.resources.length} verified`}
          />
        }
      />

      {data.verifiedCapabilities.length === 0 && (
        <Alert severity="warning">
          <AlertTitle>Nothing verified against a real league yet</AlertTitle>
          <Typography variant="body2">
            Every weekly challenge therefore reports blocked. That is the intended state until Yahoo
            grants API access and the verification script confirms which fields actually exist.
          </Typography>
        </Alert>
      )}

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 4 }}>
          <FactCard
            icon={<ShieldIcon />}
            title="Access"
            lines={[
              data.access.approvalRequired
                ? 'Yahoo reviews every application before issuing credentials.'
                : 'Self-service credentials.',
              `Default permission: ${data.access.defaultPermission}.`,
            ]}
            footer={
              <Link href={data.access.applicationUrl} target="_blank" rel="noreferrer">
                Apply for access
              </Link>
            }
          />
        </Grid>

        <Grid size={{ xs: 12, md: 4 }}>
          <FactCard
            icon={<EditOffIcon />}
            title="Writes"
            tone={data.writeOperationsSupported ? 'default' : 'success'}
            lines={[
              data.writeOperationsSupported
                ? 'Write operations are documented.'
                : 'No write operation appears in Yahoo’s current documentation.',
              'The portal makes no changes in Yahoo at all — including draft order, which is entered by hand.',
            ]}
          />
        </Grid>

        <Grid size={{ xs: 12, md: 4 }}>
          <FactCard
            icon={<TimerIcon />}
            title="Retention"
            lines={[
              `Yahoo data must be removed within ${data.retention.maxRetentionHours} hours unless explicitly storable indefinitely.`,
              `Only these are: ${data.retention.storableIndefinitely.join(', ')}.`,
            ]}
            footer={
              <Typography variant="caption" color="text.secondary">
                So scores, rosters, and names are fetched live and cached for minutes. The one
                durable name is the display name each person confirms in their own profile.
              </Typography>
            }
          />
        </Grid>
      </Grid>

      <Box>
        <SectionHeader title="Resources" count={data.resources.length} />
        <Stack spacing={1.5}>
          {data.resources.map((resource) => (
            <Card key={resource.key}>
              <CardContent>
                <Stack spacing={1.5}>
                  <Stack
                    direction="row"
                    spacing={1}
                    alignItems="flex-start"
                    flexWrap="wrap"
                    useFlexGap
                  >
                    <Typography variant="h3" sx={{ flexGrow: 1, minWidth: 0 }}>
                      {resource.feature}
                    </Typography>
                    <Stack direction="row" spacing={0.75}>
                      <Tooltip title={confidenceHint(resource.confidence)}>
                        <Chip size="small" {...confidenceChip(resource.confidence)} />
                      </Tooltip>
                      <Tooltip title={testStatusHint(resource.testStatus)}>
                        <Chip size="small" {...testStatusChip(resource.testStatus)} />
                      </Tooltip>
                    </Stack>
                  </Stack>

                  <Box
                    sx={{
                      px: 1.25,
                      py: 0.75,
                      borderRadius: 2,
                      bgcolor: 'background.surfaceContainerHighest',
                      overflowX: 'auto',
                    }}
                  >
                    <Typography
                      variant="caption"
                      sx={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}
                    >
                      {resource.method} {resource.resource}
                    </Typography>
                  </Box>

                  {resource.limitations.length > 0 && (
                    <>
                      <Divider />
                      <Stack spacing={0.75} component="ul" sx={{ m: 0, pl: 2.5 }}>
                        {resource.limitations.map((limitation) => (
                          <Typography
                            component="li"
                            variant="body2"
                            color="text.secondary"
                            key={limitation}
                          >
                            {limitation}
                          </Typography>
                        ))}
                      </Stack>
                    </>
                  )}
                </Stack>
              </CardContent>
            </Card>
          ))}
        </Stack>
      </Box>
    </Stack>
  );
}

function FactCard({
  icon,
  title,
  lines,
  footer,
  tone = 'default',
}: {
  icon: React.ReactNode;
  title: string;
  lines: string[];
  footer?: React.ReactNode;
  tone?: 'default' | 'success';
}): JSX.Element {
  return (
    <Card variant="filled" sx={{ height: '100%' }}>
      <CardContent>
        <Stack spacing={1.5} sx={{ height: '100%' }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Box
              sx={{
                width: 36,
                height: 36,
                borderRadius: 999,
                display: 'grid',
                placeItems: 'center',
                bgcolor: 'background.surfaceContainerLowest',
                color: tone === 'success' ? 'success.main' : 'text.secondary',
                '& svg': { fontSize: 20 },
              }}
            >
              {icon}
            </Box>
            <Typography variant="h3">{title}</Typography>
          </Stack>

          {lines.map((line) => (
            <Typography variant="body2" color="text.secondary" key={line}>
              {line}
            </Typography>
          ))}

          {footer && <Box sx={{ mt: 'auto', pt: 0.5 }}>{footer}</Box>}
        </Stack>
      </CardContent>
    </Card>
  );
}

function confidenceChip(confidence: string): {
  label: string;
  color: 'success' | 'info' | 'warning' | 'default';
  variant?: 'outlined';
} {
  switch (confidence) {
    case 'documented':
      return { label: 'documented', color: 'success' };
    case 'documented-legacy':
      // Only in the archived copy of Yahoo's old guide, which is not official.
      return { label: 'archived docs', color: 'info' };
    case 'inferred':
      return { label: 'inferred', color: 'warning' };
    default:
      return { label: 'unknown', color: 'default', variant: 'outlined' };
  }
}

function confidenceHint(confidence: string): string {
  switch (confidence) {
    case 'documented':
      return 'Stated in current official Yahoo documentation.';
    case 'documented-legacy':
      return 'Only in the archived, unofficial mirror of Yahoo’s old guide.';
    case 'inferred':
      return 'Widely used by third-party clients, absent from current docs.';
    default:
      return 'No reliable source found.';
  }
}

function testStatusChip(status: string): {
  label: string;
  color: 'success' | 'info' | 'warning' | 'error' | 'default';
  variant?: 'outlined';
} {
  switch (status) {
    case 'verified':
      return { label: 'verified', color: 'success' };
    case 'mock-only':
      return { label: 'mock only', color: 'info', variant: 'outlined' };
    case 'failed':
      return { label: 'failed', color: 'error' };
    default:
      return { label: 'untested', color: 'warning', variant: 'outlined' };
  }
}

function testStatusHint(status: string): string {
  switch (status) {
    case 'verified':
      return 'Exercised successfully against a real Yahoo league.';
    case 'mock-only':
      return 'Exercised against local fixtures only.';
    case 'failed':
      return 'Exercised and did not behave as documented.';
    default:
      return 'Never exercised against a real Yahoo league.';
  }
}
