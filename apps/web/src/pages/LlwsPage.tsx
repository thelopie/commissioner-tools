import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid2';
import CasinoIcon from '@mui/icons-material/CasinoRounded';
import VerifiedIcon from '@mui/icons-material/VerifiedRounded';
import PublishIcon from '@mui/icons-material/PublishRounded';
import NotificationsIcon from '@mui/icons-material/NotificationsActiveRounded';
import SportsBaseballIcon from '@mui/icons-material/SportsBaseballRounded';
import { Link as RouterLink } from 'react-router-dom';
import {
  useAddLlwsTeams,
  useAssignments,
  useComputeSelectionOrder,
  useDraftStatus,
  useDrawAssignments,
  useLeagueOverview,
  useLlwsTeams,
  usePublishAssignments,
  useRecordFinish,
  useRemindCurrentTurn,
  useVerifyDraw,
} from '../hooks.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { EmptyState, PageHeader, SectionHeader } from '../components/primitives.js';

/**
 * The commissioner's LLWS draft-order workflow.
 *
 * Five steps in the order they actually happen: enter the field, draw assignments,
 * publish the draw, record the finishes, compute the selection order. Each step
 * states what it will do before it does it, because the draw and the publish are
 * both effectively irreversible — you cannot redraw after telling twelve people
 * which team they got.
 */
export function LlwsPage(): JSX.Element {
  const overview = useLeagueOverview(true);
  const seasonYear = overview.data?.league?.currentSeasonYear ?? null;

  const teams = useLlwsTeams(seasonYear);
  const assignments = useAssignments(seasonYear);
  const draftStatus = useDraftStatus(seasonYear);

  const published = assignments.data?.published ?? false;
  const hasDraw = (assignments.data?.assignments.length ?? 0) > 0;
  const teamList = teams.data?.teams ?? [];
  const withFinish = teamList.filter((team) => team.finishRank !== undefined);

  if (overview.isLoading || teams.isLoading) {
    return (
      <Stack spacing={3}>
        <PageHeader title="LLWS draft order" />
        <Skeleton height={420} sx={{ borderRadius: 4 }} />
      </Stack>
    );
  }

  if (seasonYear === null) {
    return (
      <Stack spacing={3}>
        <PageHeader title="LLWS draft order" />
        <EmptyState
          icon={<SportsBaseballIcon />}
          title="No season is set up yet"
          description="Link a Yahoo league and set the current season before entering the LLWS field."
          action={
            <Button variant="contained" component={RouterLink} to="/commissioner">
              Open commissioner tools
            </Button>
          }
        />
      </Stack>
    );
  }

  return (
    <Stack spacing={4}>
      <PageHeader
        title="LLWS draft order"
        description={`${seasonYear} season`}
        action={
          <Button variant="outlined" component={RouterLink} to="/draft">
            View the draft board
          </Button>
        }
      />

      <Alert severity="info">
        Yahoo publishes no API for setting draft order, so this workflow ends in a printable list
        you type into Yahoo yourself. Nothing here writes to Yahoo.
      </Alert>

      <StepFieldEntry seasonYear={seasonYear} teamCount={teamList.length} locked={hasDraw} />

      <StepDraw
        seasonYear={seasonYear}
        hasDraw={hasDraw}
        published={published}
        seed={assignments.data?.seed ?? null}
        teamCount={teamList.length}
      />

      <StepFinishes seasonYear={seasonYear} />

      <StepSelectionOrder
        seasonYear={seasonYear}
        finishesRecorded={withFinish.length}
        hasDraw={hasDraw}
        orderExists={(draftStatus.data?.selections.length ?? 0) > 0}
        currentTurn={draftStatus.data?.currentTurn?.displayName ?? null}
      />
    </Stack>
  );
}

