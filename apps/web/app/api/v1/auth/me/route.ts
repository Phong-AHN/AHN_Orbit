import { listAccessibleOrganizations } from '@orbit/auth';
import { withUser } from '@/server/with-auth';
import { jsonOk } from '@/server/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The current user and the organizations they may enter.
 *
 * Authenticated but deliberately *not* tenant-scoped — this is the call a
 * client makes before it knows which organization it is working in. It
 * therefore returns memberships only, never any tenant content.
 *
 * Per-organization permissions are not returned here: they depend on the
 * organization, and handing back a merged set would invite the frontend to
 * treat them as global. `GET /orgs/{orgSlug}/me` carries those.
 */
export const GET = withUser({ name: 'GET /api/v1/auth/me' }, async ({ user }) => {
  const organizations = await listAccessibleOrganizations(user.id);

  return jsonOk({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      timezone: user.timezone,
      isPlatformAdmin: user.isPlatformAdmin,
    },
    organizations,
  });
});
