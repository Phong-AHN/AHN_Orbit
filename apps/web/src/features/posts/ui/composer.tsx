'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { PostStatus } from '@orbit/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  ErrorState,
  Field,
  Input,
  PermissionDenied,
  Spinner,
  Textarea,
  cn,
} from '@orbit/ui';
import { ApiError, postsApi, type PostDetail, type PostValidationResponse } from './api';
import type { CapabilitySummary } from './capability-summary';
import { STATUS_LABEL, STATUS_TONE } from './status';
import { ScheduleForm } from './schedule-form';

/**
 * The composer (SRS §9, §31).
 *
 * Three rules shape this file:
 *
 *   • It never decides anything. Validity comes from `/validate`, which runs
 *     the same engine the transition endpoint runs; permissions come from the
 *     server, which re-checks every mutation regardless of what is on screen.
 *   • Autosave is for the master copy only. Changing which accounts a post
 *     targets is deliberate, so it goes through an explicit save.
 *   • Every asynchronous surface has all four states — loading, empty, error,
 *     permission denied — because a composer that silently does nothing is
 *     worse than one that says why.
 */

const AUTOSAVE_DELAY_MS = 1200;
const VALIDATE_DELAY_MS = 700;

export interface ComposerAccount {
  id: string;
  displayName: string;
  handle: string | null;
  platform: string;
  status: string;
}

export interface ComposerProps {
  orgSlug: string;
  post: PostDetail;
  /** Accounts belonging to this post's brand, resolved server-side. */
  accounts: ComposerAccount[];
  /** Capability summaries keyed by `platform:accountType`, for instant hints. */
  capabilities: Record<string, CapabilitySummary>;
  /** Transitions this principal may perform from the current status. */
  allowedTransitions: PostStatus[];
  canEdit: boolean;
  canDelete: boolean;
  /** Read-only view for a status past the edit lock. */
  editLocked: boolean;
  /** The client's zone — what a chosen wall time means when scheduling. */
  workspaceTimezone: string;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'conflict'; message: string }
  | { kind: 'error'; message: string };

