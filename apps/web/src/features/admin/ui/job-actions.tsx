'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Textarea } from '@orbit/ui';
import { ApiError } from '@/features/posts/ui/api';

/**
 * Acting on a dead letter (SRS §28, T1.18 DoD).
 *
 * The reason box is not a nicety and is deliberately in the way: this is an AHN
 * employee touching a customer's operational data, and the row it writes lands
 * in **that customer's** audit log. Someone will read it later, possibly the
 * customer.
 *
 * So the buttons stay disabled until a reason exists, rather than being pressed
 * and then rejected — the server enforces the same rule, but discovering it
 * after the fact is how people learn to paste "fix" into the box.
 */

export interface JobActionsProps {
  jobId: string;
  /** False for `publish` (decision D-045) and for a payload that never parsed. */
  retryable: boolean;
}

export function JobActions({ jobId, retryable }: JobActionsProps) {
  const router = useRouter();
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState<'retry' | 'discard' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  const ready = reason.trim().length >= 8;

  async function act(action: 'retry' | 'discard') {
    if (!ready) return;

    setBusy(action);
    setError(null);

    try {
      const response = await fetch(`/api/v1/admin/jobs/${encodeURIComponent(jobId)}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const envelope =
          body && typeof body === 'object' && 'error' in body
            ? (body as { error: ConstructorParameters<typeof ApiError>[1] }).error
            : {};
        throw new ApiError(response.status, envelope);
      }

      setDone(action === 'retry' ? 'Re-enqueued.' : 'Discarded.');
      setReason('');
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be done.');
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return <p className="text-sm font-medium text-success">{done}</p>;
  }

  return (
    <div className="space-y-2">
      <Field
        label="Reason"
        htmlFor={`reason-${jobId}`}
        required
        hint="Written to the customer's own audit trail, with your name on it."
      >
        <Textarea
          id={`reason-${jobId}`}
          rows={2}
          value={reason}
          disabled={busy !== null}
          placeholder="Transient S3 outage during the incident on the 14th — ticket OPS-812."
          onChange={(e) => {
            setReason(e.target.value);
          }}
        />
      </Field>

      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {retryable ? (
          <Button
            size="sm"
            loading={busy === 'retry'}
            disabled={!ready || busy !== null}
            onClick={() => void act('retry')}
          >
            Re-enqueue
          </Button>
        ) : (
          <p className="text-xs text-ink-muted">
            Not retried from here — publishing is retried from the organization&rsquo;s own
            publishing log, so it goes through the same checks as any other publish.
          </p>
        )}

        <Button
          size="sm"
          variant="secondary"
          loading={busy === 'discard'}
          disabled={!ready || busy !== null}
          onClick={() => void act('discard')}
        >
          Discard
        </Button>
      </div>
    </div>
  );
}
