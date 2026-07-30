import { useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ArticleIcon from '@mui/icons-material/ArticleRounded';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesomeRounded';
import PublishIcon from '@mui/icons-material/PublishRounded';
import UndoIcon from '@mui/icons-material/UndoRounded';
import {
  useDraftRecap,
  useLeagueOverview,
  usePublishRecap,
  useRecaps,
  useSession,
} from '../hooks.js';
import type { LeagueRecap } from '../api/client.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { useNotify } from '../components/SnackbarProvider.js';
import { EmptyState, PageHeader, RelativeTime, SectionHeader } from '../components/primitives.js';

/**
 * Weekly recaps.
 *
 * Every number in a recap is computed by the portal, in code, from live Yahoo data.
 * When prose generation is switched on, the model is given only that finished fact
 * pack and asked to write sentences — it never calculates a score, a ranking, or a
 * winner, because it is never given the raw data or the question.
 *
 * The facts are shown alongside the prose deliberately. A commissioner reviewing a
 * draft can check every claim against the list that produced it, which is the only
 * way to be confident before publishing something a model wrote.
 */
export function RecapsPage(): JSX.Element {
  const session = useSession();
  const overview = useLeagueOverview(true);
  const seasonYear =
    overview.data?.yahoo?.seasonYear ?? overview.data?.league.currentSeasonYear ?? null;

  const recaps = useRecaps(seasonYear);
  const draft = useDraftRecap(seasonYear);
  const notify = useNotify();

  const isCommissioner = session.data?.user?.role === 'commissioner';
  const currentWeek = overview.data?.yahoo?.currentWeek ?? null;

  if (recaps.isLoading || overview.isLoading) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Recaps" />
        <Skeleton height={320} sx={{ borderRadius: 4 }} />
      </Stack>
    );
  }

  if (recaps.isError) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Recaps" />
        <ErrorNotice error={recaps.error} onRetry={() => void recaps.refetch()} />
      </Stack>
    );
  }

  const list = recaps.data?.recaps ?? [];
  const drafts = list.filter((recap) => recap.status !== 'published');
  const published = list.filter((recap) => recap.status === 'published');

  // The week to offer drafting: the one just finished.
  const draftableWeek = currentWeek === null ? null : Math.max(1, currentWeek - 1);

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Recaps"
        description={seasonYear ? `${seasonYear} season` : undefined}
        action={
          isCommissioner && draftableWeek !== null ? (
            <Tooltip
              title={`Builds the week ${draftableWeek} recap now instead of waiting for Tuesday`}
            >
              <span>
                <Button
                  variant="contained"
                  startIcon={<ArticleIcon />}
                  disabled={draft.isPending}
                  onClick={() =>
                    draft.mutate(draftableWeek, {
                      onSuccess: () =>
                        notify(`Drafted the week ${draftableWeek} recap.`, 'success'),
                      onError: (error) => notify(error.message, 'error'),
                    })
                  }
                >
                  {draft.isPending ? 'Drafting…' : `Draft week ${draftableWeek}`}
                </Button>
              </span>
            </Tooltip>
          ) : undefined
        }
      />

      {list.length === 0 ? (
        <EmptyState
          icon={<ArticleIcon />}
          title="No recaps yet"
          description={
            isCommissioner
              ? 'A recap is drafted automatically each Tuesday once the week has been played. You read it, then decide whether to publish.'
              : 'Your commissioner publishes these once a week has been played.'
          }
        />
      ) : (
        <>
          {isCommissioner && drafts.length > 0 && (
            <Box>
              <SectionHeader title="Waiting for you" count={drafts.length} />
              <Stack spacing={1.5}>
                {drafts.map((recap) => (
                  <RecapCard
                    key={recap.recapId}
                    recap={recap}
                    seasonYear={seasonYear ?? 0}
                    isCommissioner={isCommissioner}
                  />
                ))}
              </Stack>
            </Box>
          )}

          {published.length > 0 && (
            <Box>
              <SectionHeader title="Published" count={published.length} />
              <Stack spacing={1.5}>
                {published.map((recap) => (
                  <RecapCard
                    key={recap.recapId}
                    recap={recap}
                    seasonYear={seasonYear ?? 0}
                    isCommissioner={isCommissioner}
                  />
                ))}
              </Stack>
            </Box>
          )}
        </>
      )}

      {draft.isError && <ErrorNotice error={draft.error} hideRetry />}

      <Typography variant="caption" color="text.secondary">
        {recaps.data?.note ??
          'Publishing shows a recap in the portal. Nothing is emailed or texted.'}
      </Typography>
    </Stack>
  );
}

