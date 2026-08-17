'use client';

import * as React from 'react';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Select } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * The production pipeline for one post (SRS §11).
 *
 * An agency's real work is not "write a post" — it is brief, copy, design,
 * review, schedule, each with an owner and a state. This is that list.
 *
 * **A task never moves the post.** The state machine is the only thing that
 * writes a status. What a task can do is *hold* one: a blocking task that is not
 * DONE stops the post leaving DRAFT, and the transition refuses with the stages
 * still open. That refusal is deliberate — a pipeline that silently advanced a
 * post would be a second state machine, and there is exactly one.
 */

export interface ProductionTask {
  id: string;
  stage: string;
  state: string;
  assigneeId: string | null;
  dueAt: string | null;
  blocking: boolean;
  assignee: { id: string; name: string | null; email: string } | null;
}

export interface TaskMember {
  id: string;
  name: string | null;
  email: string;
}

export interface TaskPanelProps {
  orgSlug: string;
  postId: string;
  tasks: ProductionTask[];
  members: TaskMember[];
  canManage: boolean;
  canUpdate: boolean;
}

const STAGES = [
  'IDEA',
  'COPYWRITING',
  'DESIGN',
  'INTERNAL_REVIEW',
  'CLIENT_REVIEW',
  'SCHEDULING',
] as const;

const STATES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE'] as const;

const STATE_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'success'> = {
  TODO: 'neutral',
  IN_PROGRESS: 'info',
  BLOCKED: 'warning',
  DONE: 'success',
};

const label = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');

export function TaskPanel({
  orgSlug,
  postId,
  tasks: initial,
  members,
  canManage,
  canUpdate,
}: TaskPanelProps) {
  const [tasks, setTasks] = React.useState(initial);
  const [adding, setAdding] = React.useState(false);
  const [stage, setStage] = React.useState<string>(STAGES[0]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const base = `/api/v1/orgs/${encodeURIComponent(orgSlug)}`;

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  const add = () =>
    run('add', async () => {
      const { task } = await apiRequest<{ task: ProductionTask }>(`${base}/posts/${postId}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ stage, blocking: false }),
      });
      setTasks((current) => [...current, task]);
      setAdding(false);
    });

  const patch = (id: string, body: Record<string, unknown>) =>
    run(id, async () => {
      const { task } = await apiRequest<{ task: ProductionTask }>(`${base}/tasks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setTasks((current) => current.map((item) => (item.id === id ? task : item)));
    });

  const remove = (id: string) =>
    run(id, async () => {
      await apiRequest<void>(`${base}/tasks/${id}`, { method: 'DELETE' });
      setTasks((current) => current.filter((item) => item.id !== id));
    });

  const used = new Set(tasks.map((task) => task.stage));
  const available = STAGES.filter((candidate) => !used.has(candidate));
  const openBlockers = tasks.filter((task) => task.blocking && task.state !== 'DONE');

  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-2">
        <CardTitle>Production</CardTitle>
        {openBlockers.length > 0 ? (
          <Badge tone="warning">
            {openBlockers.length} blocking {openBlockers.length === 1 ? 'task' : 'tasks'}
          </Badge>
        ) : null}
      </CardHeader>

      <CardBody className="space-y-3">
        {tasks.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No stages yet. Add one to track who is doing what before this goes for review.
          </p>
        ) : (
          <ul className="space-y-2">
            {tasks.map((task) => (
              <li
                key={task.id}
                className="flex flex-wrap items-center gap-2 rounded border border-line px-3 py-2"
              >
                <span className="min-w-28 text-sm font-medium text-ink">{label(task.stage)}</span>

                <Badge tone={STATE_TONE[task.state] ?? 'neutral'}>{label(task.state)}</Badge>

                <Select
                  aria-label={`${label(task.stage)} state`}
                  className="h-8 w-auto"
                  value={task.state}
                  disabled={!canUpdate || busy === task.id}
                  onChange={(event) => void patch(task.id, { state: event.target.value })}
                >
                  {STATES.map((value) => (
                    <option key={value} value={value}>
                      {label(value)}
                    </option>
                  ))}
                </Select>

                <Select
                  aria-label={`${label(task.stage)} assignee`}
                  className="h-8 w-auto"
                  value={task.assigneeId ?? ''}
                  disabled={!canUpdate || busy === task.id}
                  onChange={(event) =>
                    void patch(task.id, { assigneeId: event.target.value || null })
                  }
                >
                  <option value="">Unassigned</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name ?? member.email}
                    </option>
                  ))}
                </Select>

                {canManage ? (
                  <>
                    <label className="flex items-center gap-1.5 text-xs text-ink-muted">
                      <input
                        type="checkbox"
                        checked={task.blocking}
                        disabled={busy === task.id}
                        onChange={(event) =>
                          void patch(task.id, { blocking: event.target.checked })
                        }
                      />
                      Blocks review
                    </label>

                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      disabled={busy === task.id}
                      onClick={() => void remove(task.id)}
                    >
                      Remove
                    </Button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}

        {canManage && available.length > 0 ? (
          adding ? (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="Stage"
                className="w-auto"
                value={stage}
                onChange={(event) => setStage(event.target.value)}
              >
                {available.map((value) => (
                  <option key={value} value={value}>
                    {label(value)}
                  </option>
                ))}
              </Select>
              <Button size="sm" loading={busy === 'add'} onClick={() => void add()}>
                Add stage
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setStage(available[0] as string);
                setAdding(true);
              }}
            >
              Add a stage
            </Button>
          )
        ) : null}
      </CardBody>
    </Card>
  );
}
