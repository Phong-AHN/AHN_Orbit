import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isAppError, isEditLocked, isUserPrincipal } from '@orbit/core';
import { allowedTransitions } from '@orbit/rbac';
import { PageHeader, PermissionDenied } from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { ensureProvidersRegistered } from '@/server/providers';
import { getPost } from '@/features/posts/service';
import { listAccounts } from '@/features/social/service';
import { Composer } from '@/features/posts/ui/composer';
import {
  summariseCapabilities,
  type CapabilitySummary,
} from '@/features/posts/ui/capability-summary';
import { serialisePost } from '@/features/posts/ui/serialise';
import { listApprovalsForPost } from '@/features/approvals/service';
import { ReviewPanel } from '@/features/approvals/ui/review-panel';
import { serialiseApprovals } from '@/features/approvals/ui/serialise';
import { getPublishingStatus } from '@/features/publishing/service';
import { AttemptTimeline } from '@/features/publishing/ui/attempt-timeline';
import { ResolvePanel } from '@/features/publishing/ui/resolve-panel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Composer' };

interface PageProps {
  params: Promise<{ orgSlug: string; postId: string }>;
}

/**
 * The composer page.
 *
 * Everything the composer needs to decide what to *show* is resolved here, on
 * the server, from the same policy engine the API uses: which transitions are
 * legal for this principal from this status, whether editing is permitted,
 * whether the post is past its edit lock. The composer renders that; it never
 * derives it. Every mutation it fires is checked again server-side.
 */
export default async function ComposerPage({ params }: PageProps) {
  const { orgSlug, postId } = await params;
  const { ctx, organization } = await requirePageContext(orgSlug);

  ensureProvidersRegistered();

  let post;
  try {
    post = await getPost(ctx, postId);
  } catch (error) {
    // A post in another organization is simply not found here — the tenant-scoped
    // client never saw it, so there is nothing to distinguish it from a typo.
    if (isAppError(error) && error.status === 404) notFound();
    throw error;
  }

  const scope = {
    workspaceId: post.workspaceId,
    brandId: post.brandId,
    createdById: post.createdById,
    status: post.status,
  };

  if (!pageCan(ctx, 'post:read', scope)) {
    return (
      <main id="main" className="mx-auto max-w-6xl px-6 py-10">
        <PermissionDenied action="open this post" />
      </main>
    );
  }

  // Only accounts on this post's brand, and only ones that can actually publish.
  const accounts = (await listAccounts(ctx, { brandId: post.brandId })).filter(
    (account) => account.status !== 'DISABLED',
  );

  // Capability summaries for every platform in play — the accounts on offer plus
  // any already-selected variant, so a summary is never missing for a tab.
  const capabilities: Record<string, CapabilitySummary> = {};
  for (const { platform, accountType } of [
    ...accounts.map((a) => ({ platform: a.platform, accountType: a.accountType })),
    ...post.variants.map((v) => ({ platform: v.platform, accountType: null })),
  ]) {
    const key = `${platform}:${accountType ?? '*'}`;
    if (key in capabilities) continue;
    try {
      capabilities[key] = summariseCapabilities(platform, accountType);
    } catch {
      // A platform with no registered provider yet simply gets no live hints;
      // `/validate` remains the authority either way.
    }
  }

  // Review state. `canDecide` asks the policy engine the same question the
  // decision endpoint will ask, so the buttons match what the server will
  // actually allow — the endpoint still re-checks on its own.
  const history = serialiseApprovals(await listApprovalsForPost(ctx, post.id));
  const pending = history.find((a) => a.state === 'PENDING') ?? null;

  const decisionPermission = pending
    ? pending.stage === 'CLIENT'
      ? 'post:approve_client'
      : post.approvalRequired
        ? 'post:submit_client_review'
        : 'post:approve_internal'
    : null;

  const canDecide =
    decisionPermission !== null &&
    pageCan(ctx, decisionPermission, { ...scope, intent: 'TRANSITION' });

  // Relaying a client's decision is an internal-role act by definition.
  const canDecideOnBehalf =
    canDecide &&
    isUserPrincipal(ctx.principal) &&
    ctx.principal.organizationRole !== 'CLIENT' &&
    pageCan(ctx, 'post:approve_client', { ...scope, intent: 'TRANSITION' });

  // Publishing state, so a failed or parked account is visible on the post
  // itself rather than only in the log.
  const publishing = await getPublishingStatus(ctx, post.id);

  const canResolve = pageCan(ctx, 'post:retry_failed', { ...scope, intent: 'TRANSITION' });

  return (
    <main id="main" className="mx-auto max-w-6xl px-6 py-10">
      <PageHeader
        eyebrow={organization.name}
        title={post.title ?? 'Untitled post'}
        description="Write once, adjust per account, then send it for review."
      />

      <div className="mt-8">
        <Composer
          orgSlug={orgSlug}
          post={serialisePost(post)}
          accounts={accounts.map((a) => ({
            id: a.id,
            displayName: a.displayName,
            handle: a.handle,
            platform: a.platform,
            status: a.status,
          }))}
          capabilities={capabilities}
          allowedTransitions={allowedTransitions(ctx, post.status, scope)}
          canEdit={pageCan(ctx, 'post:update', scope)}
          canDelete={pageCan(ctx, 'post:delete', scope)}
          editLocked={isEditLocked(post.status)}
          workspaceTimezone={post.workspace.timezone}
          canPublishNow={pageCan(ctx, 'post:publish_now', scope)}
        />
      </div>

      {publishing.variants.some((variant) => variant.status !== 'DRAFT') ? (
        <section className="mt-8 space-y-6" aria-labelledby="publishing-heading">
          <h2 id="publishing-heading" className="text-sm font-semibold text-ink">
            Publishing
          </h2>

          {/* A parked account blocks nothing automatically — it waits for a
              person, so it is put in front of them rather than in a log. */}
          {canResolve
            ? publishing.variants
                .filter((variant) => variant.status === 'NEEDS_REVIEW')
                .map((variant) => (
                  <ResolvePanel
                    key={variant.id}
                    orgSlug={orgSlug}
                    variantId={variant.id}
                    accountName={variant.socialAccount.displayName}
                    lastErrorMessage={readErrorMessage(variant.lastError)}
                  />
                ))
            : null}

          {publishing.variants.map((variant) =>
            variant.jobs[0] ? (
              <AttemptTimeline
                key={variant.id}
                attempts={variant.jobs[0].attempts.map((attempt) => ({
                  id: `${variant.id}-${attempt.attemptNumber}`,
                  attemptNumber: attempt.attemptNumber,
                  state: attempt.state,
                  startedAt: attempt.startedAt.toISOString(),
                  finishedAt: attempt.finishedAt?.toISOString() ?? null,
                  durationMs: attempt.durationMs,
                  externalPostId: null,
                  errorCode: attempt.errorCode,
                  errorMessage: attempt.errorMessage,
                  errorRetryable: attempt.errorRetryable,
                  correlationId: '',
                }))}
              />
            ) : null,
          )}
        </section>
      ) : null}

      <div className="mt-8">
        <ReviewPanel
          orgSlug={orgSlug}
          postId={post.id}
          pending={pending}
          history={history}
          canDecide={canDecide}
          canDecideOnBehalf={canDecideOnBehalf}
        />
      </div>
    </main>
  );
}

/** The stored `lastError` is `{ code, message }`; render only the message. */
function readErrorMessage(value: unknown): string | null {
  if (value && typeof value === 'object' && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return null;
}
