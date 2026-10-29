import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardBody, Empty, PageHeader, buttonClassName } from '@orbit/ui';
import { safeNext, type Entrance } from '@/features/navigation/home';
import { homeForSession } from '@/server/home';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Signing you in' };

const ENTRANCES = new Set<Entrance>(['agency', 'portal', 'ops']);

/**
 * Where sign-in lands, and the only thing that decides which surface is yours.
 *
 * ## Why this is a page and not browser code
 *
 * Working out where somebody belongs means reading memberships: are they staff
 * anywhere, a client of any workspace, a platform admin. A browser cannot be
 * trusted with that question, and answering it in the client would mean a
 * second implementation of the surface-separation rules living in the one place
 * that can be edited by whoever is looking at it.
 *
 * ## What this replaced
 *
 * Both sign-in forms used to navigate to `/orgs`, which forwards anybody with
 * exactly one organization into `/orgs/{slug}/dashboard`. **For a client that
 * was the wrong surface entirely** — the agency app, whose API refuses them with
 * a 404 on every call, so the page rendered and then did nothing. A client's
 * product is the portal, and nothing in the sign-in path knew that.
 *
 * ## It renders almost never
 *
 * Every signed-in person with somewhere to be is redirected before this returns
 * markup. What is left is the case that genuinely has no destination: an
 * invitation that was never accepted, or a membership revoked while the person
 * was signed in. That is not an error and must not bounce — a redirect here
 * would ping-pong between surfaces — so it says so plainly instead.
 */
export default async function ContinuePage({
  searchParams,
}: {
  searchParams: Promise<{ entrance?: string; next?: string }>;
}) {
  const params = await searchParams;

  // Validated against the closed set rather than cast: this arrives in a query
  // string, and an unrecognised value should mean "no hint", never a crash.
  const entrance =
    params.entrance && ENTRANCES.has(params.entrance as Entrance)
      ? (params.entrance as Entrance)
      : undefined;

  const home = await homeForSession(entrance);

  if (!home) {
    // No session. Back to the door they came through, preserving where they
    // were heading so the round trip is invisible.
    const back =
      entrance === 'ops' ? '/sign-in/ops' : entrance === 'portal' ? '/sign-in/client' : '/sign-in';
    redirect(params.next ? `${back}?next=${encodeURIComponent(params.next)}` : back);
  }

  /**
   * A specific destination wins over the home surface.
   *
   * Somebody following a link to a post should land on that post. Re-guarded
   * here with `safeNext` even though the sign-in form already applied it: this
   * page is reachable by typing a URL, so the form's check guards the form, not
   * this.
   */
  const next = safeNext(params.next);
  if (next) redirect(next);

  if (home.path) redirect(home.path);

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-16">
      <PageHeader eyebrow="AHN Orbit" title="You are signed in" />

      <Card className="mt-8">
        <CardBody>
          <Empty
            title="There is nothing here for you yet"
            description="Your account works, but it is not attached to an agency or a client workspace. If you were invited, the invitation may still be waiting to be accepted — or your access may have been changed."
            action={
              <Link href="/orgs/new" className={buttonClassName({ size: 'sm' })}>
                Create an organization
              </Link>
            }
          />
        </CardBody>
      </Card>
    </main>
  );
}
