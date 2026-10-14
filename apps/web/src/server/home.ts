import { cookies } from 'next/headers';
import {
  SESSION_COOKIE_NAME,
  listAccessibleOrganizations,
  requireSession,
  resolveUser,
  type AuthenticatedUser,
} from '@orbit/auth';
import { canPlatform } from '@orbit/rbac';
import { resolveHome, type Entrance, type Home } from '@/features/navigation/home';
import { portalWorkspacesFor } from './portal-context';

/**
 * Gathering the facts `resolveHome` decides from.
 *
 * The decision itself is pure and lives in `features/navigation/home.ts` with
 * its tests; this half is the database and the cookie. Keeping them apart is
 * what makes the ordering rules — which surface wins, when the entrance breaks
 * a tie — assertable without a session or a tenant.
 */

export type { Entrance, Home };

/**
 * Resolve where the signed-in person belongs, or null if nobody is signed in.
 *
 * Null rather than a redirect to sign-in: every caller already has its own
 * answer for an absent session, and two of them want to render rather than
 * redirect.
 */
export async function homeForSession(entrance?: Entrance): Promise<Home | null> {
  const user = await currentUser();
  if (!user) return null;

  return homeForUser(user, entrance);
}

export async function homeForUser(user: AuthenticatedUser, entrance?: Entrance): Promise<Home> {
  // Both lists in parallel: neither depends on the other, and a client with
  // several organizations otherwise pays for two serial fan-outs.
  const [organizations, workspaces] = await Promise.all([
    listAccessibleOrganizations(user.id),
    portalWorkspacesFor(user),
  ]);

  return resolveHome(
    {
      // A CLIENT membership is not staff membership, and this is the line that
      // says so. Everything else about surface separation follows from it.
      agency: organizations.filter((o) => o.role !== 'CLIENT').map((o) => ({ slug: o.slug })),
      portal: workspaces.map((w) => ({ id: w.id })),
      isPlatformAdmin: canPlatform(user, 'admin:view_system_logs'),
    },
    entrance,
  );
}

/** The signed-in user, or null. Never redirects. */
export async function currentUser(): Promise<AuthenticatedUser | null> {
  const cookieStore = await cookies();

  try {
    const identity = await requireSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);
    return await resolveUser(identity);
  } catch {
    return null;
  }
}
