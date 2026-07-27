import { useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Link,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid2';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeftRounded';
import ChevronRightIcon from '@mui/icons-material/ChevronRightRounded';
import IconButton from '@mui/material/IconButton';
import EmojiEventsIcon from '@mui/icons-material/EmojiEventsRounded';
import CalculateIcon from '@mui/icons-material/CalculateRounded';
import GavelIcon from '@mui/icons-material/GavelRounded';
import LockIcon from '@mui/icons-material/LockRounded';
import PaidIcon from '@mui/icons-material/PaidRounded';
import { Link as RouterLink } from 'react-router-dom';
import {
  useCalculateChallenges,
  useCapabilities,
  useChallengeResults,
  useChallenges,
  useFinalizeChallenge,
  useLeagueOverview,
  useOverrideChallenge,
  usePayouts,
  usePrizeRules,
  useSavePayout,
  useSession,
} from '../hooks.js';
import type { ChallengeResult, PrizeRule } from '../api/client.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { useNotify } from '../components/SnackbarProvider.js';
import { EmptyState, Monogram, RelativeTime } from '../components/primitives.js';

/** Cents to a readable amount. Money is stored as integers to avoid float drift. */
function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/**
 * A week's challenge results.
 *
 * Every result carries the engine's own sentence of arithmetic, shown verbatim.
 * That explanation is the whole point of the design: it is what lets a 2021 result
 * be defended years later without having kept any Yahoo data, and it is what stops
 * "why did they win" becoming an argument.
 *
 * Nothing here decides a winner. The commissioner can finalize what the engine
 * computed, or override it with a recorded reason — but the arithmetic is never
 * quietly replaced.
 */
export function ChallengeResultsPanel({ seasonYear }: { seasonYear: number }): JSX.Element {
  const session = useSession();
  const overview = useLeagueOverview(true);
  const challenges = useChallenges(seasonYear);
  const capabilities = useCapabilities();

  const currentWeek = overview.data?.yahoo?.currentWeek ?? null;
  const startWeek = overview.data?.yahoo?.startWeek ?? 1;
  const endWeek = overview.data?.yahoo?.endWeek ?? 17;

  const [week, setWeek] = useState<number | null>(null);
  const activeWeek = week ?? currentWeek;

  const results = useChallengeResults(seasonYear, activeWeek);
  const calculate = useCalculateChallenges(seasonYear, activeWeek);
  const notify = useNotify();

  /**
   * Prize rules and the prizes already recorded.
   *
   * Both are needed to decide whether a finalized result should offer to create a
   * prize: one supplies the amount, the other stops it being offered twice.
   */
  const prizeRules = usePrizeRules(seasonYear);
  const payouts = usePayouts(seasonYear);

  const weeklyRule = (prizeRules.data?.rules ?? []).find(
    (rule) => rule.kind === 'weekly_challenge' && rule.amount !== undefined,
  );

  const isCommissioner = session.data?.user?.role === 'commissioner';
  const definitions = challenges.data?.definitions ?? [];

  /**
   * What is calculable RIGHT NOW, checked against the live capability matrix.
   *
   * Stored status alone would leave the Calculate button enabled after a capability
   * was withdrawn — it would post, the API would refuse every challenge, and the
   * page would report calculating nothing with no explanation.
   */
  const verified = new Set(capabilities.data?.verifiedCapabilities ?? []);
  const activeCount = definitions.filter(
    (definition) =>
      definition.status === 'active' &&
      definition.requiredYahooData.every((capability) => verified.has(capability)),
  ).length;

  const rows = results.data?.results ?? [];
  const nameBySlug = new Map(definitions.map((definition) => [definition.slug, definition.name]));

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Tooltip title="Previous week">
            <span>
              <IconButton
                onClick={() => setWeek((activeWeek ?? startWeek) - 1)}
                disabled={activeWeek === null || activeWeek <= startWeek}
                aria-label="Previous week"
              >
                <ChevronLeftIcon />
              </IconButton>
            </span>
          </Tooltip>

          <Chip
            label={activeWeek === null ? 'Week —' : `Week ${activeWeek}`}
            color={activeWeek === currentWeek ? 'primary' : 'default'}
            sx={{ minWidth: 96 }}
          />

          <Tooltip title="Next week">
            <span>
              <IconButton
                onClick={() => setWeek((activeWeek ?? startWeek) + 1)}
                disabled={activeWeek === null || activeWeek >= endWeek}
                aria-label="Next week"
              >
                <ChevronRightIcon />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>

        <Box sx={{ flexGrow: 1 }} />

        {isCommissioner && (
          <Tooltip
            title={
              activeCount === 0
                ? 'No challenge is calculable yet'
                : 'Recalculates every calculable challenge for this week'
            }
          >
            <span>
              <Button
                variant="contained"
                startIcon={<CalculateIcon />}
                disabled={activeCount === 0 || calculate.isPending || activeWeek === null}
                onClick={() =>
                  calculate.mutate(undefined, {
                    onSuccess: (data) =>
                      notify(
                        `Calculated ${data.calculated.length} challenge${
                          data.calculated.length === 1 ? '' : 's'
                        }.`,
                        'success',
                      ),
                    onError: (error) => notify(error.message, 'error'),
                  })
                }
              >
                {calculate.isPending
                  ? 'Calculating…'
                  : rows.length > 0
                    ? 'Recalculate week'
                    : 'Calculate week'}
              </Button>
            </span>
          </Tooltip>
        )}
      </Stack>

      {calculate.isError && <ErrorNotice error={calculate.error} hideRetry />}

      {/*
        Conflicts are the stat-correction case: a recalculation would have changed a
        result whose payout already settled, so the engine refused and asked for a
        person. Surfacing it as a warning rather than an error is deliberate —
        nothing is broken, a decision is required.
      */}
      {calculate.data?.conflicts && calculate.data.conflicts.length > 0 && (
        <Alert severity="warning">
          <AlertTitle>
            {calculate.data.conflicts.length}{' '}
            {calculate.data.conflicts.length === 1 ? 'result needs' : 'results need'} your decision
          </AlertTitle>
          <Stack spacing={0.5} sx={{ mt: 0.5 }}>
            {calculate.data.conflicts.map((conflict) => (
              <Typography variant="body2" key={conflict.slug}>
                <strong>{nameBySlug.get(conflict.slug) ?? conflict.slug}</strong> —{' '}
                {conflict.reason}
              </Typography>
            ))}
          </Stack>
        </Alert>
      )}

      {results.isLoading && (
        <Stack spacing={1.5}>
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} height={132} sx={{ borderRadius: 4 }} />
          ))}
        </Stack>
      )}

      {results.isError && (
        <ErrorNotice error={results.error} onRetry={() => void results.refetch()} />
      )}

      {results.data && rows.length === 0 && (
        <EmptyState
          icon={<EmojiEventsIcon />}
          title={`Nothing calculated for week ${activeWeek}`}
          description={
            isCommissioner
              ? 'Calculate the week once its games are done. Results start out provisional, because Yahoo keeps correcting stats for days afterwards.'
              : 'Your commissioner calculates each week once the games finish.'
          }
        />
      )}

      {rows.length > 0 && (
        <Stack spacing={1.5}>
          {rows.map((result) => (
            <ResultCard
              key={result.challengeResultId}
              result={result}
              name={nameBySlug.get(result.challengeSlug) ?? result.challengeSlug}
              seasonYear={seasonYear}
              week={activeWeek}
              isCommissioner={isCommissioner}
              members={results.data?.members ?? []}
              weeklyRule={weeklyRule ?? null}
              existingPrize={(payouts.data?.payouts ?? []).some(
                (payout) => payout.challengeResultId === result.challengeResultId,
              )}
            />
          ))}
        </Stack>
      )}

      {isCommissioner && rows.length > 0 && weeklyRule === undefined && (
        <Alert severity="info">
          <AlertTitle>Set what a weekly challenge pays</AlertTitle>
          Add a weekly-challenge prize rule on the{' '}
          <Link component={RouterLink} to="/money?view=rules">
            prize rules
          </Link>{' '}
          page, and finalizing a result will offer to record the prize for you — correctly linked,
          so a later Yahoo stat correction is flagged rather than applied quietly.
        </Alert>
      )}

      {rows.length > 0 && (
        <Typography variant="caption" color="text.secondary">
          Winners are computed in code from live Yahoo data, never by a language model. Provisional
          results can still change: Yahoo issues stat corrections for days after games finish.
        </Typography>
      )}
    </Stack>
  );
}

