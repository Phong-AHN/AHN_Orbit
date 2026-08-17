'use client';

import * as React from 'react';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Textarea } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * The agency's side of the conversation on a post (SRS §16).
 *
 * The client portal has had a comment box since T1.16; the agency has been
 * writing into a thread it could not read. This is the other half.
 *
 * **Visibility is the whole design.** An internal comment is agency-only and a
 * client-visible one is not, and the difference is enforced by the *query* in
 * `listComments` — a Client never loads an internal row rather than loading one
 * and being refused it. This component only chooses which kind it is writing,
 * and says so plainly, because "who can see this" is the thing a person needs
 * to know before typing, not after.
 */

export interface CommentAuthor {
  id: string;
  name: string | null;
  email: string;
}

export interface PostComment {
  id: string;
  body: string;
  visibility: string;
  mentionedUserIds: string[];
  resolvedAt: string | null;
  createdAt: string;
  author: CommentAuthor | null;
}

export interface CommentThreadProps {
  orgSlug: string;
  postId: string;
  comments: PostComment[];
  members: CommentAuthor[];
  canComment: boolean;
  canResolve: boolean;
  /** Whether this principal may write internal-only comments at all. */
  canWriteInternal: boolean;
}

export function CommentThread({
  orgSlug,
  postId,
  comments: initial,
  members,
  canComment,
  canResolve,
  canWriteInternal,
}: CommentThreadProps) {
  const [comments, setComments] = React.useState(initial);
  const [body, setBody] = React.useState('');
  const [internal, setInternal] = React.useState(canWriteInternal);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const base = `/api/v1/orgs/${encodeURIComponent(orgSlug)}`;
  const byId = new Map(members.map((member) => [member.id, member]));

  async function post() {
    if (body.trim().length === 0) return;
    setBusy('new');
    setError(null);

    try {
      const { comment } = await apiRequest<{ comment: PostComment }>(
        `${base}/posts/${postId}/comments`,
        {
          method: 'POST',
          body: JSON.stringify({
            body: body.trim(),
            visibility: internal ? 'INTERNAL' : 'CLIENT_VISIBLE',
            mentionedUserIds: mentionedIn(body, members),
          }),
        },
      );

      setComments((current) => [...current, comment]);
      setBody('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The comment could not be posted.');
    } finally {
      setBusy(null);
    }
  }

  async function resolve(id: string) {
    setBusy(id);
    setError(null);

    try {
      const { comment } = await apiRequest<{ comment: PostComment }>(
        `${base}/comments/${id}/resolve`,
        { method: 'POST' },
      );
      setComments((current) => current.map((item) => (item.id === id ? comment : item)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be resolved.');
    } finally {
      setBusy(null);
    }
  }

  const open = comments.filter((comment) => !comment.resolvedAt);

  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-2">
        <CardTitle>Comments</CardTitle>
        {open.length > 0 ? <Badge tone="info">{open.length} open</Badge> : null}
      </CardHeader>

      <CardBody className="space-y-4">
        {comments.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Nothing yet. Notes here stay with the post, so the reasoning survives the handover.
          </p>
        ) : (
          <ul className="space-y-3">
            {comments.map((comment) => (
              <li
                key={comment.id}
                className={`rounded border px-3 py-2 ${
                  comment.resolvedAt ? 'border-line bg-surface-sunken' : 'border-line'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink">
                    {comment.author?.name ?? comment.author?.email ?? 'Someone'}
                  </span>

                  <Badge tone={comment.visibility === 'INTERNAL' ? 'neutral' : 'info'}>
                    {comment.visibility === 'INTERNAL' ? 'Internal' : 'Client can see'}
                  </Badge>

                  {comment.resolvedAt ? <Badge tone="success">Resolved</Badge> : null}

                  <span className="text-xs text-ink-muted">{when(comment.createdAt)}</span>

                  {canResolve && !comment.resolvedAt ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      disabled={busy === comment.id}
                      onClick={() => void resolve(comment.id)}
                    >
                      Resolve
                    </Button>
                  ) : null}
                </div>

                <p className="mt-1 whitespace-pre-wrap text-sm text-ink-secondary">
                  {comment.body}
                </p>

                {comment.mentionedUserIds.length > 0 ? (
                  <p className="mt-1 text-xs text-ink-muted">
                    Notified:{' '}
                    {comment.mentionedUserIds
                      .map((id) => byId.get(id)?.name ?? byId.get(id)?.email ?? 'someone')
                      .join(', ')}
                  </p>
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

        {canComment ? (
          <div className="space-y-2">
            <Textarea
              aria-label="Comment"
              rows={3}
              value={body}
              disabled={busy === 'new'}
              placeholder="Type @ to mention someone on the team"
              onChange={(event) => setBody(event.target.value)}
            />

            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                loading={busy === 'new'}
                disabled={busy === 'new' || body.trim().length === 0}
                onClick={() => void post()}
              >
                Comment
              </Button>

              {canWriteInternal ? (
                <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
                  <input
                    type="checkbox"
                    checked={internal}
                    disabled={busy === 'new'}
                    onChange={(event) => setInternal(event.target.checked)}
                  />
                  Internal only
                </label>
              ) : null}

              <span className="text-xs text-ink-muted">
                {internal
                  ? 'Only your team will see this.'
                  : 'The client will see this in their portal.'}
              </span>
            </div>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

/**
 * Resolve `@name` mentions to member ids.
 *
 * Matched against the member list rather than parsed as free text, so a mention
 * can only ever name somebody who is actually on this organization — the server
 * re-checks, and this keeps the two from disagreeing.
 */
function mentionedIn(body: string, members: readonly CommentAuthor[]): string[] {
  const lowered = body.toLowerCase();

  return members
    .filter((member) => {
      const handle = (member.name ?? member.email.split('@')[0] ?? '').toLowerCase();
      return handle.length > 0 && lowered.includes(`@${handle}`);
    })
    .map((member) => member.id);
}

/** Coarse on purpose: the exact second of a comment is never the question. */
function when(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
