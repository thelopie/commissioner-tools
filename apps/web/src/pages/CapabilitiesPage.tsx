import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  Link,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useCapabilities } from '../hooks.js';
import { ErrorNotice } from '../components/ErrorNotice.js';

/**
 * What the portal can and cannot read from Yahoo.
 *
 * Surfaced in the UI rather than buried in a file, because "why is this challenge
 * blocked?" is a question a commissioner will ask, and the honest answer is a
 * specific unverified capability — not a bug.
 */
export function CapabilitiesPage(): JSX.Element {
  const capabilities = useCapabilities();

  if (capabilities.isLoading) return <Skeleton variant="rectangular" height={400} />;
  if (capabilities.isError) {
    return <ErrorNotice error={capabilities.error} onRetry={() => void capabilities.refetch()} />;
  }

  const data = capabilities.data;
  if (!data) return <Alert severity="info">No capability information available.</Alert>;

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h1">Yahoo status</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          Reviewed {data.lastReviewedAt}. This list is not documentation — the portal reads it at
          runtime and refuses to calculate anything that depends on an unverified capability.
        </Typography>
      </Box>

      {data.verifiedCapabilities.length === 0 && (
        <Alert severity="warning">
          <Typography variant="body2">
            No Yahoo capability has been verified against a real league yet, so every weekly
            challenge reports blocked. That is the intended state until Yahoo grants API access and
            the verification script confirms which fields actually exist.
          </Typography>
        </Alert>
      )}

      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Typography variant="h3">Access and permissions</Typography>

            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Chip
                size="small"
                color={data.access.approvalRequired ? 'warning' : 'success'}
                label={data.access.approvalRequired ? 'Yahoo approval required' : 'Self-service'}
              />
              <Chip size="small" label={`default: ${data.access.defaultPermission}`} />
              <Chip
                size="small"
                color={data.writeOperationsSupported ? 'success' : 'default'}
                label={data.writeOperationsSupported ? 'writes documented' : 'no writes documented'}
              />
              <Chip
                size="small"
                color={data.commissionerActionsSupported ? 'success' : 'default'}
                label={
                  data.commissionerActionsSupported
                    ? 'commissioner actions documented'
                    : 'no commissioner actions'
                }
              />
            </Stack>

            <Typography variant="body2" color="text.secondary">
              Yahoo Fantasy API access is granted after Yahoo reviews an application at{' '}
              <Link href={data.access.applicationUrl} target="_blank" rel="noreferrer">
                {data.access.applicationUrl}
              </Link>
              . No write operation appears in Yahoo&rsquo;s current documentation, so the portal
              makes no changes in Yahoo at all — including draft order, which is entered by hand.
            </Typography>
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Typography variant="h3">Data retention</Typography>
            <Typography variant="body2" color="text.secondary">
              Yahoo&rsquo;s API terms require removing Yahoo data within{' '}
              <strong>{data.retention.maxRetentionHours} hours</strong> unless it is explicitly
              storable indefinitely. Only these are:{' '}
              <strong>{data.retention.storableIndefinitely.join(', ')}</strong>.
            </Typography>
            <Typography variant="body2" color="text.secondary">
              So the portal fetches scores, rosters, standings, and names live on every request and
              caches them for minutes, not days. The only durable name is the display name each
              person confirms in their own profile, which is portal data rather than Yahoo data.
            </Typography>
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="h3" sx={{ mb: 1.5 }}>
            Resources
          </Typography>

          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Feature</TableCell>
                  <TableCell>Resource</TableCell>
                  <TableCell>Confidence</TableCell>
                  <TableCell>Tested</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.resources.map((resource) => (
                  <TableRow key={resource.key} sx={{ verticalAlign: 'top' }}>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {resource.feature}
                      </Typography>
                      {resource.limitations.length > 0 && (
                        <Box component="ul" sx={{ m: 0.5, pl: 2, color: 'text.secondary' }}>
                          {resource.limitations.map((limitation) => (
                            <Typography component="li" variant="caption" key={limitation}>
                              {limitation}
                            </Typography>
                          ))}
                        </Box>
                      )}
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="caption"
                        sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
                      >
                        {resource.method} {resource.resource}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip size="small" {...confidenceChip(resource.confidence)} />
                    </TableCell>
                    <TableCell>
                      <Chip size="small" {...testStatusChip(resource.testStatus)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
    </Stack>
  );
}

function confidenceChip(confidence: string): {
  label: string;
  color: 'success' | 'info' | 'warning' | 'default';
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
      return { label: 'unknown', color: 'default' };
  }
}

function testStatusChip(status: string): {
  label: string;
  color: 'success' | 'info' | 'warning' | 'error' | 'default';
} {
  switch (status) {
    case 'verified':
      return { label: 'verified', color: 'success' };
    case 'mock-only':
      return { label: 'mock only', color: 'info' };
    case 'failed':
      return { label: 'failed', color: 'error' };
    default:
      return { label: 'untested', color: 'warning' };
  }
}
