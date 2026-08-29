import { Box, Button, Chip, Link, Stack, Tooltip, Typography } from '@mui/material';
import { useDues, useLeagueMembers, useSaveDues, useSeasons } from '../hooks.js';
import { useNotify } from './SnackbarProvider.js';

/**
 * Dues, shown against the table people already look at.
 *
 * Nobody opens a money page in September. Standings is the screen that gets read
 * every week, so a manager who owes money sees it there — and the commissioner can
 * settle it without going anywhere.
 *
 * Nothing here processes a payment. Somebody pays the commissioner the way they
 * always have, and the commissioner records that it happened.
 */

export interface TeamDues {
  leagueMemberId: string;
  displayName: string;
  duesRecordId?: string;
  owedCents: number;
  paidCents: number;
  status: string;
}

/**
 * Joins Yahoo teams to dues through the portal's own members.
 *
 * Standings rows are Yahoo's and carry no portal identity, so the join runs through
 * `yahooTeamKey` on the member — which is exactly what the mapping step exists to
 * establish.
 */
export function useDuesByTeam(seasonYear: number | null): {
  byTeamKey: Map<string, TeamDues>;
  buyInCents: number;
  ready: boolean;
} {
  const members = useLeagueMembers(seasonYear);
  const dues = useDues(seasonYear);
  const seasons = useSeasons();

  const season = seasons.data?.seasons.find((entry) => entry.seasonYear === seasonYear);
  const buyInCents = season?.buyIn?.amountCents ?? 0;

  const duesByMember = new Map((dues.data?.dues ?? []).map((record) => [record.leagueMemberId, record]));

  const byTeamKey = new Map<string, TeamDues>();

  for (const member of members.data?.members ?? []) {
    if (!member.yahooTeamKey) continue;

    const record = duesByMember.get(member.leagueMemberId);
    byTeamKey.set(member.yahooTeamKey, {
      leagueMemberId: member.leagueMemberId,
      displayName: member.displayName,
      ...(record ? { duesRecordId: record.duesRecordId } : {}),
      owedCents: record?.amountOwed.amountCents ?? buyInCents,
      paidCents: record?.amountPaid.amountCents ?? 0,
      status: record?.status ?? 'unpaid',
    });
  }

  return { byTeamKey, buyInCents, ready: members.isSuccess && dues.isSuccess };
}

const money = (cents: number): string => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

/**
 * One manager's dues, and for a commissioner a way to change them.
 *
 * Settling is a single deliberate click rather than a form: the amount is the
 * league's buy-in, and marking somebody paid should not require retyping it.
 */
export function DuesCell({
  seasonYear,
  dues,
  isCommissioner,
}: {
  seasonYear: number | null;
  dues: TeamDues | undefined;
  isCommissioner: boolean;
}): JSX.Element {
  const save = useSaveDues(seasonYear);
  const notify = useNotify();

  if (!dues) {
    return (
      <Tooltip title="This Yahoo team is not mapped to a league member yet.">
        <Typography variant="caption" color="text.disabled">
          —
        </Typography>
      </Tooltip>
    );
  }

  const settled = dues.status === 'paid' || dues.status === 'waived';
  const owes = Math.max(dues.owedCents - dues.paidCents, 0);

  const set = (paidCents: number, label: string): void => {
    save.mutate(
      {
        ...(dues.duesRecordId ? { duesRecordId: dues.duesRecordId } : {}),
        leagueMemberId: dues.leagueMemberId,
        // The buy-in stands in when no record exists yet, so settling somebody does
        // not mean filling in a form first.
        amountOwedCents: dues.owedCents,
        amountPaidCents: paidCents,
      },
      {
        onSuccess: () => notify(`${dues.displayName} marked ${label}.`, 'success'),
        onError: (error) => notify(error.message, 'error'),
      },
    );
  };

  const chip = (
    <Chip
      size="small"
      color={settled ? 'success' : owes > 0 ? 'warning' : 'default'}
      variant={settled ? 'filled' : 'outlined'}
      label={settled ? 'paid' : dues.owedCents === 0 ? 'no dues set' : money(owes)}
      onClick={
        isCommissioner && dues.owedCents > 0
          ? () => set(settled ? 0 : dues.owedCents, settled ? 'unpaid' : 'paid')
          : undefined
      }
      sx={isCommissioner && dues.owedCents > 0 ? { cursor: 'pointer' } : undefined}
    />
  );

  if (!isCommissioner) return chip;

  return (
    <Tooltip
      title={
        dues.owedCents === 0
          ? 'Set the season buy-in on the dues page first.'
          : settled
            ? 'Click to mark unpaid'
            : 'Click to mark paid'
      }
    >
      <Box component="span">{chip}</Box>
    </Tooltip>
  );
}

/**
 * Where to send the money.
 *
 * A link the commissioner sets, shown to everybody who owes. The portal takes no
 * part in the payment itself — this only answers "who do I pay, and how".
 */
export function PaymentLink({ seasonYear }: { seasonYear: number | null }): JSX.Element | null {
  const seasons = useSeasons();
  const season = seasons.data?.seasons.find((entry) => entry.seasonYear === seasonYear);

  if (!season?.paymentLink) return null;

  return (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
      <Button
        size="small"
        variant="outlined"
        href={season.paymentLink}
        target="_blank"
        rel="noreferrer noopener"
      >
        Pay dues
      </Button>
      <Typography variant="caption" color="text.secondary">
        {season.paymentNote ?? 'Paid outside the portal; your commissioner records it here.'}
      </Typography>
      <Link
        href={season.paymentLink}
        target="_blank"
        rel="noreferrer noopener"
        variant="caption"
        color="text.secondary"
      >
        {season.paymentLink.replace(/^https?:\/\//, '').slice(0, 40)}
      </Link>
    </Stack>
  );
}