/** Step 1: the tournament field. */
function StepFieldEntry({
  seasonYear,
  teamCount,
  locked,
}: {
  seasonYear: number;
  teamCount: number;
  locked: boolean;
}): JSX.Element {
  const teams = useLlwsTeams(seasonYear);
  const addTeams = useAddLlwsTeams(seasonYear);

  const [text, setText] = useState('');
  const [bracket, setBracket] = useState('unknown');

  /**
   * One team per line, `Name, Region` optional.
   *
   * A twelve-to-twenty-team field typed into individual form rows is a chore
   * nobody does twice; pasting a list is how this actually gets entered.
   */
  const parsed = useMemo(
    () =>
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const [name, ...rest] = line.split(',');
          const region = rest.join(',').trim();
          return {
            name: (name ?? '').trim(),
            ...(region ? { region } : {}),
            bracket,
          };
        })
        .filter((team) => team.name.length > 0),
    [text, bracket],
  );

  return (
    <Box>
      <SectionHeader
        title="1 · The field"
        count={teamCount}
        action={teamCount > 0 ? <Chip size="small" color="success" label="entered" /> : undefined}
      />

      <Card>
        <CardContent>
          <Stack spacing={2}>
            {locked && (
              <Alert severity="warning">
                Assignments have already been drawn. Adding teams now leaves them unassigned unless
                you redraw.
              </Alert>
            )}

            {teamCount > 0 && (
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                {(teams.data?.teams ?? []).map((team) => (
                  <Chip
                    key={team.llwsTeamId}
                    size="small"
                    variant="outlined"
                    label={team.region ? `${team.name} · ${team.region}` : team.name}
                  />
                ))}
              </Stack>
            )}

            <TextField
              label="Teams, one per line"
              placeholder={'Kanto Region\nSouth Williamsport, Pennsylvania\nCuraçao'}
              helperText="Optionally add a region after a comma. Paste the whole field at once."
              multiline
              minRows={4}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems="flex-start">
              <FormControl size="small" sx={{ minWidth: 200 }}>
                <InputLabel id="bracket-label">Bracket</InputLabel>
                <Select
                  labelId="bracket-label"
                  label="Bracket"
                  value={bracket}
                  onChange={(event) => setBracket(event.target.value)}
                >
                  <MenuItem value="unknown">Not specified</MenuItem>
                  <MenuItem value="united_states">United States</MenuItem>
                  <MenuItem value="international">International</MenuItem>
                </Select>
              </FormControl>

              <Button
                variant="contained"
                disabled={parsed.length === 0 || addTeams.isPending}
                onClick={() => addTeams.mutate(parsed, { onSuccess: () => setText('') })}
              >
                {addTeams.isPending
                  ? 'Adding…'
                  : `Add ${parsed.length || ''} team${parsed.length === 1 ? '' : 's'}`.trim()}
              </Button>
            </Stack>

            {addTeams.isError && <ErrorNotice error={addTeams.error} />}
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}

