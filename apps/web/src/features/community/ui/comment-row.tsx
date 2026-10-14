'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge, Button, Field, Textarea, useToast } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * One comment in the queue, with the three things somebody does to it.
 *
 * ## Replying is the only action that leaves the building
 *
 * Marking handled and assigning are internal bookkeeping and can be optimistic.
 * A reply goes onto a client's channel in public under the client's name, so it
 * is **not** optimistic: the button stays busy until the server confirms the
 * platform accepted it, and the box keeps its text if anything fails. Clearing
 * a composer on a failed send is how somebody loses a carefully worded reply
 * and then has to guess whether it went out.
 *
 * There is no confirmation dialog, deliberately. A reply is not destructive and
 * the text is right there to be read before pressing; a dialog over every
 * answer would make answering twenty comments unbearable, and the thing people
 * actually need protecting from is the *opposite* mistake — not knowing whether
 * it sent.
 */

export interface CommentRowProps {
  orgSlug: string;
  comment: {
    id: string;
    authorName: string | null;
    message: string;
    permalink: string | null;
    postedAt: string;
    state: 'NEW' | 'HANDLED';
    assignedTo: { id: string; name: string | null; email: string } | null;
    socialAccount: { id: string; displayName: string; platform: string };
    postVariant: { id: string; post: { id: string; title: string | null } };
  };
  /** Teammates a comment may be handed to. Clients are not among them. */
  members: ReadonlyArray<{ id: string; name: string | null; email: string }>;
  canReply: boolean;
}

export function CommentRow({ orgSlug, comment, members, canReply }: CommentRowProps) {
  const router = useRouter();
  const toast = useToast();

  const [draft, setDraft] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const base = `/api/v1/orgs/${encodeURIComponent(orgSlug)}/community/${comment.id}`;

  async function act(path: string, body: unknown, done: string) {
    setBusy(true);
    setError(null);

    try {
      await apiRequest(`${base}/${path}`, { method: 'POST', body: JSON.stringify(body) });
      toast.show(done);
      // The row's state, who it is assigned to and whether a reply now exists
      // are all server-rendered, so the server is asked again rather than
      // patched locally — there is no second copy of this to drift.
      router.refresh();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function reply() {
    const message = draft.trim();
    if (!message) return;

    const sent = await act('reply', { message }, 'Reply posted.');
    // Cleared only on success. A failed send keeps the words.
    if (sent) {
      setDraft('');
      setOpen(false);
    }
  }

  const who = comment.authorName ?? 'Someone';

  return (
    <li className="rounded border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">{who}</span>
        <Badge tone="neutral">{comment.socialAccount.platform.toLowerCase()}</Badge>
        {comment.state === 'HANDLED' ? <Badge tone="success">Handled</Badge> : null}
        {comment.assignedTo ? (
          <Badge tone="info">{comment.assignedTo.name ?? comment.assignedTo.email}</Badge>
        ) : null}

        <span className="ml-auto text-xs text-ink-muted">
          {new Date(comment.postedAt).toISOString().slice(0, 16).replace('T', ' ')}
        </span>
      </div>

      <p className="mt-2 whitespace-pre-wrap text-sm text-ink-secondary">{comment.message}</p>

      <p className="mt-2 text-xs text-ink-muted">
        on{' '}
        <Link
          href={`/orgs/${orgSlug}/posts/${comment.postVariant.post.id}`}
          className="underline hover:text-ink"
        >
          {comment.postVariant.post.title ?? 'a post'}
        </Link>
        {comment.permalink ? (
          <>
            {' · '}
            {/* `noreferrer` as well as `noopener`: this is a link to a public
                page, and there is no reason to tell the platform which Orbit
                screen somebody came from. */}
            <a
              href={comment.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-ink"
            >
              view on {comment.socialAccount.platform.toLowerCase()}
            </a>
          </>
        ) : null}
      </p>

      {error ? (
        <p role="alert" className="mt-2 text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      {canReply ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => setOpen((v) => !v)}>
              {open ? 'Cancel' : 'Reply'}
            </Button>

            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(
                  'handled',
                  { handled: comment.state !== 'HANDLED' },
                  comment.state === 'HANDLED' ? 'Back in the queue.' : 'Marked handled.',
                )
              }
            >
              {comment.state === 'HANDLED' ? 'Reopen' : 'Mark handled'}
            </Button>

            <label className="ml-auto flex items-center gap-2 text-xs text-ink-muted">
              <span>Assign</span>
              <select
                value={comment.assignedTo?.id ?? ''}
                disabled={busy}
                onChange={(event) =>
                  void act(
                    'assign',
                    { assignedToId: event.target.value || null },
                    event.target.value ? 'Assigned.' : 'Assignment cleared.',
                  )
                }
                className="rounded border border-line bg-surface px-2 py-1 text-xs text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <option value="">Nobody</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name ?? member.email}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {open ? (
            <div className="space-y-2">
              <Field
                label={`Reply to ${who}`}
                htmlFor={`reply-${comment.id}`}
                hint={`Posted publicly as ${comment.socialAccount.displayName}.`}
              >
                <Textarea
                  id={`reply-${comment.id}`}
                  rows={3}
                  value={draft}
                  disabled={busy}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </Field>

              <Button
                size="sm"
                loading={busy}
                loadingLabel="Posting…"
                disabled={busy || draft.trim().length === 0}
                onClick={() => void reply()}
              >
                Post reply
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-ink-muted">
          You can read the inbox. Replying is left to whoever publishes for this client.
        </p>
      )}
    </li>
  );
}
