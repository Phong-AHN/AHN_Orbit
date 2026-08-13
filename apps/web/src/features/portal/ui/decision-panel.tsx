'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardBody, CardHeader, CardTitle, Field, Textarea, cn } from '@orbit/ui';
import { ApiError } from '@/features/posts/ui/api';

/**
 * Where a client approves their content (SRS §21).
 *
 * Two buttons and a box. The restraint is the design: this is the one screen a
 * client will ever be asked to use, often on a phone, often by someone who does
 * not think of themselves as a user of software. Anything that is not the
 * decision competes with it.
 *
 * "Request changes" requires a note and says so before the request is sent —
 * the server enforces it too, but discovering a requirement after pressing the
 * button is how people give up.
 */

export interface DecisionPanelProps {
  postId: string;
  /** Hidden entirely once the post has moved on. */
  awaitingDecision: boolean;
}

type Decision = 'APPROVED' | 'CHANGES_REQUESTED';

export function DecisionPanel({ postId, awaitingDecision }: DecisionPanelProps) {
  const router = useRouter();
  const [choice, setChoice] = React.useState<Decision | null>(null);
  const [comment, setComment] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (!awaitingDecision) return null;

  const needsNote = choice === 'CHANGES_REQUESTED' && comment.trim().length === 0;

  async function submit(decision: Decision) {
    if (decision === 'CHANGES_REQUESTED' && comment.trim().length === 0) {
      setChoice('CHANGES_REQUESTED');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/v1/portal/posts/${postId}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
        }),
      });

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const envelope =
          body && typeof body === 'object' && 'error' in body
            ? (body as { error: ConstructorParameters<typeof ApiError>[1] }).error
            : {};
        throw new ApiError(response.status, envelope);
      }

      // The server is the record; re-fetch rather than patching local state, so
      // what the client sees next is what actually happened.
      router.refresh();
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'That could not be sent. Please try again in a moment.',
      );
      setBusy(false);
    }
  }

  return (
    <Card className="border-warning/40">
      <CardHeader>
        <CardTitle>Ready to go ahead?</CardTitle>
      </CardHeader>

      <CardBody className="space-y-4">
        <p className="text-sm text-ink-muted">
          Approve this and we will schedule it. If something is not right, tell us what to change.
        </p>

        {choice === 'CHANGES_REQUESTED' ? (
          <Field
            label="What should we change?"
            htmlFor="portal-change-note"
            required
            hint="The more specific, the faster we can turn it around."
          >
            <Textarea
              id="portal-change-note"
              rows={3}
              value={comment}
              disabled={busy}
              placeholder="Could we use the new logo, and soften the opening line?"
              onChange={(e) => {
                setComment(e.target.value);
              }}
            />
          </Field>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}

        <div className={cn('flex flex-wrap gap-2')}>
          <Button
            loading={busy && choice === 'APPROVED'}
            disabled={busy}
            onClick={() => void submit('APPROVED')}
          >
            Approve
          </Button>

          <Button
            variant="secondary"
            loading={busy && choice === 'CHANGES_REQUESTED'}
            disabled={busy || needsNote}
            onClick={() => void submit('CHANGES_REQUESTED')}
          >
            {choice === 'CHANGES_REQUESTED' ? 'Send changes' : 'Request changes'}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
