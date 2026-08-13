import { NextResponse, type NextRequest } from 'next/server';
import { PLATFORMS, NotFoundError, ValidationError, newCorrelationId } from '@orbit/core';
import { getProvider } from '@orbit/providers';
import { serverEnv } from '@orbit/config';
import {
  SESSION_COOKIE_NAME,
  requireSession,
  resolveTenantContext,
  resolveUser,
} from '@orbit/auth';
import { assertCan } from '@orbit/rbac';
import { logError, logger, withLogContext } from '@orbit/observability';
import { handleRouteError } from '@/server/api-response';
import { ensureProvidersRegistered } from '@/server/providers';
import {
  OAUTH_STATE_COOKIE,
  clearedOAuthStateCookie,
  verifyOAuthState,
} from '@/features/social/oauth-state';
import { stageDiscoveredAccounts } from '@/features/social/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * OAuth callback.
 *
 * Not wrapped in `withAuth` because the tenant comes from the **signed state**
 * rather than the URL — the provider controls this redirect, so nothing in the
 * query string is trusted beyond the code, and even that is only usable once
 * the state has been verified against the session.
 *
 * Order here mirrors `withAuth` exactly:
 *   1. authenticate (session cookie)
 *   2. resolve user
 *   3. verify state → tenant (signature, expiry, nonce, session binding)
 *   4. authorize (social_account:connect on the state's workspace)
 *   5. exchange the code and hand back the discovered accounts
 *
 * The discovered accounts are returned to the browser via a one-time page
 * rather than persisted here: connecting is an explicit second step, because a
 * Meta authorization can surface Pages the user did not mean to connect.
 */
export async function GET(
  request: NextRequest,
  routeContext: { params: Promise<{ platform: string }> },
): Promise<Response> {
  const correlationId = newCorrelationId();
  const route = 'GET /api/v1/social/oauth/{platform}/callback';

  return withLogContext({ correlationId, route }, async () => {
    try {
      ensureProvidersRegistered();

      const { platform: platformParam } = await routeContext.params;
      const platform = platformParam.toUpperCase();
      if (!(PLATFORMS as readonly string[]).includes(platform)) {
        throw new NotFoundError('Platform');
      }

      const url = new URL(request.url);

      // The user declined, or Meta refused. This is not an error to shout about.
      const providerError = url.searchParams.get('error');
      if (providerError) {
        logger.info('oauth flow was not completed', {
          platform,
          error: providerError,
          reason: url.searchParams.get('error_reason'),
        });
        return redirectWithMessage(request, 'connection-cancelled');
      }

      // 1–2. Authenticate and resolve the user.
      const identity = await requireSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
      const user = await resolveUser(identity);

      // 3. Verify state → this is where the tenant comes from.
      const payload = verifyOAuthState({
        state: url.searchParams.get('state'),
        cookieNonce: request.cookies.get(OAUTH_STATE_COOKIE)?.value,
        sessionUserId: user.id,
      });

      if (payload.platform !== platform) {
        throw new ValidationError('State does not match the callback platform', {
          userMessage: 'That connection link is no longer valid. Please start again.',
          context: { securityEvent: true },
        });
      }

      const { ctx } = await resolveTenantContext(user, payload.organizationId, correlationId);

      // 4. Authorize against the workspace the flow was started for.
      assertCan(ctx, 'social_account:connect', { workspaceId: payload.workspaceId });

      const code = url.searchParams.get('code');
      if (!code) throw new ValidationError('Authorization code missing');

      // 5. Exchange server-side. The app secret never leaves this process.
      const provider = getProvider(platform as (typeof PLATFORMS)[number]);
      const redirectUri = `${serverEnv().APP_URL}/api/v1/social/oauth/${platformParam.toLowerCase()}/callback`;
      const discovered = await provider.exchangeCode({
        code,
        redirectUri,
        // From the signed state, never from the callback URL.
        ...(payload.accountType ? { accountType: payload.accountType } : {}),
      });

      logger.info('oauth exchange completed', {
        platform,
        organizationId: ctx.organizationId,
        discoveredCount: discovered.accounts.length,
      });

      // Stage the discovered accounts as DISABLED rows with sealed credentials.
      // No token ever goes into a cookie or a URL; the picker works from ids.
      await stageDiscoveredAccounts(ctx, {
        platform: platform as (typeof PLATFORMS)[number],
        workspaceId: payload.workspaceId,
        brandId: payload.brandId,
        discovered: discovered.accounts,
      });

      const target = payload.returnTo ?? `/${payload.organizationId}/settings/accounts`;

      const response = redirectWithMessage(request, 'select-accounts', target);
      response.cookies.set(clearedOAuthStateCookie());
      return response;
    } catch (error) {
      logError('oauth callback failed', error, { route });
      return handleRouteError(error, route);
    }
  });
}

function redirectWithMessage(request: NextRequest, status: string, path = '/'): NextResponse {
  const target = new URL(path, serverEnv().APP_URL);
  target.searchParams.set('connection', status);
  const response = NextResponse.redirect(target);
  response.cookies.set(clearedOAuthStateCookie());
  void request;
  return response;
}
