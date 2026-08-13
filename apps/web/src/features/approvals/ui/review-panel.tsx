'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { ApprovalDecision } from '@orbit/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  ErrorState,
  Field,
  PermissionDenied,
  Textarea,
  cn,
} from '@orbit/ui';
import { STATUS_LABEL } from '@/features/posts/ui/status';
import { ApiError, approvalsApi, type ApprovalRecord } from './api';

/**
 * The reviewer's decision surface, plus the post's review history.
 *
 * It shows an approve/request-changes pair only when the server said this
 * principal may decide *this* gate. That is a courtesy so the buttons are not
 * dead — the decision endpoint re-checks independently, and a client that
 * called it anyway gains nothing.
 */

export interface ReviewPanelProps {
  orgSlug: string;
  postId: string;
  /** The gate awaiting a decision, or null when the post is not in review. */
  pending: ApprovalRecord | null;
  history: ApprovalRecord[];
  /** Server-computed: may this principal answer the pending gate? */
  canDecide: boolean;
  /** Server-computed: may this principal relay a client's decision? */
  canDecideOnBehalf: boolean;
  onDecided?: () => void;
}

export function ReviewPanel(props: ReviewPanelProps) {
  const router = useRouter();
  const api = React.useMemo(() => approvalsApi(props.orgSlug), [props.orgSlug]);

  const [history, setHistory] = React.useState(props.history);
  const [pending, setPending] = React.useState(props.pending);
  const [comment, setComment] = React.useState('');
  const [onBehalfOf, setOnBehalfOf] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState<ApprovalDecision | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);

  async function decide(decision: ApprovalDecision) {
    if (!pending) return;

    setBusy(decision);
    setError(null);
    try {
      await api.decide(pending.id, {
        decision,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        ...(onBehalfOf ? { onBehalfOf: true, reason: reason.trim() } : {}),
      });

      const refreshed = await api.forPost(props.postId);
      setHistory(refreshed.approvals);
      setPending(refreshed.approvals.find((a) => a.state === 'PENDING') ?? null);
      setComment('');
      setReason('');
      setOnBehalfOf(false);
      props.onDecided?.();
    } catch (e) {
      const failure =
        e instanceof ApiError ? e : new ApiError(500, { message: 'Something went wrong.' });
      setError(failure);

      // The gate moved while this panel was on screen — someone advanced the
      // post from the composer, or from another tab. The record held here is
      // dead and every retry will fail the same way, so re-read rather than
      // leaving the reviewer pressing a button that cannot work. The error
      // stays visible; what changes is that the panel now offers the gate the
      // post is actually at.
      if (failure.code === 'INVALID_STATE_TRANSITION') {
        const refreshed = await api.forPost(props.postId).catch(() => null);
        if (refreshed) {
          setHistory(refreshed.approvals);
          setPending(refreshed.approvals.find((a) => a.state === 'PENDING') ?? null);
        }
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  // Asking for changes without saying what to change is not a review — the
  // server enforces this too, but blocking here saves a round trip.
  const changesBlocked = comment.trim().length === 0;
  const behalfBlocked = onBehalfOf && reason.trim().length === 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex items-center justify-between gap-3">
          <CardTitle>Review</CardTitle>
          {pending ? (
            <Badge tone={pending.stage === 'CLIENT' ? 'info' : 'accent'}>
              {pending.stage === 'CLIENT' ? 'With client' : 'Internal'} · round {pending.round}
            </Badge>
          ) : null}
        </CardHeader>

        <CardBody className="space-y-4">
          {!pending ? (
            <p className="text-sm text-ink-muted">
              This post isn't waiting on a decision. Submit it for review to start one.
            </p>
          ) : !props.canDecide ? (
            <PermissionDenied
              action="decide this review"
              description="This is waiting on someone else. You'll see it here once it moves on."
            />
          ) : (
            <>
              {error ? (
                error.isPermissionDenied ? (
                  <PermissionDenied action="decide this review" description={error.message} />
                ) : (
                  <ErrorState
                    title="That didn't go through"
                    description={error.message}
                    {...(error.correlationId ? { correlationId: error.correlationId } : {})}
                  />
                )
              ) : null}

              <Field
                label="Comment"
                htmlFor="review-comment"
                hint="Required when asking for changes."
              >
                <Textarea
                  id="review-comment"
                  rows={4}
                  value={comment}
                  disabled={busy !== null}
                  placeholder="What did you think?"
                  onChange={(e) => {
                    setComment(e.target.value);
                  }}
                />
              </Field>

              {props.canDecideOnBehalf && pending.stage === 'CLIENT' ? (
                <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
                  <label className="flex items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 accent-accent"
                      checked={onBehalfOf}
                      disabled={busy !== null}
                      onChange={(e) => {
                        setOnBehalfOf(e.target.checked);
                      }}
                    />
                    <span>
                      <span className="font-medium text-ink">Recording the client's decision</span>
                      <span className="block text-xs text-ink-muted">
                        They approved by phone or email. This is logged as recorded on their behalf.
                      </span>
                    </span>
                  </label>

                  {onBehalfOf ? (
                    <div className="mt-3">
                      <Field
                        label="Where did this come from?"
                        htmlFor="review-reason"
                        required
                        hint="Kept in the audit trail."
                      >
                        <Textarea
                          id="review-reason"
                          rows={2}
                          value={reason}
                          disabled={busy !== null}
                          placeholder="Approved on a call with Mai, 12 Aug"
                          onChange={(e) => {
                            setReason(e.target.value);
                          }}
                        />
                      </Field>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  loading={busy === 'APPROVED'}
                  disabled={busy !== null || behalfBlocked}
                  onClick={() => void decide('APPROVED')}
                >
                  Approve
                </Button>
                <Button
                  variant="secondary"
                  loading={busy === 'CHANGES_REQUESTED'}
                  disabled={busy !== null || changesBlocked || behalfBlocked}
                  onClick={() => void decide('CHANGES_REQUESTED')}
                >
                  Request changes
                </Button>
              </div>

              {changesBlocked ? (
                <p className="text-xs text-ink-muted">Add a comment to request changes.</p>
              ) : null}
            </>
          )}
        </CardBody>
      </Card>

      <Timeline history={history} />
    </div>
  );
}

// ── Timeline ────────────────────────────────────────────────────────────────

const STATE_TONE = {
  PENDING: 'warning',
  APPROVED: 'success',
  CHANGES_REQUESTED: 'danger',
  CANCELED: 'neutral',
} as const;

const STATE_VERB = {
  PENDING: 'is waiting',
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'asked for changes',
  CANCELED: 'was voided when the post reopened',
} as const;

/**
 * Every round, including the cancelled ones.
 *
 * "Approved, then reopened, then approved again" is the story an audit needs to
 * be able to tell, so a voided round is shown rather than quietly dropped.
 */
function Timeline({ history }: { history: ApprovalRecord[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
      </CardHeader>
      <CardBody>
        {history.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing has been reviewed yet.</p>
        ) : (
          <ol className="space-y-4">
            {history.map((entry) => (
              <li key={entry.id} className="flex gap-3">
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-1.5 size-2 shrink-0 rounded-full',
                    entry.state === 'APPROVED' && 'bg-success',
                    entry.state === 'CHANGES_REQUESTED' && 'bg-danger',
                    entry.state === 'PENDING' && 'bg-warning',
                    entry.state === 'CANCELED' && 'bg-line-strong',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">
                    <span className="font-medium">
                      {entry.stage === 'CLIENT' ? 'Client review' : 'Internal review'}
                    </span>{' '}
                    <span className="text-ink-muted">{STATE_VERB[entry.state]}</span>
                    {entry.decidedBy ? (
                      <span className="text-ink-muted">
                        {' '}
                        · {entry.decidedBy.name ?? entry.decidedBy.email}
                      </span>
                    ) : null}
                  </p>

                  <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                    <Badge tone={STATE_TONE[entry.state]}>round {entry.round}</Badge>
                    <time dateTime={entry.decidedAt ?? entry.requestedAt}>
                      {(entry.decidedAt ?? entry.requestedAt).slice(0, 10)}
                    </time>
                    {entry.onBehalfOf ? (
                      <Badge tone="warning">recorded on the client's behalf</Badge>
                    ) : null}
                  </p>

                  {entry.comment ? (
                    <p className="mt-1.5 border-l-2 border-line pl-3 text-sm text-ink-secondary">
                      {entry.comment}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}

/** Small helper so a queue row can describe where a post sits. */
export function statusLabel(status: keyof typeof STATUS_LABEL): string {
  return STATUS_LABEL[status];
}
