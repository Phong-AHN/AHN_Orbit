import { NextResponse } from 'next/server';
import { serverEnv } from '@orbit/config';
import { keyFromPrivateJwk } from '@orbit/providers/bluesky';
import { parseBlueskyKey } from '@/server/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The public half of Social Square's Bluesky client key (D-112).
 *
 * Authorization servers verify our `private_key_jwt` assertions against this.
 * Only `kty`, `crv`, `x`, `y`, `kid`, `alg` and `use` leave the server: the
 * public key is derived from the private one here, and `d` is never copied.
 */
export function GET() {
  const key = parseBlueskyKey(serverEnv().BLUESKY_PRIVATE_KEY);
  if (!key) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const { publicJwk } = keyFromPrivateJwk(key);
  return NextResponse.json(
    { keys: [{ ...publicJwk, alg: 'ES256', use: 'sig' }] },
    { headers: { 'cache-control': 'public, max-age=300' } },
  );
}
