import { Box, Card, CardContent, Chip, Skeleton, Stack, Typography } from '@mui/material';
import SwapHorizIcon from '@mui/icons-material/SwapHorizRounded';
import AddIcon from '@mui/icons-material/AddRounded';
import RemoveIcon from '@mui/icons-material/RemoveRounded';
import { useConnection, useTransactions } from '../hooks.js';
import type { TransactionPlayer } from '../api/client.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { EmptyState, PageHeader, RelativeTime } from '../components/primitives.js';

/**
 * Recent league activity: adds, drops, trades, waiver claims.
 *
 * Read-only, and deliberately so. Yahoo publishes no API for making a transaction,
 * so this page reports what happened and offers no button that would pretend
 * otherwise.
 */
export function TransactionsPage(): JSX.Element {
  const connection = useConnection();
  const connected = connection.data?.connected ?? false;
  const transactions = useTransactions(connected);

  if (!connected) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Transactions" />
        <EmptyState
          icon={<SwapHorizIcon />}
          title="Connect Yahoo to see league activity"
          description="Adds, drops and trades are read live from Yahoo each time you open this page."
        />
      </Stack>
    );
  }

  if (transactions.isLoading) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Transactions" />
        <Stack spacing={1}>
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} height={92} sx={{ borderRadius: 4 }} />
          ))}
        </Stack>
      </Stack>
    );
  }

  if (transactions.isError) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Transactions" />
        <ErrorNotice error={transactions.error} onRetry={() => void transactions.refetch()} />
      </Stack>
    );
  }

  const rows = transactions.data?.transactions ?? [];

  if (rows.length === 0) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Transactions" />
        <EmptyState
          icon={<SwapHorizIcon />}
          title="No transactions yet"
          description="Yahoo reports no roster moves in this league — usually because the season has not started."
        />
      </Stack>
    );
  }

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Transactions"
        description={`${transactions.data?.seasonYear} season`}
        action={<Chip label={`${rows.length} recent`} />}
      />

      <Stack spacing={1}>
        {rows.map((transaction) => (
          <Card
            key={transaction.transactionKey}
            sx={{
              ...(transaction.involvesYou
                ? { borderColor: 'primary.main', bgcolor: 'background.surfaceContainerHigh' }
                : {}),
            }}
          >
            <CardContent sx={{ py: 1.75 }}>
              <Stack spacing={1.25}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Chip
                    size="small"
                    label={transaction.type}
                    color={transaction.type === 'trade' ? 'secondary' : 'default'}
                  />
                  {transaction.involvesYou && (
                    <Chip size="small" color="primary" label="your team" />
                  )}
                  <Box sx={{ flexGrow: 1 }} />
                  {transaction.occurredAt && (
                    <Typography variant="caption" color="text.secondary">
                      <RelativeTime value={transaction.occurredAt} underline={false} />
                    </Typography>
                  )}
                </Stack>

                <Stack spacing={0.75}>
                  {transaction.players.map((player, index) => (
                    <PlayerMove key={`${player.name}-${index}`} player={player} />
                  ))}
                </Stack>
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Stack>

      <Typography variant="caption" color="text.secondary">
        Read live from Yahoo <RelativeTime value={transactions.data?.fetchedAt} underline={false} />
        . Transactions are not stored. The portal cannot make a roster move — Yahoo publishes no API
        for that, so moves happen in Yahoo.
      </Typography>
    </Stack>
  );
}

function PlayerMove({ player }: { player: TransactionPlayer }): JSX.Element {
  const added = player.movement === 'add';
  const dropped = player.movement === 'drop';

  return (
    <Stack direction="row" spacing={1.25} alignItems="center">
      <Box
        sx={{
          width: 24,
          height: 24,
          flexShrink: 0,
          display: 'grid',
          placeItems: 'center',
          borderRadius: 999,
          bgcolor: added
            ? 'success.main'
            : dropped
              ? 'background.surfaceContainerHighest'
              : 'secondary.main',
          /**
           * `contrastText`, not `common.white`.
           *
           * In dark mode both tonal palettes invert to light surfaces, so a
           * hard-coded white glyph nearly vanished on the tan trade badge.
           */
          color: added
            ? 'success.contrastText'
            : dropped
              ? 'text.secondary'
              : 'secondary.contrastText',
          '& svg': { fontSize: 16 },
        }}
      >
        {added ? <AddIcon /> : dropped ? <RemoveIcon /> : <SwapHorizIcon />}
      </Box>

      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
          {player.name}
          {player.position && (
            <Typography component="span" variant="caption" color="text.secondary">
              {' '}
              {player.position}
              {player.nflTeam ? ` · ${player.nflTeam}` : ''}
            </Typography>
          )}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap display="block">
          {describeMove(player)}
        </Typography>
      </Box>
    </Stack>
  );
}

/**
 * Turns Yahoo's `source_type`/`destination_type` pair into a readable line.
 *
 * Yahoo's vocabulary is `team`, `waivers`, `freeagents`. Team names come from a
 * separate teams read; when a name is missing the endpoint label is used rather
 * than a bare team key, which would mean nothing to a reader.
 */
function describeMove(player: TransactionPlayer): string {
  const from = endpointLabel(player.source, player.sourceTeamName);
  const to = endpointLabel(player.destination, player.destinationTeamName);

  if (from && to) return `${from} → ${to}`;
  if (to) return `to ${to}`;
  if (from) return `from ${from}`;
  return '—';
}

function endpointLabel(kind: string | null, teamName: string | null): string | null {
  if (teamName) return teamName;
  switch (kind) {
    case 'waivers':
      return 'waivers';
    case 'freeagents':
      return 'free agency';
    case 'team':
      // A team endpoint with no resolvable name: better vague than a raw key.
      return 'a team';
    default:
      return null;
  }
}
