import { useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
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
import ChecklistIcon from '@mui/icons-material/ChecklistRounded';
import AddIcon from '@mui/icons-material/AddRounded';
import { useCreateTask, useTasks, useUpdateTaskStatus } from '../hooks.js';
import type { CommissionerTask } from '../api/client.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { useNotify } from '../components/SnackbarProvider.js';
import { EmptyState, PageHeader, SectionHeader } from '../components/primitives.js';

const CATEGORIES = [
  'dues',
  'payouts',
  'draft',
  'challenges',
  'yahoo_connection',
  'import',
  'announcement',
  'other',
] as const;

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

const PRIORITY_COLOR: Record<string, 'default' | 'info' | 'warning' | 'error'> = {
  low: 'default',
  normal: 'info',
  high: 'warning',
  urgent: 'error',
};

/**
 * The commissioner's own to-do list.
 *
 * Deliberately manual. The portal does not invent tasks from what it notices — a
 * list that fills itself with guesses stops being read, and then the one item that
 * mattered gets missed with everything else.
 */
export function TasksPage(): JSX.Element {
  const tasks = useTasks();
  const update = useUpdateTaskStatus();
  const notify = useNotify();
  const [adding, setAdding] = useState(false);

  if (tasks.isLoading) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Commissioner tasks" />
        <Skeleton height={280} sx={{ borderRadius: 4 }} />
      </Stack>
    );
  }

  if (tasks.isError) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Commissioner tasks" />
        <ErrorNotice error={tasks.error} onRetry={() => void tasks.refetch()} />
      </Stack>
    );
  }

  const all = tasks.data?.tasks ?? [];
  const open = all.filter((task) => task.status === 'open' || task.status === 'in_progress');
  const closed = all.filter((task) => task.status === 'done' || task.status === 'dismissed');

  const toggle = (task: CommissionerTask): void => {
    const next = task.status === 'done' ? 'open' : 'done';
    update.mutate(
      { taskId: task.taskId, status: next },
      { onError: (error) => notify(error.message, 'error') },
    );
  };

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Commissioner tasks"
        description={open.length === 0 ? 'Nothing outstanding' : `${open.length} outstanding`}
        action={
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={(event) => {
              event.currentTarget.blur();
              setAdding(true);
            }}
          >
            Add a task
          </Button>
        }
      />

      {all.length === 0 ? (
        <EmptyState
          icon={<ChecklistIcon />}
          title="No tasks yet"
          description="Keep the running list of things the league needs from you — collecting dues, chasing a draft pick, posting a recap."
          action={
            <Button variant="contained" onClick={() => setAdding(true)}>
              Add the first one
            </Button>
          }
        />
      ) : (
        <>
          {open.length > 0 && (
            <Box>
              <SectionHeader title="Outstanding" count={open.length} />
              <Card>
                <CardContent sx={{ py: 0.5 }}>
                  <Stack divider={<Divider flexItem />}>
                    {open.map((task) => (
                      <TaskRow key={task.taskId} task={task} onToggle={() => toggle(task)} />
                    ))}
                  </Stack>
                </CardContent>
              </Card>
            </Box>
          )}

          {closed.length > 0 && (
            <Box>
              <SectionHeader title="Done" count={closed.length} />
              <Card sx={{ bgcolor: 'background.surfaceContainerLow' }}>
                <CardContent sx={{ py: 0.5 }}>
                  <Stack divider={<Divider flexItem />}>
                    {closed.map((task) => (
                      <TaskRow key={task.taskId} task={task} onToggle={() => toggle(task)} />
                    ))}
                  </Stack>
                </CardContent>
              </Card>
            </Box>
          )}
        </>
      )}

      <AddTaskDialog open={adding} onClose={() => setAdding(false)} />
    </Stack>
  );
}

function TaskRow({
  task,
  onToggle,
}: {
  task: CommissionerTask;
  onToggle: () => void;
}): JSX.Element {
  const done = task.status === 'done' || task.status === 'dismissed';

  return (
    <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ py: 0.75 }}>
      <Tooltip title={done ? 'Reopen' : 'Mark done'}>
        <Checkbox checked={done} onChange={onToggle} sx={{ mt: -0.25 }} />
      </Tooltip>

      <Box sx={{ flexGrow: 1, minWidth: 0, pt: 1 }}>
        <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography
            variant="body2"
            sx={{
              fontWeight: 600,
              textDecoration: done ? 'line-through' : 'none',
              color: done ? 'text.secondary' : 'text.primary',
            }}
          >
            {task.title}
          </Typography>

          {!done && task.priority !== 'normal' && (
            <Chip
              size="small"
              variant="outlined"
              color={PRIORITY_COLOR[task.priority] ?? 'default'}
              label={task.priority}
            />
          )}
          <Chip size="small" variant="outlined" label={task.category.replace(/_/g, ' ')} />
          {task.dueDate && !done && (
            <Typography variant="caption" color="text.secondary">
              due {task.dueDate}
            </Typography>
          )}
        </Stack>

        {task.detail && (
          <Typography variant="caption" color="text.secondary" display="block">
            {task.detail}
          </Typography>
        )}
      </Box>
    </Stack>
  );
}

function AddTaskDialog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const create = useCreateTask();
  const notify = useNotify();

  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [category, setCategory] = useState<string>('other');
  const [priority, setPriority] = useState<string>('normal');
  const [dueDate, setDueDate] = useState('');

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Add a task</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <TextField
            label="What needs doing"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />

          <Stack direction="row" spacing={1.5}>
            <FormControl size="small" fullWidth>
              <InputLabel id="task-category">Category</InputLabel>
              <Select
                labelId="task-category"
                label="Category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                {CATEGORIES.map((option) => (
                  <MenuItem key={option} value={option}>
                    {option.replace(/_/g, ' ')}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" fullWidth>
              <InputLabel id="task-priority">Priority</InputLabel>
              <Select
                labelId="task-priority"
                label="Priority"
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
              >
                {PRIORITIES.map((option) => (
                  <MenuItem key={option} value={option}>
                    {option}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>

          <TextField
            size="small"
            label="Due date"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            InputLabelProps={{ shrink: true }}
          />

          <TextField
            label="Detail"
            multiline
            minRows={2}
            value={detail}
            onChange={(event) => setDetail(event.target.value)}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={title.trim().length === 0 || create.isPending}
          onClick={() =>
            create.mutate(
              {
                title: title.trim(),
                category,
                priority,
                ...(detail.trim() ? { detail: detail.trim() } : {}),
                ...(dueDate ? { dueDate } : {}),
              },
              {
                onSuccess: () => {
                  notify('Task added.', 'success');
                  setTitle('');
                  setDetail('');
                  setDueDate('');
                  onClose();
                },
                onError: (error) => notify(error.message, 'error'),
              },
            )
          }
        >
          {create.isPending ? 'Adding…' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
