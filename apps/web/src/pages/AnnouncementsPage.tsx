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
  FormControlLabel,
  Skeleton,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import CampaignIcon from '@mui/icons-material/CampaignRounded';
import PushPinIcon from '@mui/icons-material/PushPinRounded';
import AddIcon from '@mui/icons-material/AddRounded';
import { useAnnouncements, useCreateAnnouncement, useSession } from '../hooks.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { useNotify } from '../components/SnackbarProvider.js';
import { EmptyState, PageHeader, RelativeTime } from '../components/primitives.js';

/**
 * League announcements.
 *
 * Publishing makes an announcement visible in the portal and does nothing else. No
 * email, no SMS, no push — and the UI says so plainly, because a commissioner who
 * believes a message went out will not tell anyone themselves.
 */
export function AnnouncementsPage(): JSX.Element {
  const session = useSession();
  const announcements = useAnnouncements();
  const [composing, setComposing] = useState(false);

  const isCommissioner = session.data?.user?.role === 'commissioner';

  if (announcements.isLoading) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Announcements" />
        <Skeleton height={280} sx={{ borderRadius: 4 }} />
      </Stack>
    );
  }

  if (announcements.isError) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Announcements" />
        <ErrorNotice error={announcements.error} onRetry={() => void announcements.refetch()} />
      </Stack>
    );
  }

  const all = announcements.data?.announcements ?? [];

  // Pinned first, then newest. A pinned notice is pinned because it still matters.
  const ordered = [...all].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt);
  });

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Announcements"
        action={
          isCommissioner ? (
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={(event) => {
                event.currentTarget.blur();
                setComposing(true);
              }}
            >
              Write one
            </Button>
          ) : undefined
        }
      />

      {ordered.length === 0 ? (
        <EmptyState
          icon={<CampaignIcon />}
          title="Nothing announced yet"
          description={
            isCommissioner
              ? 'Post league news here. Publishing shows it in the portal — it does not send anything, so tell people it is here.'
              : 'Your commissioner has not posted anything yet.'
          }
          {...(isCommissioner
            ? {
                action: (
                  <Button variant="contained" onClick={() => setComposing(true)}>
                    Write the first one
                  </Button>
                ),
              }
            : {})}
        />
      ) : (
        <Stack spacing={1.5}>
          {ordered.map((announcement) => (
            <Card
              key={announcement.announcementId}
              sx={{
                ...(announcement.pinned
                  ? { borderColor: 'primary.main', bgcolor: 'background.surfaceContainerHigh' }
                  : {}),
              }}
            >
              <CardContent>
                <Stack spacing={1}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    {announcement.pinned && (
                      <PushPinIcon sx={{ fontSize: 16, color: 'primary.main' }} />
                    )}
                    <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                      {announcement.title}
                    </Typography>
                    {announcement.status === 'draft' && (
                      <Chip size="small" variant="outlined" color="warning" label="draft" />
                    )}
                    <Box sx={{ flexGrow: 1 }} />
                    <Typography variant="caption" color="text.secondary">
                      <RelativeTime
                        value={announcement.publishedAt ?? announcement.createdAt}
                        underline={false}
                      />
                    </Typography>
                  </Stack>

                  {/* Plain text, deliberately: rendering member-authored markup would
                      be an injection surface for no real gain. */}
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                    {announcement.body}
                  </Typography>
                </Stack>
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}

      <ComposeDialog open={composing} onClose={() => setComposing(false)} />
    </Stack>
  );
}

function ComposeDialog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const create = useCreateAnnouncement();
  const notify = useNotify();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);

  const canSubmit = title.trim().length > 0 && body.trim().length > 0;

  const submit = (publish: boolean): void => {
    create.mutate(
      { title: title.trim(), body: body.trim(), publish, pinned },
      {
        onSuccess: () => {
          notify(publish ? 'Published.' : 'Saved as a draft.', 'success');
          setTitle('');
          setBody('');
          setPinned(false);
          onClose();
        },
        onError: (error) => notify(error.message, 'error'),
      },
    );
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>New announcement</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <TextField
            label="Title"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <TextField
            label="What you want to say"
            required
            multiline
            minRows={5}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <FormControlLabel
            control={
              <Switch checked={pinned} onChange={(event) => setPinned(event.target.checked)} />
            }
            label="Pin to the top"
          />

          <Alert severity="info">
            Publishing shows this in the portal. It sends no email or text, so let people know it is
            here.
          </Alert>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button disabled={!canSubmit || create.isPending} onClick={() => submit(false)}>
          Save draft
        </Button>
        <Button
          variant="contained"
          disabled={!canSubmit || create.isPending}
          onClick={() => submit(true)}
        >
          {create.isPending ? 'Saving…' : 'Publish'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
