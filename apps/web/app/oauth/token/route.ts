import { NextResponse, type NextRequest } from 'next/server';
import { agentsEnabledAnywhere } from '@/features/agent/availability';
import { json, oauthError, preflight, readForm, withinLimit } from '@/features/agent/http';
import { OAuthError, exchangeAuthorizationCode, refreshTokens } from '@/features/agent/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The token endpoint (D-109 §6): code + PKCE, or a refresh token that rotates. */
export async function POST(request: NextRequest) {
  if (!agentsEnabledAnywhere()) return new NextResponse(null, { status: 404 });
  if (!(await withinLimit('token', request, { capacity: 30, refillWindowMs: 60_000 }))) {
    return json({ error: 'slow_down' }, { status: 429 });
  }

  try {
    const form = await readForm(request);
    const clientId = form.get('client_id') ?? '';
    if (!clientId) throw new OAuthError('invalid_request', 'client_id is required.');

    switch (form.get('grant_type')) {
      case 'authorization_code':
        return json(
          await exchangeAuthorizationCode({
            code: form.get('code') ?? '',
            clientId,
            redirectUri: form.get('redirect_uri') ?? '',
            codeVerifier: form.get('code_verifier') ?? '',
            resource: form.get('resource'),
          }),
        );
      case 'refresh_token':
        return json(
          await refreshTokens({ refreshToken: form.get('refresh_token') ?? '', clientId }),
        );
      default:
        throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
    }
  } catch (error) {
    return oauthError(error);
  }
}

export const OPTIONS = preflight;
