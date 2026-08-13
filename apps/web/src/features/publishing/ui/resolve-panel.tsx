'use client';

import * as React from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Textarea,
  cn,
} from '@orbit/ui';
import { ApiError } from '@/features/posts/ui/api';

/**
 * Recording what happened to a parked publish (SRS §14, decision D-029).
 *
 * The wording matters more than usual here. A person is being asked to settle
 * something the system could not, and the interface has to make clear that
 * they are attesting rather than choosing: the question is "what did you find
 * on the platform?", not "what would you like to happen?".
 *
 * The permalink is offered first for exactly that reason — it is the one place
 * the truth can be checked.
 */

export type Resolution = 'PUBLISHED' | 'NOT_PUBLISHED' | 'ABANDON';

export interface ResolvePanelProps {
  orgSlug: string;
  variantId: string;
  accountName: string;
  /** What the engine last recorded, so the reader knows what is unknown. */
  lastErrorMessage: string | null;
  onResolved?: () => void;
}

export function ResolvePanel(props: ResolvePanelProps) {
  const [resolution, setResolution] = React.useState<Resolution | null>(null);
  const [reason, setReason] = React.useState('');
  const [externalPostId, setExternalPostId] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  // Confirming a publish means naming the post; the server and a DB constraint
  // both require it.
  const needsExternalId = resolution === 'PUBLISHED' && externalPostId.trim().length === 0;

  async function submit() {
    if (!resolution || reason.trim().length === 0 || needsExternalId) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/orgs/${encodeURIComponent(props.orgSlug)}/publishing/variants/${props.variantId}/resolve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            resolution,
            reason: reason.trim(),
            ...(resolution === 'PUBLISHED' ? { externalPostId: externalPostId.trim() } : {}),
          }),
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

      setDone(true);
      props.onResolved?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be recorded.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Card>
        <CardBody>
          <p className="text-sm text-success">
            Recorded. {props.accountName} is no longer waiting for a decision.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>What happened on {props.accountName}?</CardTitle>
        <Badge tone="warning">Needs checking</Badge>
      </CardHeader>

      <CardBody className="space-y-4">
        <p className="text-sm text-ink-muted">
          {props.lastErrorMessage ??
            'The platform never confirmed whether this post went out, so we stopped rather than risk posting it twice.'}{' '}
          Open the account and see whether the post is there.
        </p>

        <fieldset className="space-y-2">
          <legend className="sr-only">What you found</legend>

          <ResolutionChoice
            value="PUBLISHED"
            selected={resolution}
            onSelect={setResolution}
            title="The post is there"
            description="It published after all. We will record it as published."
          />
          <ResolutionChoice
            value="NOT_PUBLISHED"
            selected={resolution}
            onSelect={setResolution}
            title="The post is not there"
            description="We will queue it again, and publishing runs its normal checks."
          />
          <ResolutionChoice
            value="ABANDON"
            selected={resolution}
            onSelect={setResolution}
            title="Leave it — do not publish"
            description="Marks this account as failed. Nothing further is attempted."
          />
        </fieldset>

        {resolution === 'PUBLISHED' ? (
          <Field
            label="Post id or link"
            htmlFor="resolve-external-id"
            required
            hint="Copy it from the platform — it is what makes this checkable later."
          >
            <Input
              id="resolve-external-id"
              value={externalPostId}
              disabled={busy}
              placeholder="123456789_987654321"
              onChange={(e) => {
                setExternalPostId(e.target.value);
              }}
            />
          </Field>
        ) : null}

        {resolution ? (
          <Field
            label="How did you check?"
            htmlFor="resolve-reason"
            required
            hint="Kept in the audit trail. Someone will read this in six months."
          >
            <Textarea
              id="resolve-reason"
              rows={2}
              value={reason}
              disabled={busy}
              placeholder="Opened the Page — the post is live, timestamped 09:02."
              onChange={(e) => {
                setReason(e.target.value);
              }}
            />
          </Field>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}

        <Button
          loading={busy}
          disabled={busy || !resolution || reason.trim().length === 0 || needsExternalId}
          onClick={() => void submit()}
        >
          Record what I found
        </Button>
      </CardBody>
    </Card>
  );
}

function ResolutionChoice({
  value,
  selected,
  onSelect,
  title,
  description,
}: {
  value: Resolution;
  selected: Resolution | null;
  onSelect: (value: Resolution) => void;
  title: string;
  description: string;
}) {
  const active = selected === value;

  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5',
        active ? 'border-accent bg-accent-soft' : 'border-line bg-surface',
      )}
    >
      <input
        type="radio"
        name="resolution"
        className="mt-0.5 size-4 accent-accent"
        checked={active}
        onChange={() => {
          onSelect(value);
        }}
      />
      <span>
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="block text-xs text-ink-muted">{description}</span>
      </span>
    </label>
  );
}