export function Composer(props: ComposerProps) {
  const router = useRouter();
  const api = React.useMemo(() => postsApi(props.orgSlug), [props.orgSlug]);

  const [post, setPost] = React.useState(props.post);
  const [title, setTitle] = React.useState(props.post.title ?? '');
  const [body, setBody] = React.useState(props.post.body);
  const [selectedIds, setSelectedIds] = React.useState<string[]>(() =>
    props.post.variants.map((v) => v.socialAccountId),
  );
  const [activeVariantId, setActiveVariantId] = React.useState<string | null>(null);

  const [save, setSave] = React.useState<SaveState>({ kind: 'idle' });
  const [validation, setValidation] = React.useState<PostValidationResponse | null>(null);
  const [validating, setValidating] = React.useState(false);
  const [actionError, setActionError] = React.useState<ApiError | null>(null);
  const [busy, setBusy] = React.useState(false);

  // The version the server last confirmed. Sent with each autosave so a second
  // editor's changes surface as a conflict instead of being overwritten.
  const lastSavedAt = React.useRef(props.post.updatedAt);

  const readOnly = !props.canEdit || props.editLocked;

  // ── Autosave ──────────────────────────────────────────────────────────────

  const dirty = title !== (post.title ?? '') || body !== post.body;

  React.useEffect(() => {
    if (readOnly || !dirty) return;

    const timer = setTimeout(() => {
      setSave({ kind: 'saving' });
      api
        .autosave(post.id, { title: title || null, body, updatedAt: lastSavedAt.current })
        .then((result) => {
          lastSavedAt.current = result.updatedAt;
          setPost((p) => ({ ...p, title: title || null, body, updatedAt: result.updatedAt }));
          setSave({ kind: 'saved', at: Date.now() });
        })
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 409) {
            setSave({ kind: 'conflict', message: error.message });
          } else {
            setSave({
              kind: 'error',
              message:
                error instanceof ApiError ? error.message : 'Your changes could not be saved.',
            });
          }
        });
    }, AUTOSAVE_DELAY_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [api, post.id, title, body, dirty, readOnly]);

  // ── Validation ────────────────────────────────────────────────────────────

  const runValidation = React.useCallback(() => {
    setValidating(true);
    api
      .validate(post.id)
      .then(setValidation)
      .catch(() => {
        // A failed validation call is not a validation failure. Leaving the
        // previous result in place is less misleading than showing "invalid".
        setValidation(null);
      })
      .finally(() => {
        setValidating(false);
      });
  }, [api, post.id]);

  React.useEffect(() => {
    const timer = setTimeout(runValidation, VALIDATE_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [runValidation, post.updatedAt, post.variants.length]);

  // ── Actions ───────────────────────────────────────────────────────────────

  async function withBusy(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(
        error instanceof ApiError ? error : new ApiError(500, { message: 'Something went wrong.' }),
      );
    } finally {
      setBusy(false);
    }
  }

  const saveAccounts = () =>
    withBusy(async () => {
      const { post: updated } = await api.update(post.id, { socialAccountIds: selectedIds });
      const { post: full } = await api.get(updated.id);
      setPost(full);
      lastSavedAt.current = full.updatedAt;
      runValidation();
    });

  /**
   * Re-read the post, then re-render the server component.
   *
   * Both halves are needed. `api.get` refreshes what is displayed;
   * `router.refresh()` refreshes what may be *done* — `allowedTransitions` is
   * computed on the server from the status the post had when the page
   * rendered, and it is a prop. Without it the buttons keep offering the moves
   * that were legal one status ago, and clicking one fails with a 409 that
   * looks like a broken state machine and is really a stale screen.
   */
  const refreshPost = React.useCallback(async () => {
    const { post: full } = await api.get(post.id);
    setPost(full);
    lastSavedAt.current = full.updatedAt;
    router.refresh();
  }, [api, post.id, router]);

  const transition = (to: PostStatus) =>
    withBusy(async () => {
      await api.transition(post.id, to);
      await refreshPost();
    });

  if (!props.canEdit && props.allowedTransitions.length === 0) {
    return <PermissionDenied action="edit this post" />;
  }

  const accountsDirty =
    selectedIds.length !== post.variants.length ||
    selectedIds.some((id) => !post.variants.some((v) => v.socialAccountId === id));

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-6">
        <StatusBar status={post.status} save={save} editLocked={props.editLocked} />

        {actionError ? (
          actionError.isPermissionDenied ? (
            <PermissionDenied action="do that" description={actionError.message} />
          ) : (
            <ErrorState
              title="That didn't work"
              description={
                <>
                  {actionError.message}
                  {actionError.details.length > 0 ? (
                    <ul className="mt-2 list-disc space-y-0.5 pl-5 text-left">
                      {actionError.details.map((d) => (
                        <li key={`${d.field}:${d.issue}`}>
                          <span className="font-medium">{d.field}</span> — {d.issue}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              }
              {...(actionError.correlationId ? { correlationId: actionError.correlationId } : {})}
            />
          )
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Content</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <Field label="Title" hint="Internal only — never published." htmlFor="post-title">
              <Input
                id="post-title"
                value={title}
                disabled={readOnly}
                maxLength={200}
                placeholder="Untitled post"
                onChange={(e) => {
                  setTitle(e.target.value);
                }}
              />
            </Field>

            <Field label="Post text" htmlFor="post-body">
              <Textarea
                id="post-body"
                value={body}
                disabled={readOnly}
                rows={10}
                placeholder="What do you want to say?"
                onChange={(e) => {
                  setBody(e.target.value);
                }}
              />
            </Field>

            <CharacterCounters
              body={body}
              variants={post.variants}
              capabilities={props.capabilities}
            />
          </CardBody>
        </Card>

        <AccountPicker
          accounts={props.accounts}
          selectedIds={selectedIds}
          disabled={readOnly || busy}
          dirty={accountsDirty}
          onToggle={(id) => {
            setSelectedIds((ids) =>
              ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
            );
          }}
          onSave={saveAccounts}
        />

        {post.variants.length > 0 ? (
          <VariantEditor
            orgSlug={props.orgSlug}
            post={post}
            capabilities={props.capabilities}
            activeVariantId={activeVariantId ?? post.variants[0]?.id ?? null}
            onSelect={setActiveVariantId}
            readOnly={readOnly}
            onSaved={(variant) => {
              setPost((p) => ({
                ...p,
                variants: p.variants.map((v) => (v.id === variant.id ? variant : v)),
              }));
              runValidation();
            }}
          />
        ) : null}
      </div>

      <aside className="space-y-6">
        <ValidationPanel validation={validation} validating={validating} />

        <TransitionPanel
          orgSlug={props.orgSlug}
          postId={post.id}
          workspaceTimezone={props.workspaceTimezone}
          onScheduled={() => {
            void refreshPost();
          }}
          transitions={props.allowedTransitions}
          busy={busy}
          blocked={validation !== null && !validation.valid}
          onTransition={transition}
        />
      </aside>
    </div>
  );
}

// ── Status and save indicator ───────────────────────────────────────────────

function StatusBar({
  status,
  save,
  editLocked,
}: {
  status: PostStatus;
  save: SaveState;
  editLocked: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>

      {editLocked ? (
        <span className="text-sm text-ink-muted">
          Approved content is locked. Reopen it to edit — that asks for approval again.
        </span>
      ) : (
        <SaveIndicator save={save} />
      )}
    </div>
  );
}

function SaveIndicator({ save }: { save: SaveState }) {
  switch (save.kind) {
    case 'saving':
      return (
        <span className="flex items-center gap-1.5 text-sm text-ink-muted">
          <Spinner className="size-3.5" /> Saving…
        </span>
      );
    case 'saved':
      return <span className="text-sm text-ink-muted">Saved</span>;
    case 'conflict':
      return (
        <span role="alert" className="text-sm font-medium text-warning">
          {save.message}
        </span>
      );
    case 'error':
      return (
        <span role="alert" className="text-sm font-medium text-danger">
          {save.message}
        </span>
      );
    default:
      return null;
  }
}

// ── Character counters ──────────────────────────────────────────────────────

function capabilityKey(platform: string, accountType: string | null): string {
  return `${platform}:${accountType ?? '*'}`;
}

/**
 * Per-platform counts against the master text.
 *
 * A hint, not a verdict: the counter turns red at the same threshold the server
 * enforces, but the server is what decides. A variant with its own text is
 * counted in the variant editor instead.
 */
function CharacterCounters({
  body,
  variants,
  capabilities,
}: {
  body: string;
  variants: PostDetail['variants'];
  capabilities: Record<string, CapabilitySummary>;
}) {
  const platforms = [...new Set(variants.map((v) => v.platform))];
  if (platforms.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
      {platforms.map((platform) => {
        const cap =
          capabilities[capabilityKey(platform, null)] ??
          Object.values(capabilities).find((c) => c.platform === platform);
        if (!cap) return null;

        const used = variants.some((v) => v.platform === platform && v.body.length > 0)
          ? null
          : body.length;
        if (used === null) return null;

        const over = used > cap.maxTextLength;
        return (
          <span
            key={platform}
            className={cn('font-mono', over ? 'font-semibold text-danger' : 'text-ink-muted')}
          >
            {platform.toLowerCase()} {used.toLocaleString()}/{cap.maxTextLength.toLocaleString()}
          </span>
        );
      })}
    </div>
  );
}

// ── Account picker ──────────────────────────────────────────────────────────

function AccountPicker({
  accounts,
  selectedIds,
  disabled,
  dirty,
  onToggle,
  onSave,
}: {
  accounts: ComposerAccount[];
  selectedIds: string[];
  disabled: boolean;
  dirty: boolean;
  onToggle: (id: string) => void;
  onSave: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-3">
        <CardTitle>Publish to</CardTitle>
        {dirty ? (
          <Button size="sm" disabled={disabled} onClick={onSave}>
            Save selection
          </Button>
        ) : null}
      </CardHeader>
      <CardBody>
        {accounts.length === 0 ? (
          <p className="text-sm text-ink-muted">
            This brand has no connected accounts yet. Connect one before the post can go anywhere.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {accounts.map((account) => {
              const checked = selectedIds.includes(account.id);
              const needsReconnect = account.status !== 'ACTIVE';

              return (
                <li key={account.id}>
                  <label
                    className={cn(
                      'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5',
                      checked ? 'border-accent bg-accent-soft' : 'border-line bg-surface',
                      disabled && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 accent-accent"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => {
                        onToggle(account.id);
                      }}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">
                        {account.displayName}
                      </span>
                      <span className="block truncate text-xs text-ink-muted">
                        {account.platform.toLowerCase()}
                        {account.handle ? ` · ${account.handle}` : ''}
                      </span>
                      {needsReconnect ? (
                        <Badge tone="warning" className="mt-1.5">
                          Needs reconnecting
                        </Badge>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

// ── Per-account overrides ───────────────────────────────────────────────────

function VariantEditor({
  orgSlug,
  post,
  capabilities,
  activeVariantId,
  onSelect,
  readOnly,
  onSaved,
}: {
  orgSlug: string;
  post: PostDetail;
  capabilities: Record<string, CapabilitySummary>;
  activeVariantId: string | null;
  onSelect: (id: string) => void;
  readOnly: boolean;
  onSaved: (variant: PostDetail['variants'][number]) => void;
}) {
  const api = React.useMemo(() => postsApi(orgSlug), [orgSlug]);
  const active = post.variants.find((v) => v.id === activeVariantId) ?? post.variants[0];

  const [override, setOverride] = React.useState('');
  const [firstComment, setFirstComment] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset the fields whenever a different account tab is opened, so one
  // account's draft override can never be saved onto another.
  React.useEffect(() => {
    setOverride(active?.body ?? '');
    setFirstComment(active?.firstComment ?? '');
    setError(null);
  }, [active?.id, active?.body, active?.firstComment]);

  if (!active) return null;

  const cap =
    capabilities[capabilityKey(active.platform, null)] ??
    Object.values(capabilities).find((c) => c.platform === active.platform);

  const inherits = override.length === 0;
  const counted = inherits ? post.body : override;

  async function saveOverride() {
    if (!active) return;
    setSaving(true);
    setError(null);
    try {
      const { variant } = await api.updateVariant(post.id, active.id, {
        body: override.length > 0 ? override : null,
        ...(cap?.supportsFirstComment
          ? { firstComment: firstComment.length > 0 ? firstComment : null }
          : {}),
      });
      onSaved(variant);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The override could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Per-account text</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        <div role="tablist" aria-label="Accounts" className="flex flex-wrap gap-1.5">
          {post.variants.map((variant) => (
            <button
              key={variant.id}
              type="button"
              role="tab"
              aria-selected={variant.id === active.id}
              onClick={() => {
                onSelect(variant.id);
              }}
              className={cn(
                'rounded-full px-3 py-1.5 text-sm transition-colors',
                variant.id === active.id
                  ? 'bg-accent text-accent-ink'
                  : 'bg-surface-sunken text-ink-muted hover:text-ink',
              )}
            >
              {variant.socialAccount.displayName}
            </button>
          ))}
        </div>

        <Field
          label={`Text for ${active.socialAccount.displayName}`}
          hint={
            inherits
              ? 'Empty means this account uses the main post text.'
              : 'This account has its own text. Clear it to go back to the main text.'
          }
          htmlFor={`variant-body-${active.id}`}
        >
          <Textarea
            id={`variant-body-${active.id}`}
            rows={6}
            value={override}
            disabled={readOnly || saving}
            placeholder={post.body || 'Same as the main post'}
            onChange={(e) => {
              setOverride(e.target.value);
            }}
          />
        </Field>

        {cap ? (
          <p
            className={cn(
              'font-mono text-xs',
              counted.length > cap.maxTextLength ? 'font-semibold text-danger' : 'text-ink-muted',
            )}
          >
            {counted.length.toLocaleString()}/{cap.maxTextLength.toLocaleString()}
            {inherits ? ' (inherited)' : ''}
          </p>
        ) : null}

        {cap?.supportsFirstComment ? (
          <Field
            label="First comment"
            hint="Posted immediately after the post — a common place for hashtags."
            htmlFor={`variant-comment-${active.id}`}
          >
            <Textarea
              id={`variant-comment-${active.id}`}
              rows={3}
              value={firstComment}
              disabled={readOnly || saving}
              {...(cap.maxFirstCommentLength ? { maxLength: cap.maxFirstCommentLength } : {})}
              onChange={(e) => {
                setFirstComment(e.target.value);
              }}
            />
          </Field>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}

        {!readOnly ? (
          <Button size="sm" variant="secondary" loading={saving} onClick={saveOverride}>
            Save override
          </Button>
        ) : null}
      </CardBody>
    </Card>
  );
}

// ── Validation panel ────────────────────────────────────────────────────────

function ValidationPanel({
  validation,
  validating,
}: {
  validation: PostValidationResponse | null;
  validating: boolean;
}) {
  const allIssues = validation
    ? [
        ...validation.postIssues.map((i) => ({ ...i, where: null as string | null })),
        ...validation.variants.flatMap((v) =>
          v.result.issues.map((i) => ({ ...i, where: v.accountName })),
        ),
      ]
    : [];

  const errors = allIssues.filter((i) => i.severity === 'ERROR');
  const warnings = allIssues.filter((i) => i.severity === 'WARNING');

  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-2">
        <CardTitle>Checks</CardTitle>
        {validating ? <Spinner className="size-4 text-ink-muted" /> : null}
      </CardHeader>
      <CardBody>
        {validation === null ? (
          <p className="text-sm text-ink-muted">Checking…</p>
        ) : allIssues.length === 0 ? (
          <p className="text-sm text-success">Everything checks out.</p>
        ) : (
          <ul className="space-y-2.5">
            {[...errors, ...warnings].map((issue, index) => (
              <li
                key={`${issue.where ?? ''}-${issue.code}-${index}`}
                className="flex gap-2 text-sm"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-1.5 size-1.5 shrink-0 rounded-full',
                    issue.severity === 'ERROR' ? 'bg-danger' : 'bg-warning',
                  )}
                />
                <span>
                  {issue.where ? (
                    <span className="font-medium text-ink">{issue.where}: </span>
                  ) : null}
                  <span className="text-ink-muted">{issue.message}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

// ── Transitions ─────────────────────────────────────────────────────────────

const TRANSITION_LABEL: Partial<Record<PostStatus, string>> = {
  IDEA: 'Move back to ideas',
  DRAFT: 'Back to draft',
  INTERNAL_REVIEW: 'Submit for internal review',
  CLIENT_REVIEW: 'Send to client',
  CHANGES_REQUESTED: 'Request changes',
  APPROVED: 'Approve',
  SCHEDULED: 'Schedule',
  CANCELED: 'Cancel',
};

/** Falls back to the status label, so a new transition is never an empty button. */
function transitionLabel(to: PostStatus): string {
  return TRANSITION_LABEL[to] ?? STATUS_LABEL[to];
}

/**
 * Only the transitions the server said this principal may perform, from this
 * status. The list is computed server-side by the state machine, so an
 * unreachable status — PUBLISHING, PUBLISHED — has no button here because it
 * has no human transition at all, not because the UI hides it.
 */
function TransitionPanel({
  orgSlug,
  postId,
  workspaceTimezone,
  onScheduled,
  transitions,
  busy,
  blocked,
  onTransition,
}: {
  orgSlug: string;
  postId: string;
  workspaceTimezone: string;
  onScheduled: () => void;
  transitions: PostStatus[];
  busy: boolean;
  blocked: boolean;
  onTransition: (to: PostStatus) => void;
}) {
  if (transitions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Next step</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-ink-muted">
            There's nothing for you to move forward here right now.
          </p>
        </CardBody>
      </Card>
    );
  }

  // Moving forward needs a clean post; stepping back or cancelling never does.
  const forward = new Set<PostStatus>([
    'INTERNAL_REVIEW',
    'CLIENT_REVIEW',
    'APPROVED',
    'SCHEDULED',
  ]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Next step</CardTitle>
      </CardHeader>
      <CardBody className="space-y-2">
        {transitions.map((to, index) =>
          // SCHEDULED is the one forward step that carries data, so it gets a
          // form rather than a button. Everything else is a status change.
          to === 'SCHEDULED' ? (
            <ScheduleForm
              key={to}
              orgSlug={orgSlug}
              postId={postId}
              timezone={workspaceTimezone}
              disabled={busy || blocked}
              onScheduled={onScheduled}
            />
          ) : (
            <Button
              key={to}
              className="w-full"
              variant={index === 0 ? 'primary' : 'secondary'}
              disabled={busy || (blocked && forward.has(to))}
              onClick={() => {
                onTransition(to);
              }}
            >
              {transitionLabel(to)}
            </Button>
          ),
        )}

        {blocked ? (
          <p className="pt-1 text-xs text-ink-muted">
            Fix the problems under Checks before moving this forward.
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
