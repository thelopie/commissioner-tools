import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Skeleton,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid2';
import { useSearchParams } from 'react-router-dom';
import PaymentsIcon from '@mui/icons-material/PaymentsRounded';
import AddIcon from '@mui/icons-material/AddRounded';
import EditIcon from '@mui/icons-material/EditRounded';
import {
  useChallengeResults,
  useDues,
  useLeagueOverview,
  usePayouts,
  useSaveDues,
  useSavePayout,
  useSession,
} from '../hooks.js';
import type { DuesRecord, PayoutRecord } from '../api/client.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { useNotify } from '../components/SnackbarProvider.js';
import { EmptyState, Monogram, PageHeader, SectionHeader } from '../components/primitives.js';

/**
 * Dues and prizes.
 *
 * Bookkeeping, and nothing more. The portal records that money moved somewhere else
 * — it holds no funds, moves none, and integrates no payment processor. Every page
 * here says so, because a league tool that looks like it might be taking payments
 * invites exactly the wrong assumption.
 *
 * Visible to every member on purpose: a shared ledger is how a league avoids
 * arguments about who has paid.
 */
export function MoneyPage(): JSX.Element {
  const session = useSession();
  const overview = useLeagueOverview(true);
  const seasonYear =
    overview.data?.yahoo?.seasonYear ?? overview.data?.league.currentSeasonYear ?? null;

  const isCommissioner = session.data?.user?.role === 'commissioner';

  const [params, setParams] = useSearchParams();
  const tab = params.get('view') === 'prizes' ? 'prizes' : 'dues';

  if (seasonYear === null) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Dues and prizes" />
        <EmptyState
          icon={<PaymentsIcon />}
          title="No season yet"
          description="Link a Yahoo league to a season, and the league's dues and prize records live here."
        />
      </Stack>
    );
  }

  return (
    <Stack spacing={3}>
      <PageHeader title="Dues and prizes" description={`${seasonYear} season`} />

      <Alert severity="info">
        These are the league&rsquo;s own records. The portal never takes, holds, or moves money — it
        notes what happened elsewhere so everyone can see the same ledger.
      </Alert>

      <Tabs
        value={tab}
        onChange={(_, next) => setParams(next === 'prizes' ? { view: 'prizes' } : {})}
        sx={{ borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab value="dues" label="Dues" />
        <Tab value="prizes" label="Prizes" />
      </Tabs>

      {tab === 'dues' ? (
        <DuesSection seasonYear={seasonYear} isCommissioner={isCommissioner} />
      ) : (
        <PrizesSection seasonYear={seasonYear} isCommissioner={isCommissioner} />
      )}
    </Stack>
  );
}

/** Cents to a readable amount. Money is stored as integers to avoid float drift. */
function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

const STATUS_COLOR: Record<string, 'default' | 'success' | 'warning' | 'info'> = {
  unpaid: 'warning',
  partial: 'info',
  paid: 'success',
  waived: 'default',
  refunded: 'default',
};

function DuesSection({
  seasonYear,
  isCommissioner,
}: {
  seasonYear: number;
  isCommissioner: boolean;
}): JSX.Element {
  const dues = useDues(seasonYear);
  const [editing, setEditing] = useState<DuesRecord | 'new' | null>(null);

  if (dues.isLoading) return <Skeleton height={320} sx={{ borderRadius: 4 }} />;
  if (dues.isError) {
    return <ErrorNotice error={dues.error} onRetry={() => void dues.refetch()} />;
  }

  const rows = dues.data?.dues ?? [];
  const summary = dues.data?.summary;

  return (
    <Stack spacing={2}>
      <Grid container spacing={2}>
        <Grid size={{ xs: 6, md: 3 }}>
          <MoneyTile label="Owed" value={formatMoney(summary?.totalOwedCents ?? 0)} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <MoneyTile label="Collected" value={formatMoney(summary?.totalPaidCents ?? 0)} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <MoneyTile
            label="Outstanding"
            value={formatMoney(
              Math.max(0, (summary?.totalOwedCents ?? 0) - (summary?.totalPaidCents ?? 0)),
            )}
            tone={summary && summary.unpaidCount > 0 ? 'warning' : 'default'}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <MoneyTile label="Still to pay" value={String(summary?.unpaidCount ?? 0)} />
        </Grid>
      </Grid>

      <SectionHeader
        title="Who owes what"
        count={rows.length}
        action={
          isCommissioner ? (
            <Button
              size="small"
              variant="contained"
              startIcon={<AddIcon />}
              onClick={(event) => {
                event.currentTarget.blur();
                setEditing('new');
              }}
            >
              Record dues
            </Button>
          ) : undefined
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={<PaymentsIcon />}
          title="No dues recorded"
          description={
            isCommissioner
              ? 'Record what each member owes for the season. You can also import a whole season from a CSV.'
              : 'Your commissioner has not recorded this season’s dues yet.'
          }
        />
      ) : (
        <Card>
          <CardContent sx={{ py: 1 }}>
            <Stack divider={<Divider flexItem />}>
              {rows.map((record) => (
                <Stack
                  key={record.duesRecordId}
                  direction="row"
                  spacing={1.5}
                  alignItems="center"
                  sx={{ py: 1.25 }}
                >
                  <Monogram name={record.displayName} size={32} />

                  <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
                      <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                        {record.displayName}
                      </Typography>
                      <Chip
                        size="small"
                        color={STATUS_COLOR[record.status] ?? 'default'}
                        label={record.status}
                      />
                    </Stack>
                    {(record.note || record.method) && (
                      <Typography variant="caption" color="text.secondary" noWrap display="block">
                        {[record.method, record.note].filter(Boolean).join(' · ')}
                      </Typography>
                    )}
                  </Box>

                  <Box sx={{ textAlign: 'right' }}>
                    <Typography
                      variant="body2"
                      sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
                    >
                      {formatMoney(record.amountPaid.amountCents)}
                      <Typography component="span" variant="caption" color="text.secondary">
                        {' / '}
                        {formatMoney(record.amountOwed.amountCents)}
                      </Typography>
                    </Typography>
                  </Box>

                  {isCommissioner && (
                    <Tooltip title="Edit this record">
                      <Button
                        size="small"
                        onClick={(event) => {
                          event.currentTarget.blur();
                          setEditing(record);
                        }}
                      >
                        <EditIcon fontSize="small" />
                      </Button>
                    </Tooltip>
                  )}
                </Stack>
              ))}
            </Stack>
          </CardContent>
        </Card>
      )}

      {/*
        Keyed on the record being edited.
        The form's initial values come from `useState` initializers, which run once
        per mount. Keying the <Dialog> inside the component did nothing — the
        component itself never remounted, so every edit opened a blank form under
        the right person's name.
      */}
      <DuesDialog
        key={editing === 'new' ? 'new' : (editing?.duesRecordId ?? 'closed')}
        open={editing !== null}
        onClose={() => setEditing(null)}
        seasonYear={seasonYear}
        record={editing === 'new' ? null : editing}
        members={dues.data?.members ?? []}
      />
    </Stack>
  );
}

function MoneyTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warning';
}): JSX.Element {
  return (
    <Card variant="filled" sx={{ height: '100%' }}>
      <CardContent>
        <Typography
          variant="caption"
          sx={{
            color: 'text.secondary',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            fontWeight: 700,
          }}
        >
          {label}
        </Typography>
        <Typography
          variant="h2"
          sx={{
            mt: 0.5,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            color: tone === 'warning' ? 'warning.main' : 'text.primary',
          }}
        >
          {value}
        </Typography>
      </CardContent>
    </Card>
  );
}

/** Amounts are typed in dollars and stored as integer cents. */
function dollarsToCents(value: string): number | null {
  const trimmed = value.trim().replace(/^\$/, '');
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

const METHODS = ['cash', 'venmo', 'zelle', 'paypal', 'check', 'other'] as const;

function DuesDialog({
  open,
  onClose,
  seasonYear,
  record,
  members,
}: {
  open: boolean;
  onClose: () => void;
  seasonYear: number;
  record: DuesRecord | null;
  members: Array<{ leagueMemberId: string; displayName: string }>;
}): JSX.Element {
  const save = useSaveDues(seasonYear);
  const notify = useNotify();

  const [memberId, setMemberId] = useState(record?.leagueMemberId ?? '');
  const [owed, setOwed] = useState(record ? centsToDollars(record.amountOwed.amountCents) : '');
  const [paid, setPaid] = useState(record ? centsToDollars(record.amountPaid.amountCents) : '0.00');
  const [method, setMethod] = useState<string>(record?.method ?? '');
  const [note, setNote] = useState(record?.note ?? '');

  /**
   * Only the statuses the amounts cannot imply.
   *
   * unpaid/partial/paid are derived server-side from the numbers, so offering them
   * here would invite a row that contradicts itself. Waiving or refunding is a
   * decision, which no amount expresses.
   */
  const [decision, setDecision] = useState<string>(
    record?.status === 'waived' || record?.status === 'refunded' ? record.status : '',
  );

  const owedCents = dollarsToCents(owed);
  const paidCents = dollarsToCents(paid) ?? 0;
  const canSubmit = memberId !== '' && owedCents !== null;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{record ? `Dues for ${record.displayName}` : 'Record dues'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <FormControl size="small" fullWidth disabled={record !== null}>
            <InputLabel id="dues-member">Member</InputLabel>
            <Select
              labelId="dues-member"
              label="Member"
              value={memberId}
              onChange={(event) => setMemberId(event.target.value)}
            >
              {members.map((member) => (
                <MenuItem key={member.leagueMemberId} value={member.leagueMemberId}>
                  {member.displayName}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Stack direction="row" spacing={1.5}>
            <TextField
              size="small"
              fullWidth
              label="Owed"
              value={owed}
              onChange={(event) => setOwed(event.target.value)}
              error={owed !== '' && owedCents === null}
              InputProps={{ startAdornment: <Typography sx={{ mr: 0.5 }}>$</Typography> }}
            />
            <TextField
              size="small"
              fullWidth
              label="Paid so far"
              value={paid}
              onChange={(event) => setPaid(event.target.value)}
              error={paid !== '' && dollarsToCents(paid) === null}
              InputProps={{ startAdornment: <Typography sx={{ mr: 0.5 }}>$</Typography> }}
            />
          </Stack>

          <Typography variant="caption" color="text.secondary">
            Status is worked out from the amounts, so it can never disagree with them.
          </Typography>

          <FormControl size="small" fullWidth>
            <InputLabel id="dues-decision">Or mark it</InputLabel>
            <Select
              labelId="dues-decision"
              label="Or mark it"
              value={decision}
              onChange={(event) => setDecision(event.target.value)}
            >
              <MenuItem value="">
                <em>From the amounts</em>
              </MenuItem>
              <MenuItem value="waived">Waived</MenuItem>
              <MenuItem value="refunded">Refunded</MenuItem>
            </Select>
          </FormControl>

          <FormControl size="small" fullWidth>
            <InputLabel id="dues-method">How it was paid</InputLabel>
            <Select
              labelId="dues-method"
              label="How it was paid"
              value={method}
              onChange={(event) => setMethod(event.target.value)}
            >
              <MenuItem value="">
                <em>Not stated</em>
              </MenuItem>
              {METHODS.map((option) => (
                <MenuItem key={option} value={option}>
                  {option}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <TextField
            label="Note"
            multiline
            minRows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Paid at the draft, covered Mike too"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!canSubmit || save.isPending}
          onClick={() => {
            if (owedCents === null) return;
            save.mutate(
              {
                ...(record ? { duesRecordId: record.duesRecordId } : {}),
                leagueMemberId: memberId,
                amountOwedCents: owedCents,
                amountPaidCents: paidCents,
                ...(method ? { method } : {}),
                ...(decision ? { status: decision } : {}),
                ...(note.trim() ? { note: note.trim() } : {}),
              },
              {
                onSuccess: () => {
                  notify('Dues recorded.', 'success');
                  onClose();
                },
                onError: (error) => notify(error.message, 'error'),
              },
            );
          }}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function PrizesSection({
  seasonYear,
  isCommissioner,
}: {
  seasonYear: number;
  isCommissioner: boolean;
}): JSX.Element {
  const payouts = usePayouts(seasonYear);
  const [editing, setEditing] = useState<PayoutRecord | 'new' | null>(null);

  if (payouts.isLoading) return <Skeleton height={320} sx={{ borderRadius: 4 }} />;
  if (payouts.isError) {
    return <ErrorNotice error={payouts.error} onRetry={() => void payouts.refetch()} />;
  }

  const rows = payouts.data?.payouts ?? [];
  const summary = payouts.data?.summary;

  return (
    <Stack spacing={2}>
      <Grid container spacing={2}>
        <Grid size={{ xs: 6, md: 4 }}>
          <MoneyTile label="Prizes recorded" value={formatMoney(summary?.totalCents ?? 0)} />
        </Grid>
        <Grid size={{ xs: 6, md: 4 }}>
          <MoneyTile
            label="Not yet settled"
            value={String(summary?.pendingCount ?? 0)}
            tone={summary && summary.pendingCount > 0 ? 'warning' : 'default'}
          />
        </Grid>
      </Grid>

      <SectionHeader
        title="Prizes"
        count={rows.length}
        action={
          isCommissioner ? (
            <Button
              size="small"
              variant="contained"
              startIcon={<AddIcon />}
              onClick={(event) => {
                event.currentTarget.blur();
                setEditing('new');
              }}
            >
              Record a prize
            </Button>
          ) : undefined
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={<PaymentsIcon />}
          title="No prizes recorded"
          description={
            isCommissioner
              ? 'Record a prize once you have decided it. Nothing is created automatically from a challenge result — you enter it, deliberately.'
              : 'Nothing recorded for this season yet.'
          }
        />
      ) : (
        <Card>
          <CardContent sx={{ py: 1 }}>
            <Stack divider={<Divider flexItem />}>
              {rows.map((record) => (
                <Stack
                  key={record.payoutRecordId}
                  direction="row"
                  spacing={1.5}
                  alignItems="center"
                  sx={{ py: 1.25 }}
                >
                  <Monogram name={record.displayName} size={32} />

                  <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
                      <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                        {record.displayName}
                      </Typography>
                      <Chip
                        size="small"
                        color={STATUS_COLOR[record.status] ?? 'default'}
                        label={record.status}
                      />
                      {record.week !== undefined && (
                        <Chip size="small" variant="outlined" label={`week ${record.week}`} />
                      )}
                    </Stack>
                    <Typography variant="caption" color="text.secondary" noWrap display="block">
                      {record.reason}
                    </Typography>
                  </Box>

                  <Typography
                    variant="body2"
                    sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
                  >
                    {formatMoney(record.amount.amountCents)}
                  </Typography>

                  {isCommissioner && (
                    <Tooltip title="Edit this record">
                      <Button
                        size="small"
                        onClick={(event) => {
                          event.currentTarget.blur();
                          setEditing(record);
                        }}
                      >
                        <EditIcon fontSize="small" />
                      </Button>
                    </Tooltip>
                  )}
                </Stack>
              ))}
            </Stack>
          </CardContent>
        </Card>
      )}

      <PayoutDialog
        key={editing === 'new' ? 'new' : (editing?.payoutRecordId ?? 'closed')}
        open={editing !== null}
        onClose={() => setEditing(null)}
        seasonYear={seasonYear}
        record={editing === 'new' ? null : editing}
        members={payouts.data?.members ?? []}
      />
    </Stack>
  );
}

function PayoutDialog({
  open,
  onClose,
  seasonYear,
  record,
  members,
}: {
  open: boolean;
  onClose: () => void;
  seasonYear: number;
  record: PayoutRecord | null;
  members: Array<{ leagueMemberId: string; displayName: string }>;
}): JSX.Element {
  const save = useSavePayout(seasonYear);
  const notify = useNotify();

  const [memberId, setMemberId] = useState(record?.leagueMemberId ?? '');
  const [reason, setReason] = useState(record?.reason ?? '');
  const [amount, setAmount] = useState(record ? centsToDollars(record.amount.amountCents) : '');
  const [settled, setSettled] = useState(record?.status === 'paid');
  const [method, setMethod] = useState<string>(record?.method ?? '');

  /**
   * Optionally ties the prize to a week's challenge result.
   *
   * This link is what arms the stat-correction protection: once a prize referencing
   * a result is settled, the engine refuses to let a later Yahoo correction rewrite
   * who won, and raises it with the commissioner instead. Without a way to make the
   * link here, that protection could never be engaged from the portal.
   */
  const [week, setWeek] = useState<string>(record?.week === undefined ? '' : String(record.week));
  const [resultId, setResultId] = useState<string>(record?.challengeResultId ?? '');

  const weekNumber = week === '' ? null : Number(week);
  const weekResults = useChallengeResults(
    seasonYear,
    weekNumber !== null && Number.isInteger(weekNumber) ? weekNumber : null,
  );

  const amountCents = dollarsToCents(amount);
  const canSubmit = memberId !== '' && reason.trim().length > 0 && amountCents !== null;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{record ? 'Edit prize' : 'Record a prize'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <FormControl size="small" fullWidth disabled={record !== null}>
            <InputLabel id="payout-member">Who won it</InputLabel>
            <Select
              labelId="payout-member"
              label="Who won it"
              value={memberId}
              onChange={(event) => setMemberId(event.target.value)}
            >
              {members.map((member) => (
                <MenuItem key={member.leagueMemberId} value={member.leagueMemberId}>
                  {member.displayName}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <TextField
            size="small"
            label="What for"
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Week 3 Bench Mob"
          />

          <TextField
            size="small"
            label="Amount"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            error={amount !== '' && amountCents === null}
            InputProps={{ startAdornment: <Typography sx={{ mr: 0.5 }}>$</Typography> }}
          />

          <Stack direction="row" spacing={1.5}>
            <TextField
              size="small"
              label="Week"
              placeholder="optional"
              value={week}
              onChange={(event) => {
                setWeek(event.target.value);
                // A result from the old week must not stay attached to the new one.
                setResultId('');
              }}
              sx={{ width: 120 }}
            />

            <FormControl
              size="small"
              fullWidth
              disabled={(weekResults.data?.results ?? []).length === 0}
            >
              <InputLabel id="payout-result">For which challenge</InputLabel>
              <Select
                labelId="payout-result"
                label="For which challenge"
                value={resultId}
                onChange={(event) => setResultId(event.target.value)}
              >
                <MenuItem value="">
                  <em>Not tied to a challenge</em>
                </MenuItem>

                {/*
                  Holds the existing link while that week's results are still loading.
                  Without it MUI sees a value with no matching option and warns on
                  every edit of a linked prize — noise that hides real warnings.
                */}
                {resultId !== '' &&
                  !(weekResults.data?.results ?? []).some(
                    (result) => result.challengeResultId === resultId,
                  ) && <MenuItem value={resultId}>Currently linked result</MenuItem>}

                {(weekResults.data?.results ?? []).map((result) => (
                  <MenuItem key={result.challengeResultId} value={result.challengeResultId}>
                    {result.challengeSlug}
                    {result.winners[0] ? ` · ${result.winners[0].displayName}` : ''}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>

          <FormControlLabel
            control={
              <Switch checked={settled} onChange={(event) => setSettled(event.target.checked)} />
            }
            label="Already handed over"
          />

          {settled && resultId !== '' && (
            <Alert severity="info">
              Marking this settled locks the challenge result behind it. After that a Yahoo stat
              correction cannot quietly change who won — the portal raises it with you instead.
            </Alert>
          )}

          {settled && resultId === '' && (
            <Alert severity="warning">
              Not tied to a challenge, so nothing is locked. Link it to a week&rsquo;s result if you
              want a later Yahoo stat correction to be flagged rather than applied.
            </Alert>
          )}

          <FormControl size="small" fullWidth>
            <InputLabel id="payout-method">How</InputLabel>
            <Select
              labelId="payout-method"
              label="How"
              value={method}
              onChange={(event) => setMethod(event.target.value)}
            >
              <MenuItem value="">
                <em>Not stated</em>
              </MenuItem>
              {METHODS.map((option) => (
                <MenuItem key={option} value={option}>
                  {option}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!canSubmit || save.isPending}
          onClick={() => {
            if (amountCents === null) return;
            save.mutate(
              {
                ...(record ? { payoutRecordId: record.payoutRecordId } : {}),
                leagueMemberId: memberId,
                reason: reason.trim(),
                amountCents,
                status: settled ? 'paid' : 'unpaid',
                ...(method ? { method } : {}),
                ...(weekNumber !== null && Number.isInteger(weekNumber)
                  ? { week: weekNumber }
                  : {}),
                ...(resultId ? { challengeResultId: resultId } : {}),
              },
              {
                onSuccess: () => {
                  notify('Prize recorded.', 'success');
                  onClose();
                },
                onError: (error) => notify(error.message, 'error'),
              },
            );
          }}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