const STATUS_META: Record<
  ChallengeResult['status'],
  { label: string; color: 'default' | 'success' | 'warning' | 'error' | 'info'; hint: string }
> = {
  provisional: {
    label: 'provisional',
    color: 'info',
    hint: 'Computed, but not payable yet — Yahoo can still correct the stats behind it.',
  },
  finalized: {
    label: 'final',
    color: 'success',
    hint: 'A commissioner accepted this result. It is payable.',
  },
  overridden: {
    label: 'overridden',
    color: 'warning',
    hint: 'A commissioner replaced the computed outcome. The original is kept in the audit log.',
  },
  not_calculable: {
    label: 'no winner',
    color: 'default',
    hint: 'The rule ran but produced no winner.',
  },
  conflict: {
    label: 'needs a decision',
    color: 'error',
    hint: 'A recalculation would change a result that has already been paid.',
  },
};

function ResultCard({
  result,
  name,
  seasonYear,
  week,
  isCommissioner,
  members,
  weeklyRule,
  existingPrize,
}: {
  result: ChallengeResult;
  name: string;
  seasonYear: number;
  week: number | null;
  isCommissioner: boolean;
  members: Array<{ leagueMemberId: string; displayName: string }>;
  /** The league's weekly-challenge prize rule, when one is defined. */
  weeklyRule: PrizeRule | null;
  existingPrize: boolean;
}): JSX.Element {
  const finalize = useFinalizeChallenge(seasonYear, week);
  const savePayout = useSavePayout(seasonYear);
  const [overriding, setOverriding] = useState(false);
  const notify = useNotify();

  /**
   * Whether to offer recording the prize.
   *
   * Only for a settled result with a winner, a rule that says what it pays, and no
   * prize already recorded against it. Anything else and the button would either
   * guess an amount or create a duplicate.
   */
  const settledResult = result.status === 'finalized' || result.status === 'overridden';
  const canRecordPrize =
    isCommissioner &&
    settledResult &&
    !existingPrize &&
    result.winners.length > 0 &&
    weeklyRule?.amount !== undefined &&
    week !== null;

  /**
   * Split evenly when a tie was settled by sharing the prize.
   *
   * Integer cents, with the remainder going to the first winner — money must not
   * quietly vanish to rounding, and a cent has to land somewhere.
   */
  const shareCents = (index: number): number => {
    const total = weeklyRule?.amount?.amountCents ?? 0;
    const count = result.winners.length;
    const base = Math.floor(total / count);
    return index === 0 ? base + (total - base * count) : base;
  };

  const meta = STATUS_META[result.status];
  const canFinalize = result.status === 'provisional' && result.winners.length > 0;

  return (
    <>
      <Card
        sx={{
          borderLeft: 4,
          borderLeftColor:
            result.status === 'finalized'
              ? 'success.main'
              : result.status === 'overridden'
                ? 'warning.main'
                : result.status === 'conflict'
                  ? 'error.main'
                  : 'divider',
        }}
      >
        <CardContent>
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                {name}
              </Typography>

              <Tooltip title={meta.hint}>
                <Chip size="small" color={meta.color} label={meta.label} />
              </Tooltip>

              {result.wasTied && (
                <Tooltip title="The top value was shared before tiebreakers ran">
                  <Chip size="small" variant="outlined" label="tied" />
                </Tooltip>
              )}

              {result.payoutSettled && (
                <Tooltip title="A payout for this result has settled">
                  <Chip size="small" variant="outlined" icon={<PaidIcon />} label="paid" />
                </Tooltip>
              )}

              {result.calculationCount > 1 && (
                <Tooltip title="Recalculated after the first run, usually a Yahoo stat correction">
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`recalculated ${result.calculationCount - 1}×`}
                  />
                </Tooltip>
              )}
            </Stack>

            {result.winners.length > 0 ? (
              <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
                {result.winners.map((winner) => (
                  <Stack
                    key={winner.leagueMemberId}
                    direction="row"
                    spacing={1}
                    alignItems="center"
                  >
                    <Monogram name={winner.displayName} size={32} />
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {winner.displayName}
                    </Typography>
                  </Stack>
                ))}

                {result.winningValue !== undefined && (
                  <Chip
                    label={result.winningValue}
                    color="primary"
                    sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}
                  />
                )}
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary">
                {result.notCalculableReason ?? 'No winner.'}
              </Typography>
            )}

            {/*
              The engine's explanation, verbatim. Paraphrasing it here would put a
              second version of the arithmetic in the UI, and the two would drift.
            */}
            {result.explanation && (
              <Typography variant="body2" color="text.secondary">
                {result.explanation}
              </Typography>
            )}

            <Stack
              direction="row"
              spacing={1.5}
              alignItems="center"
              flexWrap="wrap"
              useFlexGap
              sx={{ pt: 0.5 }}
            >
              <Typography variant="caption" color="text.secondary">
                {result.competitorCount} competitor{result.competitorCount === 1 ? '' : 's'} ·
                calculated <RelativeTime value={result.calculatedAt} underline={false} />
                {result.appliedTieBreaker
                  ? ` · tiebreak: ${result.appliedTieBreaker.replace(/_/g, ' ')}`
                  : ''}
              </Typography>

              <Box sx={{ flexGrow: 1 }} />

              {isCommissioner && (
                <Stack direction="row" spacing={1}>
                  {canRecordPrize && (
                    <Tooltip
                      title={`Creates an unpaid prize of ${formatCents(
                        weeklyRule!.amount!.amountCents,
                      )} for ${result.winners.map((winner) => winner.displayName).join(' and ')}, linked to this result`}
                    >
                      <Button
                        size="small"
                        variant="contained"
                        color="secondary"
                        startIcon={<PaidIcon />}
                        disabled={savePayout.isPending}
                        onClick={() => {
                          /*
                            One prize per winner, prefilled and linked.
                            The link is what arms the stat-correction protection, so
                            it must not depend on anyone remembering to set it. Created
                            unpaid: handing the money over stays a separate act.
                          */
                          result.winners.forEach((winner, index) => {
                            savePayout.mutate(
                              {
                                leagueMemberId: winner.leagueMemberId,
                                reason: `Week ${week} ${name}`,
                                amountCents: shareCents(index),
                                status: 'unpaid',
                                week,
                                challengeResultId: result.challengeResultId,
                                ...(weeklyRule ? { prizeRuleId: weeklyRule.prizeRuleId } : {}),
                              },
                              {
                                onSuccess: () => {
                                  if (index === result.winners.length - 1) {
                                    notify(`Prize recorded for ${name}.`, 'success');
                                  }
                                },
                                onError: (error) => notify(error.message, 'error'),
                              },
                            );
                          });
                        }}
                      >
                        {savePayout.isPending
                          ? 'Recording…'
                          : `Record ${formatCents(weeklyRule!.amount!.amountCents)} prize`}
                      </Button>
                    </Tooltip>
                  )}

                  {existingPrize && settledResult && (
                    <Chip
                      size="small"
                      variant="outlined"
                      icon={<PaidIcon />}
                      label="prize recorded"
                    />
                  )}

                  {canFinalize && (
                    <Button
                      size="small"
                      variant="contained"
                      startIcon={<LockIcon />}
                      disabled={finalize.isPending}
                      onClick={() =>
                        finalize.mutate(result.challengeSlug, {
                          onSuccess: () => notify(`Finalized ${name}.`, 'success'),
                          onError: (error) => notify(error.message, 'error'),
                        })
                      }
                    >
                      {finalize.isPending ? 'Finalizing…' : 'Finalize'}
                    </Button>
                  )}

                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<GavelIcon />}
                    onClick={(event) => {
                      // Blurred before the dialog hides the root from assistive tech.
                      event.currentTarget.blur();
                      setOverriding(true);
                    }}
                  >
                    Override
                  </Button>
                </Stack>
              )}
            </Stack>

            {finalize.isError && <ErrorNotice error={finalize.error} hideRetry />}
          </Stack>
        </CardContent>
      </Card>

      <OverrideDialog
        open={overriding}
        onClose={() => setOverriding(false)}
        result={result}
        name={name}
        seasonYear={seasonYear}
        week={week}
        members={members}
      />
    </>
  );
}

