import { NextResponse, type NextRequest } from 'next/server';
import { agentsEnabledAnywhere } from '@/features/agent/availability';
import { CORS_HEADERS, preflight, readForm, withinLimit } from '@/features/agent/http';
import { revokeByToken } from '@/features/agent/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Token revocation (RFC 7009). Always 200, whether or not the token existed. */
export async function POST(request: NextRequest) {
  if (!agentsEnabledAnywhere()) return new NextResponse(null, { status: 404 });
  if (await withinLimit('revoke', request, { capacity: 30, refillWindowMs: 60_000 })) {
    const token = (await readForm(request)).get('token');
    if (token && token.length <= 200) await revokeByToken(token).catch(() => undefined);
  }
  return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export const OPTIONS = preflight;
