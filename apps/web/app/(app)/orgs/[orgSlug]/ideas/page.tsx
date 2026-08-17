import type { Metadata } from 'next';
import { accessibleWorkspaceIds } from '@orbit/core';
import { PageHeader, PermissionDenied } from '@orbit/ui';
import { pageCanSomewhere, requirePageContext } from '@/server/page-context';
import { listIdeas } from '@/features/ideas/service';
import { listWorkspacesWithBrands } from '@/features/tenancy/service';
import { IdeaBoard } from '@/features/ideas/ui/idea-board';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Ideas' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ state?: string; brandId?: string; q?: string }>;
}

const STATES = ['SUGGESTED', 'ACCEPTED', 'DISMISSED', 'CONVERTED'] as const;

/**
 * The ideas board (Phase 4 P2, SRS §25).
 *
 * What an agency writes down before it becomes work. Deliberately sits in the
 * **Work** group beside Posts rather than under AI: most ideas are typed by a
 * person in a planning meeting, and filing it under AI would suggest otherwise.
 */
export default async function IdeasPage({ params, searchParams }: PageProps) {
  const { orgSlug } = await params;
  const { state, brandId, q } = await searchParams;
  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCanSomewhere(ctx, 'post:read')) {
    return (
      <main id="main" className="mx-auto max-w-6xl px-6 py-10">
        <PermissionDenied action="see content ideas" />
      </main>
    );
  }

  const [ideas, workspaces] = await Promise.all([
    listIdeas(ctx, {
      ...(brandId ? { brandId } : {}),
      ...(q ? { search: q } : {}),
      ...(state && (STATES as readonly string[]).includes(state)
        ? { state: state as (typeof STATES)[number] }
        : {}),
    }),
    listWorkspacesWithBrands(ctx, accessibleWorkspaceIds(ctx)),
  ]);

  const brands = workspaces.flatMap((workspace) =>
    workspace.brands.map((brand) => ({
      id: brand.id,
      name: workspaces.length > 1 ? `${workspace.name} · ${brand.name}` : brand.name,
      workspaceId: workspace.id,
    })),
  );

  return (
    <main id="main" className="mx-auto max-w-6xl px-6 py-10">
      <PageHeader
        eyebrow={organization.name}
        title="Ideas"
        description="What to write about, before it becomes a post."
      />

      <div className="mt-6">
        <IdeaBoard
          orgSlug={orgSlug}
          ideas={ideas.map((idea) => ({
            id: idea.id,
            topic: idea.topic,
            hook: idea.hook,
            platform: idea.platform,
            caption: idea.caption,
            cta: idea.cta,
            plannedFor: idea.plannedFor?.toISOString() ?? null,
            state: idea.state,
            brand: idea.brand,
            generatedBy: idea.generatedBy,
            convertedPosts: idea.convertedPosts,
          }))}
          brands={brands}
          canCreate={pageCanSomewhere(ctx, 'post:create') && brands.length > 0}
          canUpdate={pageCanSomewhere(ctx, 'post:update')}
          filter={{ state: state ?? '', brandId: brandId ?? '', q: q ?? '' }}
        />
      </div>
    </main>
  );
}
