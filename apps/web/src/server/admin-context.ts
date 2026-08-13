import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { SESSION_COOKIE_NAME, requireSession, resolveUser } from '@orbit/auth';
import type { AuthenticatedUser } from '@orbit/auth';
import { canPlatform, type Permission } from '@orbit/rbac';
import { logger } from '@orbit/observability';

/**
 * The server-component counterpart to `withPlatformAdmin` (SRS §28).
 *
 * Same order, same authority — `isPlatformAdmin` read from the `User` row rather
 * than a token claim — and the same answer for everyone else: `notFound()`, so a
 * tenant user browsing `/admin` cannot tell it from a typo.
 *
 * Like the wrapper, it hands back a user and no tenant context, so an admin page
 * has nothing to call `withTenant` with.
 */
export async function requirePlatformAdmin(
  permission: Permission = 'admin:view_system_logs',
): Promise<AuthenticatedUser> {
  const cookieStore = await cookies();

  let admin: AuthenticatedUser;
  try {
    const identity = await requireSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);
    admin = await resolveUser(identity);
  } catch {
    redirect('/sign-in?next=/admin');
  }

  if (!canPlatform(admin, permission)) {
    logger.warn('non-admin principal reached a platform admin page', {
      securityEvent: true,
      userId: admin.id,
      permission,
    });
    notFound();
  }

  return admin;
}
