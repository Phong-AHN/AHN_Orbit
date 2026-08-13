import { z } from 'zod';
import { NotFoundError, PLATFORMS } from '@orbit/core';
import { getProvider } from '@orbit/providers';
import { withTenant } from '@orbit/db';
import { logger } from '@orbit/observability';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { ensureProvidersRegistered } from '@/server/providers';
import { stageDiscoveredAccounts } from '@/features/social/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; platform: string };

const bodySchema = z.object({
  /** From `FB.login` with `response_type: 'code'` — never an access token. */
  code: z.string().min(1).max(2048),
  workspaceId: z.string().uuid(),
  brandId: z.string().uuid(),
});

/**
 * The JavaScript SDK's half of the connect flow.
 *
 * `FB.login` is configured to hand back an authorization **code**, not an
 * access token, so this endpoint does exactly what the redirect callback does:
 * exchange server-side with the app secret, walk short-lived → long-lived →
 * Page tokens, and stage the results as DISABLED rows for the picker. No token
 * exists in the browser at any point, which is the property the whole
 * credential design rests on (docs/SECURITY.md §6).
 *
 * **Why there is no signed `state` here.** The redirect flow needs one because
 * the tenant arrives back through a URL the user was sent to by a third party;
 * the signature is what stops an attacker completing *their* consent inside
 * *your* session. This is not that shape. It is a same-origin `POST` carrying
 * the session cookie, so `withAuth` authenticates it, `assertCan` authorizes
 * the named workspace, and the tenant comes from the session rather than from
 * anything the request asserts. A cross-site page cannot make this call: the
 * cookie is `SameSite=Lax` and this is a JSON `POST`.
 *
 * The redirect flow stays — it is what reconnection uses, and it is the
 * fallback when no Login for Business configuration is set.
 */
export const POST = withAuth<Params>(
  {
    permission: 'social_account:connect',
    resource: async ({ request }) => {
      // The body names the workspace, so the permission check is scoped to it
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
    name: 'POST /api/v1/orgs/{orgSlug}/social-accounts/oauth/{platform}/exchange',
  },
  async ({ request, ctx, params }) => {
    ensureProvidersRegistered();

    const platform = params.platform.toUpperCase();
    if (!(PLATFORMS as readonly string[]).includes(platform)) {
      throw new NotFoundError('Platform');
    }

    const input = await readJsonBody(request, bodySchema);

    // Confirm the brand belongs to this tenant *and* the named workspace before
    // attaching credentials to it. Scoped, so another tenant's id is not found.
    const brand = await withTenant(ctx, (db) =>
      db.brand.findFirst({
        where: { id: input.brandId, workspaceId: input.workspaceId, deletedAt: null },
        select: { id: true },
      }),
    );
    if (!brand) throw new NotFoundError('Brand');

    const provider = getProvider(platform as (typeof PLATFORMS)[number]);

    // Empty, deliberately. Meta requires `redirect_uri` to be blank when the
    // code came from the JavaScript SDK — there was no redirect to match it
    // against. Sending our callback URL here fails the exchange.
    const discovered = await provider.exchangeCode({ code: input.code, redirectUri: '' });

    logger.info('oauth exchange completed', {
      platform,
      organizationId: ctx.organizationId,
      discoveredCount: discovered.accounts.length,
      via: 'js-sdk',
    });

    const staged = await stageDiscoveredAccounts(ctx, {
      platform: platform as (typeof PLATFORMS)[number],
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      discovered: discovered.accounts,
    });

    // Only a count leaves this endpoint. The picker reads the staged rows
    // through the normal, permission-checked listing.
    return jsonOk({ staged: staged.length });
  },
);