/** Step 2: the seeded draw, its verification, and publication. */
function StepDraw({
  seasonYear,
  hasDraw,
  published,
  seed,
  teamCount,
}: {
  seasonYear: number;
  hasDraw: boolean;
  published: boolean;
  seed: string | null;
  teamCount: number;
}): JSX.Element {
  const draw = useDrawAssignments(seasonYear);
  const publish = usePublishAssignments(seasonYear);

  const [showVerify, setShowVerify] = useState(false);
  const verify = useVerifyDraw(seasonYear, showVerify);

  const [confirmRedraw, setConfirmRedraw] = useState(false);

  return (
    <Box>
      <SectionHeader
        title="2 · The draw"
        action={
          published ? (
            <Chip size="small" color="success" label="published" />
          ) : hasDraw ? (
            <Chip size="small" color="warning" variant="outlined" label="drawn, not published" />
          ) : undefined
        }
      />

      <Card>
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              Every manager is randomly assigned one LLWS team. The draw records its seed, so anyone
              can re-run it later and confirm nothing was swapped afterwards.
            </Typography>

            {seed && (
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">
                  Recorded seed
                </Typography>
                {/* Shown, not hidden: a seed nobody can see proves nothing. */}
                <Typography
                  variant="body2"
                  sx={{ fontFamily: 'monospace', wordBreak: 'break-all', fontWeight: 600 }}
                >
                  {seed}
                </Typography>
              </Box>
            )}

            {!hasDraw && teamCount === 0 && (
              <Alert severity="warning">Enter the field above before drawing.</Alert>
            )}

            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {!hasDraw && (
                <Button
                  variant="contained"
                  startIcon={<CasinoIcon />}
                  disabled={teamCount === 0 || draw.isPending}
                  onClick={() => draw.mutate({})}
                >
                  {draw.isPending ? 'Drawing…' : 'Draw assignments'}
                </Button>
              )}

              {hasDraw && !published && (
                <>
                  <Button
                    variant="contained"
                    startIcon={<PublishIcon />}
                    disabled={publish.isPending}
                    onClick={() => publish.mutate()}
                  >
                    {publish.isPending ? 'Publishing…' : 'Publish to the league'}
                  </Button>

                  {/*
                    A redraw before publication is legitimate — a mis-entered field,
                    a manager added late. It still takes two clicks.
                  */}
                  <Button
                    variant="outlined"
                    color={confirmRedraw ? 'error' : 'primary'}
                    disabled={draw.isPending}
                    onClick={() => {
                      if (!confirmRedraw) {
                        setConfirmRedraw(true);
                        return;
                      }
                      draw.mutate(
                        { replaceExisting: true },
                        { onSettled: () => setConfirmRedraw(false) },
                      );
                    }}
                  >
                    {confirmRedraw ? 'Confirm: discard this draw' : 'Redraw'}
                  </Button>
                </>
              )}

              {hasDraw && (
                <Tooltip title="Re-runs the draw from its stored seed and compares the result">
                  <Button
                    variant="text"
                    startIcon={<VerifiedIcon />}
                    onClick={() => setShowVerify(true)}
                  >
                    Verify the draw
                  </Button>
                </Tooltip>
              )}
            </Stack>

            {published && (
              <Alert severity="info">
                Published. Redrawing now would change a manager&rsquo;s team after they were told
                what it was, so the API refuses it without a recorded override.
              </Alert>
            )}

            {showVerify && verify.isLoading && <Skeleton height={56} />}

            {showVerify && verify.data && (
              <Alert severity={verify.data.verified ? 'success' : 'error'}>
                {verify.data.note ?? verify.data.reason}
                {verify.data.mismatches && verify.data.mismatches.length > 0 && (
                  <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
                    {verify.data.mismatches.length} assignment
                    {verify.data.mismatches.length === 1 ? '' : 's'} differ from the seeded result.
                  </Typography>
                )}
              </Alert>
            )}

            {draw.isError && <ErrorNotice error={draw.error} />}
            {publish.isError && <ErrorNotice error={publish.error} />}
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}

/** Step 3: how far each team got. This is what drives selection order. */
function StepFinishes({ seasonYear }: { seasonYear: number }): JSX.Element {
  const teams = useLlwsTeams(seasonYear);
  const recordFinish = useRecordFinish(seasonYear);

  const list = teams.data?.teams ?? [];
  const recorded = list.filter((team) => team.finishRank !== undefined);

  return (
    <Box>
      <SectionHeader
        title="3 · Finishes"
        count={list.length}
        action={
          <Chip
            size="small"
            variant="outlined"
            color={recorded.length === list.length && list.length > 0 ? 'success' : 'default'}
            label={`${recorded.length} of ${list.length} recorded`}
          />
        }
      />

      <Card>
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              Rank 1 is the tournament winner. The manager holding the highest-finishing team
              chooses their draft slot first.
            </Typography>

            {list.length === 0 ? (
              <Alert severity="info">Enter the field above first.</Alert>
            ) : (
              <Stack divider={<Divider flexItem />}>
                {list.map((team) => (
                  <FinishRow
                    key={team.llwsTeamId}
                    name={team.region ? `${team.name} · ${team.region}` : team.name}
                    finishRank={team.finishRank ?? null}
                    pending={recordFinish.isPending}
                    onSave={(rank, label) =>
                      recordFinish.mutate({
                        llwsTeamId: team.llwsTeamId,
                        finishRank: rank,
                        ...(label ? { finishLabel: label } : {}),
                      })
                    }
                  />
                ))}
              </Stack>
            )}

            {recordFinish.isError && <ErrorNotice error={recordFinish.error} />}
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}

function FinishRow({
  name,
  finishRank,
  pending,
  onSave,
}: {
  name: string;
  finishRank: number | null;
  pending: boolean;
  onSave: (rank: number, label: string) => void;
}): JSX.Element {
  const [rank, setRank] = useState(finishRank === null ? '' : String(finishRank));
  const [label, setLabel] = useState('');

  const parsedRank = Number(rank);
  const valid = Number.isInteger(parsedRank) && parsedRank >= 1 && parsedRank <= 64;
  const changed = rank !== (finishRank === null ? '' : String(finishRank));

  return (
    <Grid container spacing={1.5} alignItems="center" sx={{ py: 1.25 }}>
      <Grid size={{ xs: 12, sm: 5 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
            {name}
          </Typography>
          {finishRank !== null && (
            <Chip size="small" color="success" label={`finished ${finishRank}`} />
          )}
        </Stack>
      </Grid>

      <Grid size={{ xs: 4, sm: 2 }}>
        <TextField
          size="small"
          label="Rank"
          value={rank}
          onChange={(event) => setRank(event.target.value)}
          error={rank !== '' && !valid}
          fullWidth
        />
      </Grid>

      <Grid size={{ xs: 8, sm: 3 }}>
        <TextField
          size="small"
          label="Label (optional)"
          placeholder="Eliminated in pool play"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          fullWidth
        />
      </Grid>

      <Grid size={{ xs: 12, sm: 2 }}>
        <Button
          fullWidth
          variant="outlined"
          disabled={!valid || !changed || pending}
          onClick={() => onSave(parsedRank, label)}
        >
          Save
        </Button>
      </Grid>
    </Grid>
  );
}

/** Step 4: derive the selection queue and nudge whoever is up. */
function StepSelectionOrder({
  seasonYear,
  finishesRecorded,
  hasDraw,
  orderExists,
  currentTurn,
}: {
  seasonYear: number;
  finishesRecorded: number;
  hasDraw: boolean;
  orderExists: boolean;
  currentTurn: string | null;
}): JSX.Element {
  const compute = useComputeSelectionOrder(seasonYear);
  const remind = useRemindCurrentTurn(seasonYear);

  /**
   * Tiebreakers are ordered, and the order matters.
   *
   * Two managers whose LLWS teams finished level are separated by the first rule
   * that separates them. `seeded_random` last means the result is still
   * reproducible when nothing else distinguishes them.
   */
  const [tieBreakers, setTieBreakers] = useState<string[]>([
    'worse_prior_season_finish',
    'seeded_random',
  ]);

  return (
    <Box>
      <SectionHeader
        title="4 · Selection order"
        action={orderExists ? <Chip size="small" color="success" label="computed" /> : undefined}
      />

      <Card>
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              Managers are queued by how far their LLWS team went. This is who picks a draft slot
              first — not the draft order itself.
            </Typography>

            {!hasDraw && <Alert severity="warning">Draw assignments before computing order.</Alert>}
            {hasDraw && finishesRecorded === 0 && (
              <Alert severity="warning">
                No finishes recorded yet. Computing now would queue everyone on a tiebreaker alone.
              </Alert>
            )}

            <FormControl size="small" fullWidth>
              <InputLabel id="tiebreak-label">Tiebreakers, in order</InputLabel>
              <Select
                labelId="tiebreak-label"
                label="Tiebreakers, in order"
                multiple
                value={tieBreakers}
                renderValue={(selected) =>
                  (selected as string[]).map((value) => value.replace(/_/g, ' ')).join(' → ')
                }
                onChange={(event) => setTieBreakers(event.target.value as string[])}
              >
                <MenuItem value="worse_prior_season_finish">Worse prior-season finish</MenuItem>
                <MenuItem value="better_prior_season_finish">Better prior-season finish</MenuItem>
                <MenuItem value="seeded_random">Seeded random</MenuItem>
                <MenuItem value="commissioner_decides">Commissioner decides</MenuItem>
              </Select>
            </FormControl>

            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Button
                variant="contained"
                disabled={!hasDraw || compute.isPending || tieBreakers.length === 0}
                onClick={() => compute.mutate({ tieBreakers })}
              >
                {compute.isPending
                  ? 'Computing…'
                  : orderExists
                    ? 'Recompute order'
                    : 'Compute selection order'}
              </Button>

              {currentTurn && (
                <Button
                  variant="outlined"
                  startIcon={<NotificationsIcon />}
                  disabled={remind.isPending}
                  onClick={() => remind.mutate()}
                >
                  {remind.isPending ? 'Recording…' : `Nudge ${currentTurn}`}
                </Button>
              )}
            </Stack>

            {orderExists && (
              <Alert severity="info">
                Recomputing leaves locked picks alone — a slot somebody already chose does not move.
              </Alert>
            )}

            {/*
              No message is sent. Recording a reminder is an audit entry, not a
              notification, and saying so avoids a commissioner believing an email
              went out.
            */}
            {remind.data && (
              <Alert severity={remind.data.reminded ? 'success' : 'info'}>
                {remind.data.reminded
                  ? 'Reminder recorded in the audit log. The portal does not send messages — tell them yourself.'
                  : (remind.data.reason ?? 'No turn is currently open.')}
              </Alert>
            )}

            {compute.data && (
              <Alert severity={compute.data.unplaced.length > 0 ? 'warning' : 'success'}>
                Queued {compute.data.order.length} manager
                {compute.data.order.length === 1 ? '' : 's'}.
                {compute.data.unplaced.length > 0 &&
                  ` ${compute.data.unplaced.length} could not be placed: ${compute.data.unplaced
                    .map((entry) => entry.reason)
                    .join('; ')}`}
              </Alert>
            )}

            {compute.isError && <ErrorNotice error={compute.error} />}
            {remind.isError && <ErrorNotice error={remind.error} />}
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
