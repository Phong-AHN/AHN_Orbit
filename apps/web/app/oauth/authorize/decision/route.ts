import { NextResponse, type NextRequest } from 'next/server';
import { AGENT_SCOPES, newCorrelationId, type AgentScope } from '@orbit/core';
import {
  SESSION_COOKIE_NAME,
  requireSession,
  resolveTenantContext,
  resolveUser,
} from '@orbit/auth';
import { logger } from '@orbit/observability';
import { agentEnabledFor, agentsEnabledAnywhere } from '@/features/agent/availability';
import {
  OAuthError,
  issueAuthorizationCode,
  issuer,
  validateAuthorizationRequest,
} from '@/features/agent/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The person's answer on the consent screen (D-109 §6).
 *
 * The authorization request is validated again from scratch — the hidden
 * fields are the person's own browser talking, not a trusted record. The
 * organization comes from the form because the person is choosing it, and it
 * is cross-checked against their membership exactly as a URL's would be. The
 * session cookie is `SameSite=Lax`, so another site cannot post this for them.
 */
export async function POST(request: NextRequest) {
  if (!agentsEnabledAnywhere()) return new NextResponse(null, { status: 404 });

  const form = await request.formData();
  const params = new URLSearchParams();
  for (const [key, value] of form.entries()) {
    if (key.startsWith('req_') && typeof value === 'string') params.set(key.slice(4), value);
  }

  let authorization;
  try {
    authorization = await validateAuthorizationRequest(params);
  } catch (error) {
    const message = error instanceof OAuthError ? error.description : 'Invalid request.';
    return new NextResponse(message, { status: 400 });
  }

  const back = new URL(authorization.redirectUri);
  if (authorization.state) back.searchParams.set('state', authorization.state);
  back.searchParams.set('iss', issuer());

  if (form.get('decision') !== 'allow') {
    back.searchParams.set('error', 'access_denied');
    return NextResponse.redirect(back, 303);
  }

  let user;
  try {
    user = await resolveUser(await requireSession(request.cookies.get(SESSION_COOKIE_NAME)?.value));
  } catch {
    return new NextResponse('Sign in again, then retry from the AI app.', { status: 401 });
  }

  const organizationId = String(form.get('organizationId') ?? '');
  const scopes = form
    .getAll('scope')
    .filter(
      (s): s is AgentScope =>
        typeof s === 'string' && (AGENT_SCOPES as readonly string[]).includes(s),
    );

  try {
    const { ctx, organization } = await resolveTenantContext(
      user,
      organizationId,
      newCorrelationId(),
    );
    if (!agentEnabledFor(organization))
      throw new OAuthError('access_denied', 'AI apps are not enabled for this organization.');

    const code = await issueAuthorizationCode(ctx, authorization, scopes);
    back.searchParams.set('code', code);
    logger.info('agent access approved', {
      organizationId: organization.id,
      userId: user.id,
      clientName: authorization.clientName,
      scopes,
    });
    return NextResponse.redirect(back, 303);
  } catch (error) {
    logger.warn('agent access refused', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
    back.searchParams.set('error', 'access_denied');
    return NextResponse.redirect(back, 303);
  }
}
