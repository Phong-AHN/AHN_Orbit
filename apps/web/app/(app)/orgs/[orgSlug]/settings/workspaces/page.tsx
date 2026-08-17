import type { Metadata } from 'next';
import Link from 'next/link';
import { accessibleWorkspaceIds } from '@orbit/core';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Empty,
  PageHeader,
  PermissionDenied,
  buttonClassName,
} from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { getOrganization, listWorkspacesWithBrands } from '@/features/tenancy/service';
import { CreateWorkspaceForm } from '@/features/tenancy/ui/create-workspace-form';
import { CreateBrandForm } from '@/features/tenancy/ui/create-brand-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Clients & brands' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ created?: string }>;
}

/**
 * Client workspaces and their brands.
 *
 * The setup chain is organization → workspace → brand → connected account, and
 * this page owns the middle two. It shows the next missing link explicitly
 * rather than leaving someone to discover that the composer has nothing to post
 * to: a workspace with no brand, and a brand with no account, each say so and
 * offer the one action that fixes it.
 *
 * Scoped by `accessibleWorkspaceIds`, so an account manager sees the clients
 * they are on and not the agency's whole book (docs/RBAC.md §3).
 */
export default async function WorkspacesPage({ params, searchParams }: PageProps) {
  const { orgSlug } = await params;
  const { created } = await searchParams;
  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCan(ctx, 'workspace:read')) {
    return (
      <main id="main" className="mx-auto max-w-4xl px-6 py-10">
        <PermissionDenied action="see client workspaces" />
      </main>
    );
  }

  const [{ timezone }, workspaces] = await Promise.all([
    getOrganization(ctx),
    listWorkspacesWithBrands(ctx, accessibleWorkspaceIds(ctx)),
  ]);

  const mayCreateWorkspace = pageCan(ctx, 'workspace:create');
  const mayConnect = pageCan(ctx, 'social_account:connect');

  return (
    <main id="main" className="mx-auto max-w-4xl px-6 py-10">
      <PageHeader
        eyebrow={organization.name}
        title="Clients & brands"
        description="Each client is a workspace. Brands live inside a workspace, and social accounts connect to a brand."
        actions={
          mayCreateWorkspace && workspaces.length > 0 ? (
            <CreateWorkspaceForm orgSlug={orgSlug} defaultTimezone={timezone} />
          ) : null
        }
      />

      {created === 'organization' ? (
        <p className="mb-6 rounded border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-ink">
          Organization created. Add your first client to start scheduling.
        </p>
      ) : null}

      {workspaces.length === 0 ? (
        <Empty
          title="No client workspaces yet"
          description="A workspace holds one client's brands, accounts and posts."
          action={
            mayCreateWorkspace ? (
              <CreateWorkspaceForm orgSlug={orgSlug} defaultTimezone={timezone} />
            ) : null
          }
        />
      ) : (
        <ul className="space-y-4">
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              <Card>
                <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle>{workspace.name}</CardTitle>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {workspace.timezone}
                      {workspace.clientCompanyName ? ` · ${workspace.clientCompanyName}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {workspace.status === 'ARCHIVED' ? (
                      <Badge tone="neutral">Archived</Badge>
                    ) : null}

                    {/* The queue had no entry point at all, so "add to queue"
                        resolved against slots nobody could see or create. */}
                    {pageCan(ctx, 'post:read', { workspaceId: workspace.id }) ? (
                      <Link
                        href={`/orgs/${orgSlug}/settings/workspaces/${workspace.id}/queue`}
                        className="rounded text-sm text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                      >
                        Posting times
                      </Link>
                    ) : null}
                  </div>
                </CardHeader>

                <CardBody className="space-y-3">
                  {workspace.brands.length === 0 ? (
                    <p className="text-sm text-ink-muted">
                      No brands yet. A brand is what social accounts and posts belong to.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {workspace.brands.map((brand) => {
                        const connected = brand._count.socialAccounts;

                        return (
                          <li
                            key={brand.id}
                            className="flex flex-wrap items-center justify-between gap-2 rounded border border-line px-3 py-2"
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              {brand.primaryColor ? (
                                <span
                                  aria-hidden="true"
                                  className="h-3 w-3 shrink-0 rounded-full border border-line"
                                  style={{ backgroundColor: brand.primaryColor }}
                                />
                              ) : null}
                              {/* The brand's own page, which is where its
                                  Brand Brain lives (T4.1). The name is the
                                  obvious thing to click and had nowhere to go. */}
                              <Link
                                href={`/orgs/${orgSlug}/brands/${brand.id}`}
                                className="truncate text-sm font-medium text-ink hover:underline"
                              >
                                {brand.name}
                              </Link>
                              <Badge tone={connected > 0 ? 'success' : 'warning'}>
                                {connected > 0
                                  ? `${connected} account${connected === 1 ? '' : 's'}`
                                  : 'No accounts'}
                              </Badge>
                            </div>

                            {mayConnect ? (
                              <div className="flex gap-1.5">
                                {/* One brand, two Meta surfaces. Naming both is
                                    clearer than a single button that opens a
                                    chooser nobody asked for. */}
                                <Link
                                  href={`/orgs/${orgSlug}/settings/accounts/connect?workspaceId=${workspace.id}&brandId=${brand.id}&platform=FACEBOOK`}
                                  className={buttonClassName({
                                    variant: connected > 0 ? 'ghost' : 'secondary',
                                    size: 'sm',
                                  })}
                                >
                                  Facebook
                                </Link>
                                <Link
                                  href={`/orgs/${orgSlug}/settings/accounts/connect?workspaceId=${workspace.id}&brandId=${brand.id}&platform=INSTAGRAM`}
                                  className={buttonClassName({
                                    variant: connected > 0 ? 'ghost' : 'secondary',
                                    size: 'sm',
                                  })}
                                >
                                  Instagram
                                </Link>
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {pageCan(ctx, 'brand:create', { workspaceId: workspace.id }) ? (
                    <CreateBrandForm
                      orgSlug={orgSlug}
                      workspaceId={workspace.id}
                      workspaceName={workspace.name}
                    />
                  ) : null}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
