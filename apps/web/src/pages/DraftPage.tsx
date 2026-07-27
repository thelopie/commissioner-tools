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
  Divider,
  GlobalStyles,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid2';
import { Link as RouterLink } from 'react-router-dom';
import FormatListNumberedIcon from '@mui/icons-material/FormatListNumberedRounded';
import PrintIcon from '@mui/icons-material/PrintRounded';
import LockIcon from '@mui/icons-material/LockRounded';
import HourglassIcon from '@mui/icons-material/HourglassEmptyRounded';
import { useDraftStatus, useLeagueOverview, useSelectDraftPosition, useSession } from '../hooks.js';
import type { DraftStatusResponse } from '../api/client.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { EmptyState, Monogram, PageHeader, SectionHeader } from '../components/primitives.js';

/**
 * The draft-order board.
 *
 * Selection order is who CHOOSES first, not who drafts first — the manager whose
 * LLWS team went furthest picks first and may well take slot six. That distinction
 * confuses everyone the first time, so the page says it rather than assuming it.
 *
 * The workflow ends in a printable order the commissioner types into Yahoo by hand.
 * No Yahoo endpoint sets draft order, so there is no button here that claims to.
 */
export function DraftPage(): JSX.Element {
  const session = useSession();
  const overview = useLeagueOverview(true);
  const seasonYear = overview.data?.league?.currentSeasonYear ?? null;

  const status = useDraftStatus(seasonYear);
  const select = useSelectDraftPosition(seasonYear);

  const [pending, setPending] = useState<number | null>(null);

  /** Set when a commissioner is choosing on someone else's behalf. */
  const [pickingFor, setPickingFor] = useState<{
    leagueMemberId: string;
    displayName: string;
  } | null>(null);

  const isCommissioner = session.data?.user?.role === 'commissioner';
  const yourTurn = status.data?.currentTurn?.isYou === true;

  if (status.isLoading || overview.isLoading) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Draft order" />
        <Skeleton height={420} sx={{ borderRadius: 4 }} />
      </Stack>
    );
  }

  if (status.isError) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Draft order" />
        <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />
      </Stack>
    );
  }

  const selections = status.data?.selections ?? [];

  if (selections.length === 0) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Draft order" />
        <EmptyState
          icon={<FormatListNumberedIcon />}
          title="The selection order has not been set yet"
          description={
            isCommissioner
              ? 'Enter the LLWS field, draw assignments, record the finishes, then compute the selection order from Commissioner tools.'
              : 'Your commissioner sets this up from the LLWS field once the tournament finishes. Nothing to do yet.'
          }
          {...(isCommissioner
            ? {
                action: (
                  <Button variant="contained" component={RouterLink} to="/commissioner/llws">
                    Open LLWS setup
                  </Button>
                ),
              }
            : {})}
        />
      </Stack>
    );
  }

  const ordered = [...selections].sort((a, b) => a.selectionOrder - b.selectionOrder);

  /**
   * Draft slots that nobody in the queue can ever claim.
   *
   * The slot count comes from the season's team count, which the Yahoo link fills in
   * from the real league. Map only some of those teams to portal members and the
   * order is permanently incomplete — the Print button stays disabled and, without
   * this, nothing on the page would say why.
   */
  const unchosen = ordered.filter((selection) => selection.chosenDraftPosition === null).length;
  const orphanSlots = Math.max(0, (status.data?.missingPositions.length ?? 0) - unchosen);

  return (
    <Stack spacing={3}>
      {/*
        Print styles live with the page that needs them. The final order is entered
        into Yahoo by hand, and a printout with a navigation rail down the side is
        useless for that.
      */}
      <GlobalStyles
        styles={{
          '@media print': {
            'header, nav, footer, .no-print': { display: 'none !important' },
            '.print-only': { display: 'block !important' },
            /*
              The app shell paints `background.default` on wrapper divs, so setting
              only `body` left a dark page behind the sheet for anyone printing from
              dark mode with background graphics enabled.
            */
            'html, body, #root, #root > *, main': { background: '#fff !important' },
            main: { padding: '0 !important' },
            /*
              Force black on white inside the printed sheet.
              A viewer in dark mode would otherwise print a near-black card with pale
              text: heavy on ink and hard to read next to a Yahoo form.
            */
            '.print-sheet, .print-sheet *': {
              background: 'transparent !important',
              color: '#000 !important',
              boxShadow: 'none !important',
              borderColor: '#bbb !important',
            },
          },
          '.print-only': { display: 'none' },
        }}
      />

      <Box className="no-print">
        <PageHeader
          title="Draft order"
          description={seasonYear ? `${seasonYear} season` : undefined}
          action={
            <Tooltip title="Print the final order for manual entry in Yahoo">
              <span>
                <Button
                  variant="outlined"
                  startIcon={<PrintIcon />}
                  onClick={() => window.print()}
                  disabled={!status.data?.complete}
                >
                  Print
                </Button>
              </span>
            </Tooltip>
          }
        />
      </Box>

      {yourTurn && (
        <Card
          className="no-print"
          sx={{ borderColor: 'primary.main', borderWidth: 2, bgcolor: 'primary.light' }}
        >
          <CardContent>
            <Stack spacing={1.5}>
              <Typography variant="h2" sx={{ color: 'primary.dark' }}>
                It&rsquo;s your turn to choose a draft slot
              </Typography>
              <Typography variant="body2" sx={{ color: 'primary.dark' }}>
                Pick the position you want in the draft. This locks immediately and cannot be
                changed without your commissioner.
              </Typography>

              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ pt: 0.5 }}>
                {(status.data?.availablePositions ?? []).map((position) => (
                  <Button
                    key={position}
                    variant="contained"
                    /*
                      Blur before opening the dialog.
                      MUI marks the app root `aria-hidden` while a modal is open. If
                      the button that opened it still holds focus at that moment, the
                      browser reports focus trapped inside hidden content — a real
                      screen-reader problem, not just a console warning.
                    */
                    onClick={(event) => {
                      event.currentTarget.blur();
                      setPending(position);
                    }}
                    sx={{ minWidth: 56 }}
                  >
                    {position}
                  </Button>
                ))}
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      )}

      {!yourTurn && status.data?.currentTurn && (
        <Alert
          severity="info"
          icon={<HourglassIcon />}
          className="no-print"
          /*
            A manager who never answers blocks everyone behind them, so the
            commissioner needs a way through. It is recorded as
            `commissioner_assigned` rather than a normal pick, and the queue shows
            that — taking somebody's choice away should be visible, not silent.
          */
          action={
            isCommissioner ? (
              <Button
                size="small"
                // Blurred first, for the same aria-hidden reason as the slot buttons.
                onClick={(event) => {
                  event.currentTarget.blur();
                  setPickingFor(status.data!.currentTurn);
                }}
              >
                Pick for them
              </Button>
            ) : undefined
          }
        >
          Waiting on <strong>{status.data.currentTurn.displayName}</strong> to choose. This page
          updates itself when they do.
        </Alert>
      )}

      {select.isError && (
        <Box className="no-print">
          <ErrorNotice error={select.error} />
        </Box>
      )}

      {orphanSlots > 0 && (
        <Alert
          severity="warning"
          className="no-print"
          action={
            isCommissioner ? (
              <Button size="small" component={RouterLink} to="/commissioner">
                Map teams
              </Button>
            ) : undefined
          }
        >
          <AlertTitle>
            {orphanSlots} draft {orphanSlots === 1 ? 'slot has' : 'slots have'} nobody to claim
            {orphanSlots === 1 ? ' it' : ' them'}
          </AlertTitle>
          The league has {status.data?.finalOrder.length} draft slots but only {ordered.length}{' '}
          managers in the queue, so the order can never finish and cannot be printed. Mapping the
          remaining Yahoo teams to portal members fixes it.
        </Alert>
      )}

      <Box className="no-print">
        <SectionHeader title="Selection queue" count={ordered.length} />
        <Card>
          <CardContent sx={{ py: 1 }}>
            <Stack divider={<Divider flexItem />}>
              {ordered.map((selection) => (
                <QueueRow
                  key={selection.leagueMemberId}
                  selection={selection}
                  isCurrent={status.data?.currentTurn?.leagueMemberId === selection.leagueMemberId}
                />
              ))}
            </Stack>
          </CardContent>
        </Card>
      </Box>

      <Box>
        <Box className="no-print">
          <SectionHeader
            title="Final draft order"
            action={
              <Chip
                size="small"
                variant="outlined"
                color={status.data?.complete ? 'success' : 'warning'}
                label={
                  status.data?.complete
                    ? 'complete'
                    : `${status.data?.missingPositions.length ?? 0} slots open`
                }
              />
            }
          />
        </Box>

        {/* The printable artefact. Deliberately plain: it gets typed into Yahoo. */}
        <Card className="print-sheet">
          <CardContent>
            <Typography variant="h2" className="print-only" sx={{ mb: 2 }}>
              {seasonYear} draft order
            </Typography>

            <Grid container spacing={1}>
              {(status.data?.finalOrder ?? []).map((entry) => (
                <Grid size={{ xs: 12, sm: 6, md: 4 }} key={entry.draftPosition}>
                  <Stack direction="row" spacing={1.5} alignItems="center" sx={{ py: 0.75 }}>
                    <Box
                      sx={{
                        width: 32,
                        height: 32,
                        flexShrink: 0,
                        display: 'grid',
                        placeItems: 'center',
                        borderRadius: 999,
                        bgcolor: entry.displayName
                          ? 'background.surfaceContainerHighest'
                          : 'transparent',
                        border: entry.displayName ? 'none' : '1px dashed',
                        borderColor: 'divider',
                        typography: 'labelMedium',
                        fontWeight: 700,
                      }}
                    >
                      {entry.draftPosition}
                    </Box>
                    <Typography
                      variant="body2"
                      noWrap
                      sx={{
                        fontWeight: entry.displayName ? 600 : 400,
                        color: entry.displayName ? 'text.primary' : 'text.secondary',
                        fontStyle: entry.displayName ? 'normal' : 'italic',
                      }}
                    >
                      {entry.displayName ?? 'not chosen yet'}
                    </Typography>
                  </Stack>
                </Grid>
              ))}
            </Grid>
          </CardContent>
        </Card>
      </Box>

      <Alert severity="info" className="no-print">
        {status.data?.note ??
          'Enter this order manually in Yahoo — no Yahoo API endpoint sets draft order.'}
      </Alert>

      <Dialog
        open={pickingFor !== null}
        onClose={() => setPickingFor(null)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Choose a slot for {pickingFor?.displayName}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            This is recorded as a commissioner decision, not their own pick, and the queue will show
            it that way.
          </DialogContentText>

          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {(status.data?.availablePositions ?? []).map((position) => (
              <Button
                key={position}
                variant="outlined"
                disabled={select.isPending}
                sx={{ minWidth: 56 }}
                onClick={() => {
                  if (!pickingFor) return;
                  /*
                    Close before mutating, not in `onSuccess`.
                    A successful pick advances the turn, which removes the button
                    that opened this dialog — so closing afterwards left MUI trying
                    to restore focus to an element that no longer existed, and it
                    fell back to a node the closing dialog had aria-hidden. Failures
                    surface in the page-level error notice instead.
                  */
                  const target = pickingFor;
                  setPickingFor(null);
                  select.mutate({
                    draftPosition: position,
                    leagueMemberId: target.leagueMemberId,
                  });
                }}
              >
                {position}
              </Button>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPickingFor(null)}>Cancel</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={pending !== null} onClose={() => setPending(null)}>
        <DialogTitle>Take draft slot {pending}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This locks slot {pending} to you straight away. Only your commissioner can change it
            afterwards, so make sure it is the one you want.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPending(null)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={select.isPending}
            onClick={() => {
              if (pending === null) return;
              // Closed first, for the same focus reason as the commissioner dialog.
              const position = pending;
              setPending(null);
              select.mutate({ draftPosition: position });
            }}
          >
            Take slot {pending}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function QueueRow({
  selection,
  isCurrent,
}: {
  selection: DraftStatusResponse['selections'][number];
  isCurrent: boolean;
}): JSX.Element {
  const locked = selection.status === 'locked' || selection.status === 'commissioner_assigned';

  return (
    <Stack
      direction="row"
      spacing={1.5}
      alignItems="center"
      sx={{
        py: 1.25,
        px: 1,
        mx: -1,
        borderRadius: 2,
        bgcolor: isCurrent ? 'background.surfaceContainerHigh' : undefined,
      }}
    >
      <Typography
        variant="body2"
        sx={{ width: 24, textAlign: 'center', color: 'text.secondary', fontWeight: 700 }}
      >
        {selection.selectionOrder}
      </Typography>

      <Monogram name={selection.displayName} size={32} />

      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
            {selection.displayName}
          </Typography>
          {isCurrent && <Chip size="small" color="primary" label="choosing now" />}
          {selection.status === 'commissioner_assigned' && (
            <Chip size="small" variant="outlined" color="warning" label="set by commissioner" />
          )}
          {selection.remindersSent > 0 && !locked && (
            <Chip
              size="small"
              variant="outlined"
              label={`${selection.remindersSent} reminder${selection.remindersSent === 1 ? '' : 's'}`}
            />
          )}
        </Stack>
        {/*
          The explanation the engine produced, shown verbatim. "Why do I pick
          fourth" is the question that starts arguments, and the answer already
          exists — hiding it would just move the argument to the group chat.
        */}
        <Typography variant="caption" color="text.secondary" display="block">
          {selection.derivedFrom.explanation}
          {selection.derivedFrom.appliedTieBreaker
            ? ` · tiebreak: ${selection.derivedFrom.appliedTieBreaker.replace(/_/g, ' ')}`
            : ''}
        </Typography>
      </Box>

      {selection.chosenDraftPosition === null ? (
        <Chip
          size="small"
          variant="outlined"
          label={selection.status === 'open' ? 'choosing' : 'waiting'}
        />
      ) : (
        <Chip
          size="small"
          icon={locked ? <LockIcon /> : undefined}
          label={`slot ${selection.chosenDraftPosition}`}
          color="success"
        />
      )}
    </Stack>
  );
}
