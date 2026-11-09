'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Textarea } from '@orbit/ui';
import { ApiError } from '@/features/posts/ui/api';

/**
 * Answering a plan change request (D-116).
 *
 * Approving applies the plan the organization asked for, with that plan's
 * limits from the catalogue. The reason is required, as for every admin action
 * on a tenant, and lands in the organization's own audit trail with the
 * administrator's name on it, so the buttons stay disabled until there is one.
 */
export function PlanRequestActions({
  requestId,
  planName,
}: {
  requestId: string;
  planName: string;
}) {
  const router = useRouter();
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState<'APPROVE' | 'DECLINE' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  const ready = reason.trim().length >= 8;
  const fieldId = `plan-reason-${requestId}`;

  async function decide(decision: 'APPROVE' | 'DECLINE') {
    if (!ready) return;
    setBusy(decision);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/admin/plan-requests/${encodeURIComponent(requestId)}/decision`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision, reason: reason.trim() }),
        },
      );

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const envelope =
          body && typeof body === 'object' && 'error' in body
            ? (body as { error: ConstructorParameters<typeof ApiError>[1] }).error
            : {};
        throw new ApiError(response.status, envelope);
      }

      setDone(decision === 'APPROVE' ? `Moved to ${planName}.` : 'Declined.');
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be done.');
    } finally {
      setBusy(null);
    }
  }

  if (done) return <p className="text-sm font-medium text-success">{done}</p>;

  return (
    <div className="space-y-2">
      <Field
        label="Reason"
        htmlFor={fieldId}
        required
        hint="Written to the customer's own audit trail, with your name on it."
      >
        <Textarea
          id={fieldId}
          rows={2}
          value={reason}
          disabled={busy !== null}
          placeholder="Paid by bank transfer on 9 Nov, invoice INV-0142."
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>

      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          loading={busy === 'APPROVE'}
          disabled={!ready || busy !== null}
          onClick={() => void decide('APPROVE')}
        >
          Approve and switch to {planName}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={busy === 'DECLINE'}
          disabled={!ready || busy !== null}
          onClick={() => void decide('DECLINE')}
        >
          Decline
        </Button>
      </div>
    </div>
  );
}
