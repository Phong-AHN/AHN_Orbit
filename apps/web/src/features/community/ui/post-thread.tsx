'use client';

import * as React from 'react';
import { Badge, Button, Field, Textarea, cn } from '@orbit/ui';
import type { MediaItem } from '@/features/media/ui/media-panel';
import { PreviewMedia } from '@/features/posts/ui/preview';
import { previewShape } from '@/features/posts/ui/preview-shape';
import { buildThread, compactAge, needsReply, threadStyle, type ThreadStyle } from '../thread';
import { useCommentActions } from './use-comment-actions';
import { safeExternalUrl } from '@/features/publishing/ui/links';

/**
 * A published post and the conversation under it, drawn the way its platform
 * draws one.
 *
 * ## Familiar, not a copy
 *
 * The layout follows each platform's conventions closely enough that somebody
 * who answers comments there all day reads this without thinking: on Instagram
 * the username sits inline before the text, on Facebook the name and text sit
 * together in a rounded bubble beside the avatar, and on both replies are
 * indented one level beneath what they answer. It does **not** reproduce either
 * platform's logos, wordmarks or exact styling — this is Orbit showing a
 * conversation, and looking like a counterfeit of Meta's own interface would
 * make it neither more usable nor ours.
 *
 * ## What is decided here, and what is not
 *
 * Threading, ordering, orphan handling and "needs a reply" are all in
 * `thread.ts`, pure and tested. This file is layout. That split is deliberate:
 * no one has looked at this screen in a browser, so the parts most likely to
 * be wrong are kept where a test can reach them.
 */

export interface ThreadPost {
  platform: string;
  body: string;
  hashtags: string[];
  publishedAt: string | null;
  externalPermalink: string | null;
  account: { displayName: string; handle: string | null; avatarUrl: string | null };
  media: MediaItem[];
}

export interface ThreadCommentView {
  id: string;
  externalId: string;
  parentExternalId: string | null;
  origin: 'AUDIENCE' | 'ORBIT';
  state: 'NEW' | 'HANDLED';
  authorName: string | null;
  message: string;
  postedAt: string;
  assignedTo: { id: string; name: string | null; email: string } | null;
}

export interface PostThreadProps {
  orgSlug: string;
  /** Rendered once on the server, so the client and server ages agree. */
  renderedAt: string;
  canReply: boolean;
  members: ReadonlyArray<{ id: string; name: string | null; email: string }>;
  post: ThreadPost;
  comments: ThreadCommentView[];
}

