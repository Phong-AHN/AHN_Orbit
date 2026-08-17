import type { Metadata } from 'next';
import { MEDIA_KINDS, type MediaKind, accessibleWorkspaceIds } from '@orbit/core';
import { PageHeader, PermissionDenied } from '@orbit/ui';
import { pageCan, pageCanSomewhere, requirePageContext } from '@/server/page-context';
import { listMediaWithPreviews } from '@/features/media/service';
import { folderPath, listFolders } from '@/features/media/folders';
import { listWorkspacesWithBrands } from '@/features/tenancy/service';
import { MediaFilters } from '@/features/media/ui/media-filters';
import { Library } from '@/features/media/ui/library';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Media' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{
    q?: string;
    kind?: string;
    brandId?: string;
    workspaceId?: string;
    folderId?: string;
  }>;
}

/**
 * The media library (SRS §12, §14).
 *
 * Reads stored rows and signs a preview per row — no provider call, so a reload
 * costs nothing but CPU.
 *
 * **Folders need a client.** They are scoped to a workspace, because agencies
 * file by campaign and by shoot and both span the brands belonging to one
 * client. Until a client is chosen there is nothing to file into, so the folder
 * bar is absent rather than empty.
 *
 * Filtering happens in the URL: a filtered view is a thing people send to each
 * other, and it survives a reload. Everything is re-read and re-validated on
 * the server — a hand-edited id is simply something this session cannot see,
 * and the tenant-scoped query returns nothing rather than refusing loudly.
 */
export default async function MediaPage({ params, searchParams }: PageProps) {
  const { orgSlug } = await params;
  const { q, kind, brandId, workspaceId, folderId } = await searchParams;
  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCanSomewhere(ctx, 'media:read')) {
    return (
      <main id="main" className="mx-auto max-w-6xl px-6 py-10">
        <PermissionDenied action="see the media library" />
      </main>
    );
  }

  const [workspaces, assets, folders, path] = await Promise.all([
    listWorkspacesWithBrands(ctx, accessibleWorkspaceIds(ctx)),
    listMediaWithPreviews(ctx, {
      ...(q ? { search: q } : {}),
      ...(brandId ? { brandId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      // `null` means the workspace root specifically; absent means anywhere.
      ...(workspaceId ? { folderId: folderId ?? null } : {}),
      ...(kind && (MEDIA_KINDS as readonly string[]).includes(kind)
        ? { kind: kind as MediaKind }
        : {}),
    }),
    workspaceId ? listFolders(ctx, workspaceId) : Promise.resolve([]),
    folderId ? folderPath(ctx, folderId) : Promise.resolve([]),
  ]);

  const brands = workspaces.flatMap((workspace) =>
    workspace.brands.map((brand) => ({
      id: brand.id,
      label: `${workspace.name} · ${brand.name}`,
    })),
  );

  return (
    <main id="main" className="mx-auto max-w-6xl px-6 py-10">
      <PageHeader
        eyebrow={organization.name}
        title="Media"
        description="Everything uploaded across your clients. Attach from here instead of uploading twice."
      />

      <MediaFilters
        brands={brands}
        clients={workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }))}
        initial={{
          q: q ?? '',
          kind: kind ?? '',
          brandId: brandId ?? '',
          workspaceId: workspaceId ?? '',
        }}
      />

      <Library
        orgSlug={orgSlug}
        assets={assets.map((asset) => ({ ...asset, createdAt: asset.createdAt.toISOString() }))}
        workspaceId={workspaceId ?? null}
        folders={folders.map((folder) => ({
          id: folder.id,
          name: folder.name,
          parentId: folder.parentId,
          assetCount: folder._count.assets,
          childCount: folder._count.children,
        }))}
        currentFolderId={folderId ?? null}
        folderPath={path}
        canManageFolders={pageCan(ctx, 'media:update', workspaceId ? { workspaceId } : {})}
        filtered={Boolean(q || kind || brandId)}
      />
    </main>
  );
}
