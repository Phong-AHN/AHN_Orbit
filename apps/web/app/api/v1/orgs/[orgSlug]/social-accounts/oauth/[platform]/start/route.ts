import { z } from 'zod';
import { PLATFORMS, ValidationError } from '@orbit/core';
import { getProvider } from '@orbit/providers';
import { serverEnv } from '@orbit/config';
import { withTenant } from '@orbit/db';
import { NotFoundError } from '@orbit/core';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { ensureProvidersRegistered } from '@/server/providers';
import { issueOAuthState, oauthStateCookie } from '@/features/social/oauth-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; platform: string };

const bodySchema = z.object({
  workspaceId: z.string().uuid(),
  brandId: z.string().uuid(),
  returnTo: z.string().max(512).optional(),
  /** Which login surface, where the platform has more than one. */
  accountType: z.string().max(40).optional(),
});

/**
 * Begin an OAuth connection.
 *
 * Returns the authorization URL and sets the state cookie. The browser
 * navigates; nothing about the flow is trusted from the client afterwards —
 * the callback re-derives everything from the signed state plus the session.
 */
export const POST = withAuth<Params>(
  {
    permission: 'social_account:connect',
    resource: async ({ request }) => {
      // The body carries the workspace, so the permission check is scoped to it
      // rather than to the whole organization.
      const body = await request
        .clone()
        .json()
        .catch(() => ({}));
      const parsed = bodySchema.partial().safeParse(body);
      return parsed.success && parsed.data.workspaceId
        ? { workspaceId: parsed.data.workspaceId }
        : {};
    },
    name: 'POST /api/v1/orgs/{orgSlug}/social-accounts/oauth/{platform}/start',
  },
  async ({ request, ctx, params, user }) => {
    ensureProvidersRegistered();

    const platform = params.platform.toUpperCase();
    if (!(PLATFORMS as readonly string[]).includes(platform)) {
      throw new NotFoundError('Platform');
    }

    const input = await readJsonBody(request, bodySchema);

    // Confirm the brand belongs to this tenant *and* the named workspace before
    // starting a flow that will attach credentials to it.
    const brand = await withTenant(ctx, (db) =>
      db.brand.findFirst({
        where: { id: input.brandId, workspaceId: input.workspaceId, deletedAt: null },
        select: { id: true },
      }),
    );
    if (!brand) throw new NotFoundError('Brand');

    // Only relative paths, so `returnTo` cannot become an open redirect.
    if (input.returnTo && !input.returnTo.startsWith('/')) {
      throw new ValidationError('returnTo must be a relative path', {
        userMessage: 'That return location is not allowed.',
      });
    }

    const provider = getProvider(platform as (typeof PLATFORMS)[number]);
    const redirectUri = `${serverEnv().APP_URL}/api/v1/social/oauth/${platform.toLowerCase()}/callback`;

    const { state, nonce } = issueOAuthState({
      platform: platform as (typeof PLATFORMS)[number],
      ...(input.accountType ? { accountType: input.accountType } : {}),
      organizationId: ctx.organizationId,
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      userId: user.id,
      returnTo: input.returnTo,
    });

    const { url, scopes } = provider.getAuthorizationUrl({
      redirectUri,
      state,
      ...(input.accountType ? { accountType: input.accountType } : {}),
    });

    const response = jsonOk({ authorizationUrl: url, scopes });
    response.cookies.set(oauthStateCookie(nonce));
    return response;
  },
);