function RecapCard({
  recap,
  seasonYear,
  isCommissioner,
}: {
  recap: LeagueRecap;
  seasonYear: number;
  isCommissioner: boolean;
}): JSX.Element {
  const publish = usePublishRecap(seasonYear);
  const notify = useNotify();

  /**
   * Starts from the model's prose when there is any, otherwise the template.
   *
   * Editable on purpose: a commissioner correcting a turn of phrase should not have
   * to work around the draft, and the edit is what gets published.
   */
  const [text, setText] = useState(recap.proseBody ?? recap.templateBody);
  const [editing, setEditing] = useState(false);

  const isDraft = recap.status !== 'published';

  return (
    <Card
      sx={{
        borderLeft: 4,
        borderLeftColor: isDraft ? 'warning.main' : 'success.main',
      }}
    >
      <CardContent>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              Week {recap.week}
            </Typography>
            <Chip
              size="small"
              color={isDraft ? 'warning' : 'success'}
              label={isDraft ? 'draft' : 'published'}
            />
            {recap.proseBody !== null && (
              <Tooltip
                title={`Written by ${recap.proseModel ?? 'a model'} from the facts below. It computed nothing.`}
              >
                <Chip
                  size="small"
                  variant="outlined"
                  icon={<AutoAwesomeIcon />}
                  label="model prose"
                />
              </Tooltip>
            )}
            <Box sx={{ flexGrow: 1 }} />
            <Typography variant="caption" color="text.secondary">
              <RelativeTime
                value={recap.publishedAt ?? recap.updatedAt ?? recap.createdAt}
                underline={false}
              />
            </Typography>
          </Stack>

          {editing ? (
            <TextField
              multiline
              minRows={6}
              value={text}
              onChange={(event) => setText(event.target.value)}
              helperText="Your edit is what gets published."
            />
          ) : (
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
              {recap.proseBody ?? recap.templateBody}
            </Typography>
          )}

          {/*
            The fact pack, shown next to the prose.
            This is what makes reviewing model-written text possible rather than an
            act of faith: every claim above should be checkable against this list.
          */}
          {recap.facts.length > 0 && (
            <>
              <Divider />
              <Box>
                <Typography
                  variant="caption"
                  sx={{
                    color: 'text.secondary',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    fontWeight: 700,
                  }}
                >
                  The facts it was given
                </Typography>
                <Stack spacing={0.25} sx={{ mt: 0.5 }}>
                  {recap.facts.map((fact) => (
                    <Typography variant="caption" color="text.secondary" key={fact.key}>
                      <strong>{fact.label}:</strong> {fact.value}
                    </Typography>
                  ))}
                </Stack>
              </Box>
            </>
          )}

          {isCommissioner && (
            <Stack direction="row" spacing={1} sx={{ pt: 0.5 }} flexWrap="wrap" useFlexGap>
              <Button
                size="small"
                onClick={(event) => {
                  event.currentTarget.blur();
                  setEditing((previous) => !previous);
                }}
              >
                {editing ? 'Stop editing' : 'Edit'}
              </Button>

              {isDraft ? (
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<PublishIcon />}
                  disabled={publish.isPending}
                  onClick={() =>
                    publish.mutate(
                      { week: recap.week, body: text, publish: true },
                      {
                        onSuccess: () =>
                          notify(`Published the week ${recap.week} recap.`, 'success'),
                        onError: (error) => notify(error.message, 'error'),
                      },
                    )
                  }
                >
                  {publish.isPending ? 'Publishing…' : 'Publish'}
                </Button>
              ) : (
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<UndoIcon />}
                  disabled={publish.isPending}
                  onClick={() =>
                    publish.mutate(
                      { week: recap.week, publish: false },
                      {
                        onSuccess: () => notify('Sent back to draft.', 'success'),
                        onError: (error) => notify(error.message, 'error'),
                      },
                    )
                  }
                >
                  Unpublish
                </Button>
              )}
            </Stack>
          )}

          {isDraft && isCommissioner && (
            <Alert severity="info">
              <AlertTitle>Read it before publishing</AlertTitle>
              Every number came from the portal&rsquo;s own arithmetic. The wording, if a model
              wrote it, has not been checked by anyone yet.
            </Alert>
          )}

          {publish.isError && <ErrorNotice error={publish.error} hideRetry />}
        </Stack>
      </CardContent>
    </Card>
  );
}
