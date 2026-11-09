'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, ConfirmDialog, Field, Textarea, useToast } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * Asking for a plan, and taking the request back (D-116).
 *
 * Rendered only for the Owner, who alone holds `billing:manage`; the API
 * refuses everybody else. Asking changes nothing yet, and the dialog says so:
 * AHN arranges payment first and an administrator switches the plan.
 */

const endpoint = (orgSlug: string) =>
  `/api/v1/orgs/${encodeURIComponent(orgSlug)}/billing/plan-request`;

export function RequestPlanButton({
  orgSlug,
  planId,
  planName,
}: {
  orgSlug: string;
  planId: string;
  planName: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const noteId = `plan-note-${planId}`;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const trimmed = note.trim();
      await apiRequest(endpoint(orgSlug), {
        method: 'POST',
        body: JSON.stringify({ plan: planId, ...(trimmed ? { note: trimmed } : {}) }),
      });
      toast.show(`Request for ${planName} sent. AHN will be in touch.`);
      setOpen(false);
      setNote('');
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The request could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Request {planName}
      </Button>
      <ConfirmDialog
        open={open}
        busy={busy}
        onClose={() => {
          setOpen(false);
          setError(null);
        }}
        onConfirm={submit}
        title={`Request ${planName}?`}
        description="AHN will contact you to arrange payment, then switch your plan. Nothing changes until then."
        confirmLabel="Send request"
      >
        <div className="space-y-3">
          <Field
            label="Note for AHN"
            htmlFor={noteId}
            hint="Optional. Who to contact, or how you would like to pay."
          >
            <Textarea
              id={noteId}
              rows={3}
              maxLength={500}
              value={note}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          {error ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </ConfirmDialog>
    </>
  );
}

export function WithdrawPlanRequestButton({
  orgSlug,
  planName,
}: {
  orgSlug: string;
  planName: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function withdraw() {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(endpoint(orgSlug), { method: 'DELETE' });
      toast.show(`Request for ${planName} withdrawn.`);
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The request could not be withdrawn.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Withdraw
      </Button>
      <ConfirmDialog
        open={open}
        busy={busy}
        onClose={() => {
          setOpen(false);
          setError(null);
        }}
        onConfirm={withdraw}
        title={`Withdraw the request for ${planName}?`}
        description="Your plan stays as it is. You can ask again at any time."
        confirmLabel="Withdraw request"
      >
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
