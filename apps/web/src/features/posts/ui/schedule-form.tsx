'use client';

import * as React from 'react';
import { Button, Field, Input } from '@orbit/ui';
import { ApiError, apiRequest } from './api';

/**
 * Choosing when an approved post goes out.
 *
 * This exists because `SCHEDULED` is the one forward step that carries data.
 * Every other transition is just a status change, so the generic transition
 * button is enough; this one needs a date, and a post that reaches `SCHEDULED`
 * without one is invisible to both the calendar and the scheduler sweep. The
 * server refuses that now — so there has to be somewhere to say when.
 *
 * The time is sent as **wall clock in the client's zone**, not converted here.
 * A wall time is what a person means ("Tuesday at 9"), and the workspace's zone
 * is what decides which instant that is (assumption C5). Converting in the
 * browser would silently use the viewer's zone instead, which is wrong for any
 * agency working across regions — and right often enough in testing to hide.
 */

export interface ScheduleFormProps {
  orgSlug: string;
  postId: string;
  /** The client's zone. Shown, because it is what the chosen time means. */
  timezone: string;
  disabled?: boolean;
  onScheduled: () => void;
}

export function ScheduleForm({
  orgSlug,
  postId,
  timezone,
  disabled,
  onScheduled,
}: ScheduleFormProps) {
  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState('');
  const [time, setTime] = React.useState('09:00');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (!open) {
    return (
      <Button className="w-full" disabled={disabled} onClick={() => setOpen(true)}>
        Schedule
      </Button>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);

    try {
      await apiRequest(`/api/v1/orgs/${encodeURIComponent(orgSlug)}/posts/${postId}/schedule`, {
        method: 'POST',
        body: JSON.stringify({
          localTime: { year, month, day, hour, minute },
        }),
      });

      setOpen(false);
      setBusy(false);
      onScheduled();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'We could not schedule this. Please try again in a moment.',
      );
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-3 rounded border border-line bg-surface-sunken p-3"
      onSubmit={(e) => void submit(e)}
    >
      <Field label="Date" htmlFor="schedule-date" required>
        <Input
          id="schedule-date"
          type="date"
          value={date}
          disabled={busy}
          onChange={(event) => setDate(event.target.value)}
        />
      </Field>

      <Field
        label="Time"
        htmlFor="schedule-time"
        required
        hint={`Read in ${timezone} — the client's time zone, not yours.`}
      >
        <Input
          id="schedule-time"
          type="time"
          value={time}
          disabled={busy}
          onChange={(event) => setTime(event.target.value)}
        />
      </Field>

      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={busy} disabled={busy || !date || !time}>
          Schedule
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
