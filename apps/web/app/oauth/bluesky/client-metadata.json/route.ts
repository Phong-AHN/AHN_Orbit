import { NextResponse } from 'next/server';
import { serverEnv } from '@orbit/config';
import { blueskyClientMetadata } from '@orbit/providers/bluesky';
import { parseBlueskyKey } from '@/server/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Who Social Square is, to Bluesky (D-112).
 *
 * atproto has no developer portal: a client is identified by the URL of this
 * document, which every authorization server fetches before it will deal with
 * us. Its `client_id` must equal the URL it was served from, so it is built
 * from `APP_URL` by the same function the adapter takes its client id from.
 *
 * Public by design, and holds nothing secret — the key it points to is the
 * public half. Not served at all where Bluesky is not configured.
 */
export function GET() {
  const env = serverEnv();
  if (!parseBlueskyKey(env.BLUESKY_PRIVATE_KEY)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  return NextResponse.json(blueskyClientMetadata(env.APP_URL), {
    // Authorization servers cache it; a short lifetime lets a change land.
    headers: { 'cache-control': 'public, max-age=300' },
  });
}