export function PostThread({
  orgSlug,
  renderedAt,
  canReply,
  members,
  post,
  comments,
}: PostThreadProps) {
  const now = React.useMemo(() => new Date(renderedAt), [renderedAt]);
  const style = threadStyle(post.platform);
  const thread = React.useMemo(() => buildThread(comments), [comments]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <PostCard orgSlug={orgSlug} post={post} now={now} />

      <section aria-label="Comments" className="rounded-lg border border-line bg-surface">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Comments</h2>
          <span className="text-xs text-ink-muted">
            {comments.filter((c) => c.origin === 'AUDIENCE').length.toLocaleString()} from the
            audience
          </span>
        </header>

        {thread.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-muted">
            No comments on this post yet.
          </p>
        ) : (
          <ol className="divide-y divide-line">
            {thread.map((node) => (
              <li key={node.comment.id} className="px-4 py-3">
                <Comment
                  orgSlug={orgSlug}
                  comment={node.comment}
                  style={style}
                  now={now}
                  canReply={canReply}
                  members={members}
                  brand={post.account}
                />

                {node.replies.length > 0 ? (
                  <ol className="mt-3 space-y-3 pl-10" aria-label="Replies">
                    {node.replies.map((reply) => (
                      <li key={reply.id}>
                        <Comment
                          orgSlug={orgSlug}
                          comment={reply}
                          style={style}
                          now={now}
                          canReply={canReply}
                          members={members}
                          brand={post.account}
                          nested
                        />
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/** The post itself, framed the way the composer previewed it. */
function PostCard({ orgSlug, post, now }: { orgSlug: string; post: ThreadPost; now: Date }) {
  const shape = previewShape(post.platform);
  const first = post.media[0];
  const hashtags = post.hashtags.map((tag) => (tag.startsWith('#') ? tag : `#${tag}`));
  const text = [post.body.trim(), hashtags.join(' ')].filter(Boolean).join('\n\n');

  const caption = text ? (
    <p className="whitespace-pre-wrap break-words px-4 py-3 text-sm text-ink">
      {/* Instagram sets the account name inline before the caption. */}
      {threadStyle(post.platform) === 'INSTAGRAM' ? (
        <span className="mr-1.5 font-semibold">
          {post.account.handle ?? post.account.displayName}
        </span>
      ) : null}
      {text}
    </p>
  ) : null;

  const media = first ? <PreviewMedia orgSlug={orgSlug} item={first} shape={shape} /> : null;

  return (
    <article className="self-start overflow-hidden rounded-lg border border-line bg-surface">
      <header className="flex items-center gap-3 px-4 py-3">
        <Avatar name={post.account.displayName} url={post.account.avatarUrl} size="md" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{post.account.displayName}</p>
          <p className="truncate text-xs text-ink-muted">
            {post.account.handle ? `@${post.account.handle}` : post.platform.toLowerCase()}
            {post.publishedAt ? ` · ${compactAge(post.publishedAt, now)}` : ''}
          </p>
        </div>
      </header>

      {shape.captionBelow ? (
        <>
          {media}
          {caption}
        </>
      ) : (
        <>
          {caption}
          {media}
        </>
      )}

      {post.media.length > 1 ? (
        <p className="border-t border-line px-4 py-2 text-xs text-ink-muted">
          {post.media.length} attachments
        </p>
      ) : null}

      {safeExternalUrl(post.externalPermalink) ? (
        <footer className="border-t border-line px-4 py-2.5">
          {/* `noreferrer` as well as `noopener`: a public page has no need to
              learn which Orbit screen somebody arrived from. */}
          <a
            href={safeExternalUrl(post.externalPermalink) as string}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            View on {post.platform.charAt(0) + post.platform.slice(1).toLowerCase()}
          </a>
        </footer>
      ) : null}
    </article>
  );
}

function Comment({
  orgSlug,
  comment,
  style,
  now,
  canReply,
  members,
  brand,
  nested = false,
}: {
  orgSlug: string;
  comment: ThreadCommentView;
  style: ThreadStyle;
  now: Date;
  canReply: boolean;
  members: PostThreadProps['members'];
  brand: ThreadPost['account'];
  nested?: boolean;
}) {
  const actions = useCommentActions(orgSlug, comment.id);
  const [replying, setReplying] = React.useState(false);
  const [draft, setDraft] = React.useState('');

  const ours = comment.origin === 'ORBIT';
  const name = ours ? (brand.handle ?? brand.displayName) : (comment.authorName ?? 'Someone');
  const waiting = needsReply(comment);
  // Only the audience is answered. Our own reply is not something to reply to.
  const answerable = canReply && !ours;

  async function send() {
    const message = draft.trim();
    if (!message) return;
    // Cleared only on success: a failed send keeps the words.
    if (await actions.reply(message)) {
      setDraft('');
      setReplying(false);
    }
  }

  const avatar = (
    <Avatar name={name} url={ours ? brand.avatarUrl : null} size={nested ? 'sm' : 'md'} />
  );

  const meta = (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
      <time dateTime={comment.postedAt}>{compactAge(comment.postedAt, now)}</time>

      {answerable ? (
        <button
          type="button"
          onClick={() => setReplying((open) => !open)}
          aria-expanded={replying}
          className="font-semibold hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Reply
        </button>
      ) : null}

      {canReply && !ours ? (
        <button
          type="button"
          disabled={actions.busy}
          onClick={() => void actions.setHandled(comment.state !== 'HANDLED')}
          className="hover:text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {comment.state === 'HANDLED' ? 'Reopen' : 'Mark handled'}
        </button>
      ) : null}

      {ours ? <Badge tone="neutral">Your reply</Badge> : null}
      {waiting ? <Badge tone="warning">Needs a reply</Badge> : null}
      {comment.state === 'HANDLED' && !ours ? <Badge tone="success">Handled</Badge> : null}
      {comment.assignedTo ? (
        <Badge tone="info">{comment.assignedTo.name ?? comment.assignedTo.email}</Badge>
      ) : null}
    </div>
  );

  return (
    <div className="flex gap-3">
      <div className="shrink-0">{avatar}</div>

      <div className="min-w-0 flex-1">
        {style === 'FACEBOOK' ? (
          // Facebook: name and text together, in a rounded bubble.
          <div className="inline-block max-w-full rounded-2xl bg-surface-sunken px-3 py-2">
            <p className="text-xs font-semibold text-ink">{name}</p>
            <p className="whitespace-pre-wrap break-words text-sm text-ink">{comment.message}</p>
          </div>
        ) : (
          // Instagram (and the neutral default): username inline before the
          // text, no container.
          <p className="whitespace-pre-wrap break-words text-sm text-ink">
            <span className="mr-1.5 font-semibold">{name}</span>
            {comment.message}
          </p>
        )}

        {meta}

        {actions.error ? (
          <p role="alert" className="mt-2 text-sm font-medium text-danger">
            {actions.error}
          </p>
        ) : null}

        {replying ? (
          <div className="mt-3 space-y-2">
            <Field label={`Reply to ${name}`} htmlFor={`reply-${comment.id}`}>
              <Textarea
                id={`reply-${comment.id}`}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={3}
                // The brand's voice, in public, under the client's name.
                placeholder={`Reply as ${brand.displayName}…`}
              />
            </Field>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={send}
                loading={actions.busy}
                loadingLabel="Posting reply"
                disabled={draft.trim().length === 0}
              >
                Post reply
              </Button>
              <Button variant="ghost" onClick={() => setReplying(false)} disabled={actions.busy}>
                Cancel
              </Button>

              {members.length > 0 ? (
                <label className="ml-auto flex items-center gap-2 text-xs text-ink-muted">
                  Assign
                  <select
                    value={comment.assignedTo?.id ?? ''}
                    disabled={actions.busy}
                    onChange={(event) => void actions.assign(event.target.value || null)}
                    className="rounded border border-line bg-surface px-2 py-1 text-xs text-ink"
                  >
                    <option value="">Nobody</option>
                    {members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name ?? member.email}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Initials, or the account's own picture for the brand.
 *
 * The audience never has a picture here, and that is by design rather than a
 * gap: Orbit stores no identifier for a commenter (**D-102**), and a profile
 * image URL is one. Initials from the public display name are what is left.
 */
function Avatar({ name, url, size }: { name: string; url: string | null; size: 'sm' | 'md' }) {
  const dimension = size === 'sm' ? 'size-7 text-[10px]' : 'size-9 text-xs';

  if (url) {
    // A plain <img>: a platform avatar URL is short-lived and not ours to
    // optimise.
    return <img src={url} alt="" className={cn(dimension, 'rounded-full object-cover')} />;
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        dimension,
        'grid place-items-center rounded-full bg-surface-sunken font-semibold text-ink-muted',
      )}
    >
      {initials(name)}
    </span>
  );
}

function initials(name: string): string {
  const parts = name
    .replace(/^@/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters =
    parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : name.replace(/^@/, '').slice(0, 2);
  return letters.toUpperCase();
}
