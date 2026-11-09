import type { Metadata } from 'next';
import { SignInPanel } from '@/features/auth/ui/sign-in-panel';
import { redirectIfSignedIn } from '@/server/home';

export const metadata: Metadata = {
  title: 'Operations sign-in',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ next?: string | string[] }>;
}

/**
 * The platform operations entrance.
 *
 * It lives at `/sign-in/ops` rather than `/admin/sign-in` for a mechanical
 * reason: the `/admin` layout runs `requirePlatformAdmin()` on everything
 * beneath it, which redirects a signed-out visitor to `/sign-in` — so an
 * entrance inside that path would bounce off the gate it exists to get past.
 *
 * **This page grants nothing and reveals nothing.** It is the same mechanism as
 * the other two doors; `entrance="ops"` asks to land on `/admin`, and that only
 * happens for somebody whose `User` row already carries `isPlatformAdmin`.
 * Anyone else signs in successfully and lands on their own home, exactly as if
 * they had used the agency door — so this URL cannot be used to find out who
 * the platform administrators are.
 *
 * Deliberately unlinked from anywhere in the product, and `noindex`.
 */
export default async function OpsSignInPage({ searchParams }: PageProps) {
  const { next } = await searchParams;
  // A signed-in admin lands on operations; anybody else on their own home,
  // exactly as the form would have sent them.
  await redirectIfSignedIn('ops', typeof next === 'string' ? next : undefined);

  return (
    <SignInPanel
      entrance="ops"
      eyebrow="Platform operations"
      title="Operations sign-in"
      description="For the team running Social Square itself. Signing in here does not grant access — it only asks to land on operations."
    />
  );
}
