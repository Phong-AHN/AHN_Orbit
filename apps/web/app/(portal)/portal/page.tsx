import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardBody, Empty, PageHeader } from '@orbit/ui';
import { listPortalMemberships } from '@/server/portal-context';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Your content' };

/**
 * The portal's front door.
 *
 * A client with one workspace — which is nearly all of them — never sees this
 * page; they land straight on their content. It exists for the person who is a
 * client of the same agency for two brands, or of two agencies at once.
 */
export default async function PortalHome() {
  const workspaces = await listPortalMemberships();

  if (workspaces.length === 1) {
    redirect(`/portal/${workspaces[0]!.id}`);
  }

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-10">
      <PageHeader title="Your content" description="Choose which account to look at." />

      {workspaces.length === 0 ? (
        <Empty
          className="mt-8"
          title="Nothing shared with you yet"
          description="When your agency sends something for approval, it will appear here."
        />
      ) : (
        <ul className="mt-8 space-y-2">
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              <Card>
                <CardBody>
                  <Link
                    href={`/portal/${workspace.id}`}
                    className="text-sm font-semibold text-ink hover:underline"
                  >
                    {workspace.name}
                  </Link>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
