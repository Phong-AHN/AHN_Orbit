import type { Metadata } from 'next';
import Link from 'next/link';
import { accessibleWorkspaceIds } from '@orbit/core';
import { Empty, PageHeader, PermissionDenied, buttonClassName } from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { listPublishTargets } from '@/features/posts/service';
import { NewPostForm } from '@/features/posts/ui/new-post-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'New post' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
}

/**
 * The step before the composer.
 *
 * Nothing here is a permission control — `pageCan` decides what to render, and
 * `POST /posts` re-checks `post:create` against the brand it is actually given
 * (docs/RBAC.md §6). The brand list is already narrowed to accessible
 * workspaces, so the picker cannot offer a client this person is not on.
 */
export default async function NewPostPage({ params }: PageProps) {
  const { orgSlug } = await params;
  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCan(ctx, 'post:create')) {
    return (
      <main id="main" className="mx-auto max-w-2xl px-6 py-10">
        <PermissionDenied action="create posts" />
      </main>
    );
  }

  const brands = await listPublishTargets(ctx, accessibleWorkspaceIds(ctx));

  // A brand this person cannot write to would only fail on submit.
  const targets = brands
    .filter((brand) => pageCan(ctx, 'post:create', { workspaceId: brand.workspaceId }))
    .map((brand) => ({
      id: brand.id,
      name: brand.name,
      workspaceId: brand.workspaceId,
      workspaceName: brand.workspace.name,
      accounts: brand.socialAccounts,
    }));

  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-10">
      <PageHeader
        eyebrow={organization.name}
        title="New post"
        description="Pick the brand and the accounts. Everything else happens in the composer."
      />

      {targets.length === 0 ? (
        <Empty
          title="No brands to post for"
          description="A post belongs to a brand inside a client workspace. Create one first."
          action={
            pageCan(ctx, 'brand:create') ? (
              <Link href={`/orgs/${orgSlug}/settings/workspaces`} className={buttonClassName()}>
                Set up a client
              </Link>
            ) : null
          }
        />
      ) : (
        <NewPostForm orgSlug={orgSlug} targets={targets} />
      )}

      <p className="mt-6 text-sm text-ink-muted">
        <Link href={`/orgs/${orgSlug}/posts`} className="hover:underline">
          Back to posts
        </Link>
      </p>
    </main>
  );
}
