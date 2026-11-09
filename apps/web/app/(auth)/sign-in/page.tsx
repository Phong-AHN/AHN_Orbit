import type { Metadata } from 'next';
import Link from 'next/link';
import { SignInPanel } from '@/features/auth/ui/sign-in-panel';
import { redirectIfSignedIn } from '@/server/home';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Sign in' };

interface PageProps {
  searchParams: Promise<{ next?: string | string[] }>;
}

/**
 * The agency entrance — the default door, and where every "please sign in"
 * redirect in the product points.
 *
 * It does not refuse clients. Somebody who turns out to be a client of a
 * workspace is sent to their portal on arrival rather than turned away here:
 * refusing would lock out anyone who kept the old bookmark, and it would make
 * the three entrances report what kind of account an address is.
 *
 * Somebody still signed in never sees the form: they go straight to where
 * they belong, or to `next` (`redirectIfSignedIn`). The same holds at all three
 * entrances.
 *
 * The route group is `(auth)` and has no shell: a signed-out person has no
 * organization, so there is no navigation to give them.
 */
export default async function SignInPage({ searchParams }: PageProps) {
  const { next } = await searchParams;
  await redirectIfSignedIn('agency', typeof next === 'string' ? next : undefined);

  return (
    <SignInPanel
      entrance="agency"
      eyebrow="Social Square"
      title="Sign in"
      footer={
        <>
          Reviewing content for your brand?{' '}
          <Link href="/sign-in/client" className="font-medium text-accent hover:underline">
            Use the client portal
          </Link>
          .
        </>
      }
    />
  );
}
