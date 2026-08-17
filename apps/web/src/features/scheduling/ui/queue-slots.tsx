'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  Empty,
  Field,
  Input,
  Select,
  useToast,
} from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * When this client normally posts (SRS §7).
 *
 * A week of standing appointments. `useNextQueueSlot` has honoured these since
 * T1.12 with no way to create one outside a seed script, so in practice the
 * feature was invisible.
 *
 * **Laid out as a week, not a list.** The question somebody has here is "is
 * Thursday empty?", and a table sorted by day answers it at a glance where rows
 * of `dayOfWeek: 4` never would.
 *
 * **Pausing is offered before deleting**, and is the prominent control. A
 * seasonal quiet period is the common reason to stop using a slot, and pausing
 * remembers the appointment.
 */

export interface QueueSlot {
  id: string;
  dayOfWeek: number;
  localTime: string;
  timezone: string;
  isActive: boolean;
  socialAccount: { id: string; displayName: string; platform: string } | null;
}

export interface QueueSlotsProps {
  orgSlug: string;
  workspaceId: string;
  workspaceTimeZone: string;
  slots: QueueSlot[];
  accounts: Array<{ id: string; displayName: string; platform: string }>;
  canManage: boolean;
}

/** Sunday first, matching `Date.getUTCDay()` and what the scheduler expects. */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function QueueSlots({
  orgSlug,
  workspaceId,
  workspaceTimeZone,
  slots,
  accounts,
  canManage,
}: QueueSlotsProps) {
  const router = useRouter();
  const toast = useToast();

  const [deleting, setDeleting] = React.useState<QueueSlot | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const base = `/api/v1/orgs/${encodeURIComponent(orgSlug)}/queue-slots`;
  const active = slots.filter((slot) => slot.isActive);

  async function toggle(slot: QueueSlot) {
    setBusy(slot.id);
    setError(null);

    try {
      await apiRequest(`${base}/${slot.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !slot.isActive }),
      });

      toast.show(slot.isActive ? 'Slot paused.' : 'Slot resumed.');
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be changed.');
    } finally {
      setBusy(null);
    }
  }

  async function remove(slot: QueueSlot) {
    setBusy(slot.id);
    setError(null);

    try {
      await apiRequest(`${base}/${slot.id}`, { method: 'DELETE' });
      toast.show('Slot removed.');
      setDeleting(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be removed.');
      setDeleting(null);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      {slots.length > 0 && active.length === 0 ? (
        <Alert tone="warning" title="Every slot is paused">
          Posts sent to the queue have nowhere to go until at least one is resumed.
        </Alert>
      ) : null}

      {canManage ? (
        <AddSlot
          orgSlug={orgSlug}
          workspaceId={workspaceId}
          workspaceTimeZone={workspaceTimeZone}
          accounts={accounts}
        />
      ) : null}

      {slots.length === 0 ? (
        <Empty
          title="No posting times yet"
          description="Slots are the times this client normally posts. Once you have some, a post can be sent to the queue instead of given an exact time."
        />
      ) : (
        <ul className="space-y-2">
          {DAYS.map((label, day) => {
            const forDay = slots.filter((slot) => slot.dayOfWeek === day);

            return (
              <li key={label}>
                <Card>
                  <CardBody className="flex flex-wrap items-center gap-3">
                    <span className="w-24 shrink-0 text-sm font-medium text-ink">{label}</span>

                    {forDay.length === 0 ? (
                      <span className="text-sm text-ink-muted">—</span>
                    ) : (
                      <ul className="flex flex-1 flex-wrap gap-2">
                        {forDay.map((slot) => (
                          <li
                            key={slot.id}
                            className={`flex items-center gap-2 rounded border px-2 py-1 ${
                              slot.isActive
                                ? 'border-line bg-surface-sunken'
                                : 'border-dashed border-line opacity-60'
                            }`}
                          >
                            <span className="font-mono text-sm tabular-nums text-ink">
                              {slot.localTime}
                            </span>

                            {/* Only when it differs from the client's own zone —
                                otherwise it is noise on every row. */}
                            {slot.timezone !== workspaceTimeZone ? (
                              <Badge tone="info">{slot.timezone.replace(/_/g, ' ')}</Badge>
                            ) : null}

                            {slot.socialAccount ? (
                              <Badge tone="neutral">{slot.socialAccount.displayName}</Badge>
                            ) : null}

                            {!slot.isActive ? <Badge tone="warning">Paused</Badge> : null}

                            {canManage ? (
                              <>
                                <button
                                  type="button"
                                  disabled={busy !== null}
                                  onClick={() => void toggle(slot)}
                                  className="rounded px-1 text-xs text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                                >
                                  {slot.isActive ? 'Pause' : 'Resume'}
                                </button>
                                <button
                                  type="button"
                                  aria-label={`Remove ${label} ${slot.localTime}`}
                                  disabled={busy !== null}
                                  onClick={() => setDeleting(slot)}
                                  className="rounded px-1 text-xs text-ink-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                                >
                                  ×
                                </button>
                              </>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardBody>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={deleting !== null}
        busy={busy !== null}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await remove(deleting);
        }}
        title="Remove this posting time?"
        description={
          deleting ? `${DAYS[deleting.dayOfWeek]} at ${deleting.localTime} stops being used.` : ''
        }
        confirmLabel="Remove"
      >
        <p className="text-sm text-ink-secondary">
          Anything already scheduled keeps its time — a queued post is given a real time the moment
          it is queued, so nothing that was promised to this client moves.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function AddSlot({
  orgSlug,
  workspaceId,
  workspaceTimeZone,
  accounts,
}: {
  orgSlug: string;
  workspaceId: string;
  workspaceTimeZone: string;
  accounts: QueueSlotsProps['accounts'];
}) {
  const router = useRouter();
  const toast = useToast();

  const [dayOfWeek, setDayOfWeek] = React.useState('1');
  const [localTime, setLocalTime] = React.useState('09:00');
  const [accountId, setAccountId] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await apiRequest(`/api/v1/orgs/${encodeURIComponent(orgSlug)}/queue-slots`, {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          dayOfWeek: Number(dayOfWeek),
          localTime,
          ...(accountId ? { socialAccountId: accountId } : {}),
        }),
      });

      toast.show('Posting time added.');
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be added.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardBody>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => void submit(e)}>
          <Field label="Day" htmlFor="slot-day" className="min-w-[9rem]">
            <Select
              id="slot-day"
              value={dayOfWeek}
              disabled={busy}
              onChange={(event) => setDayOfWeek(event.target.value)}
            >
              {DAYS.map((label, index) => (
                <option key={label} value={String(index)}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Time"
            htmlFor="slot-time"
            hint={`In ${workspaceTimeZone.replace(/_/g, ' ')}`}
          >
            <Input
              id="slot-time"
              type="time"
              value={localTime}
              disabled={busy}
              onChange={(event) => setLocalTime(event.target.value)}
            />
          </Field>

          {accounts.length > 0 ? (
            <Field
              label="Account"
              htmlFor="slot-account"
              hint="Leave as every account unless this time is for one only."
              className="min-w-[12rem]"
            >
              <Select
                id="slot-account"
                value={accountId}
                disabled={busy}
                onChange={(event) => setAccountId(event.target.value)}
              >
                <option value="">Every account</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.displayName}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          <Button type="submit" size="sm" loading={busy} disabled={busy}>
            Add time
          </Button>
        </form>

        {error ? (
          <p role="alert" className="mt-2 text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
