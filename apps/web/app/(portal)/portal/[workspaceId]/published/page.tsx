import type { Metadata } from 'next';
import { Card, CardBody, Empty, PageHeader } from '@orbit/ui';
import { requirePortalContext } from '@/server/portal-context';
import { listPortalPublished } from '@/features/portal/service';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Published' };

interface PageProps {
  params: Promise<{ workspaceId: string }>;
}

/**
 * What went live, with links to the real thing.
 *
 * Only accounts that actually published are listed. A post that reached two of
 * three accounts shows the two — the third is a conversation the agency should
 * be having with the client directly, not a red badge discovered at the weekend.
 */
export default async function PortalPublishedPage({ params }: PageProps) {
  const { workspaceId } = await params;
  const { ctx, workspace } = await requirePortalContext(workspaceId);

  const posts = await listPortalPublished(ctx, workspaceId);

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-10">
      <PageHeader
        eyebrow={workspace.name}
        title="Published"
        description="Everything that has gone out."
      />

      {posts.length === 0 ? (
        <Empty
          className="mt-8"
          title="Nothing published yet"
          description="Once your first post goes live, it will be listed here with a link."
        />
      ) : (
        <ul className="mt-8 space-y-2.5">
          {posts.map((post) => (
            <li key={post.id}>
              <Card>
                <CardBody>
                  <p className="text-sm font-semibold text-ink">
                    {post.title ?? post.body.trim().slice(0, 60)}
                  </p>

                  {post.publishedAt ? (
                    <p className="mt-1 text-xs text-ink-muted">
                      {new Intl.DateTimeFormat('en-GB', {
                        dateStyle: 'medium',
                        timeZone: workspace.timezone,
                      }).format(post.publishedAt)}
                    </p>
                  ) : null}

                  {post.variants.length > 0 ? (
                    <ul className="mt-2 flex flex-wrap gap-3">
                      {post.variants.map((variant) => (
                        <li key={variant.id}>
                          {variant.externalPermalink ? (
                            <a
                              href={variant.externalPermalink}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="text-xs text-accent hover:underline"
                            >
                              {variant.socialAccount.displayName} →
                            </a>
                          ) : (
                            <span className="text-xs text-ink-muted">
                              {variant.socialAccount.displayName}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
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
