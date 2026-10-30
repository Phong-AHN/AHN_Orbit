import { NextResponse, type NextRequest } from 'next/server';
import { agentsEnabledAnywhere } from '@/features/agent/availability';
import { json, oauthError, preflight, withinLimit } from '@/features/agent/http';
import { registerClient } from '@/features/agent/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Dynamic Client Registration (RFC 7591), public clients only (D-109 §6).
 *
 * Registering grants nothing: a client is a name and redirect URIs until a
 * person approves it on the consent screen, which shows both. Ten
 * registrations an hour per address keeps the table from being flooded.
 */
export async function POST(request: NextRequest) {
  if (!agentsEnabledAnywhere()) return new NextResponse(null, { status: 404 });
  if (!(await withinLimit('register', request, { capacity: 10, refillWindowMs: 3_600_000 }))) {
    return json({ error: 'slow_down' }, { status: 429 });
  }

  try {
    const metadata = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const client = await registerClient(metadata);
    return json(
      {
        client_id: client.clientId,
        client_name: client.name,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_id_issued_at: Math.floor(Date.now() / 1000),
      },
      { status: 201 },
    );
  } catch (error) {
    return oauthError(error);
  }
}

export const OPTIONS = preflight;
