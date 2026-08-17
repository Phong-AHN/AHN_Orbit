import { Suspense } from 'react';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE_NAME, requireSession, resolveUser } from '@orbit/auth';
import { Loading, PageHeader } from '@orbit/ui';
import { AcceptInvitation } from '@/features/tenancy/ui/accept-invitation';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Accept invitation' };

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

/**
 * Where an invitation link lands.
 *
 * Sign-in comes first, and the token rides through it: the membership is
 * granted to the session, so there has to *be* one. Sending them to sign in
 * without carrying the token would drop the invitation on the floor.
 */
export default async function AcceptInvitationPage({ searchParams }: PageProps) {
  const { token } = await searchParams;
  const cookieStore = await cookies();

  try {
    const identity = await requireSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);
    await resolveUser(identity);
  } catch {
    const next = `/accept-invitation${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  }

  return (
    <main id="main" className="mx-auto max-w-xl px-6 py-16">
      <PageHeader title="Join the team" description="One step, and you are in." />

      <Suspense fallback={<Loading label="Loading the invitation" rows={2} />}>
        <AcceptInvitation />
      </Suspense>
    </main>
  );
}