/**
 * Records a commissioner's deliberate deviation from the arithmetic.
 *
 * A reason is mandatory — the API rejects an empty one — because the point of the
 * record is that a future commissioner can see why the computed answer was not
 * used. Overriding an already-paid result is allowed but called out, since it is a
 * materially different act.
 */
function OverrideDialog({
  open,
  onClose,
  result,
  name,
  seasonYear,
  week,
  members,
}: {
  open: boolean;
  onClose: () => void;
  result: ChallengeResult;
  name: string;
  seasonYear: number;
  week: number | null;
  members: Array<{ leagueMemberId: string; displayName: string }>;
}): JSX.Element {
  const override = useOverrideChallenge(seasonYear, week);
  const notify = useNotify();

  const [winners, setWinners] = useState<string[]>(result.winningLeagueMemberIds);
  const [value, setValue] = useState(
    result.winningValue === undefined ? '' : String(result.winningValue),
  );
  const [reason, setReason] = useState('');

  const parsedValue = value.trim() === '' ? undefined : Number(value);
  const valueValid = parsedValue === undefined || Number.isFinite(parsedValue);
  const canSubmit = winners.length > 0 && reason.trim().length > 0 && valueValid;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Override {name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <DialogContentText>
            The computed result is kept alongside your decision, so the arithmetic is never erased.
          </DialogContentText>

          {result.payoutSettled && (
            <Alert severity="warning">
              A payout for this result has already settled. Overriding it now changes a record
              somebody has been paid against.
            </Alert>
          )}

          <Card variant="filled">
            <CardContent sx={{ py: 1.5 }}>
              <Typography variant="caption" color="text.secondary" display="block">
                What the engine computed
              </Typography>
              <Typography variant="body2">
                {result.winners.length > 0
                  ? `${result.winners.map((winner) => winner.displayName).join(', ')}${
                      result.winningValue === undefined ? '' : ` · ${result.winningValue}`
                    }`
                  : 'No winner'}
              </Typography>
              {result.explanation && (
                <Typography variant="caption" color="text.secondary">
                  {result.explanation}
                </Typography>
              )}
            </CardContent>
          </Card>

          <FormControl size="small" fullWidth>
            <InputLabel id={`winners-${result.challengeResultId}`}>Winner or winners</InputLabel>
            <Select
              labelId={`winners-${result.challengeResultId}`}
              label="Winner or winners"
              multiple
              value={winners}
              renderValue={(selected) =>
                (selected as string[])
                  .map(
                    (id) =>
                      members.find((member) => member.leagueMemberId === id)?.displayName ?? id,
                  )
                  .join(', ')
              }
              onChange={(event) => setWinners(event.target.value as string[])}
            >
              {members.map((member) => (
                <MenuItem key={member.leagueMemberId} value={member.leagueMemberId}>
                  {member.displayName}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 5 }}>
              <TextField
                size="small"
                fullWidth
                label="Winning value (optional)"
                value={value}
                error={!valueValid}
                helperText={valueValid ? 'Leave blank if the rule has no number' : 'Not a number'}
                onChange={(event) => setValue(event.target.value)}
              />
            </Grid>
          </Grid>

          <TextField
            label="Why"
            required
            multiline
            minRows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            helperText="Recorded permanently. A future commissioner reads this, not your memory of it."
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!canSubmit || override.isPending}
          onClick={() => {
            override.mutate(
              {
                slug: result.challengeSlug,
                winningLeagueMemberIds: winners,
                ...(parsedValue === undefined ? {} : { winningValue: parsedValue }),
                reason: reason.trim(),
              },
              {
                onSuccess: () => {
                  notify(`Overrode ${name}.`, 'success');
                  onClose();
                },
                onError: (error) => notify(error.message, 'error'),
              },
            );
          }}
        >
          {override.isPending ? 'Recording…' : 'Record override'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
