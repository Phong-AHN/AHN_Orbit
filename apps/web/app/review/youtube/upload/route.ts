import { NextResponse, type NextRequest } from 'next/server';
import { logger } from '@orbit/observability';
import {
  REVIEW_BASE_PATH,
  REVIEW_MAX_UPLOAD_BYTES,
  REVIEW_SESSION_COOKIE,
  openSession,
  reviewEnabled,
} from '@/features/google-review/session';
import { uploadVideo } from '@/features/google-review/youtube';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PRIVACY = new Set(['private', 'unlisted', 'public']);

/** `youtube.upload`, demonstrated: one video to the reviewer's own channel. */
export async function POST(request: NextRequest) {
  if (!reviewEnabled()) return new NextResponse(null, { status: 404 });

  const back = new URL(REVIEW_BASE_PATH, request.url);
  const fail = (reason: string) => {
    back.searchParams.set('error', reason);
    return NextResponse.redirect(back, 303);
  };

  const session = openSession(request.cookies.get(REVIEW_SESSION_COOKIE)?.value);
  if (!session) return fail('session');

  const form = await request.formData();
  const file = form.get('video');
  const title = String(form.get('title') ?? '')
    .trim()
    .slice(0, 100);
  const privacy = String(form.get('privacy') ?? 'private');
  const madeForKids = String(form.get('madeForKids') ?? '');

  if (!(file instanceof File) || file.size === 0) return fail('file');
  if (file.size > REVIEW_MAX_UPLOAD_BYTES) return fail('size');
  if (!file.type.startsWith('video/')) return fail('type');
  if (!title) return fail('title');
  if (!PRIVACY.has(privacy)) return fail('privacy');
  // The COPPA declaration is never assumed, here as in the product.
  if (madeForKids !== 'yes' && madeForKids !== 'no') return fail('kids');

  try {
    const { videoId } = await uploadVideo(session.accessToken, {
      title,
      description: 'Uploaded from the AHN Orbit verification review page.',
      privacyStatus: privacy as 'private' | 'unlisted' | 'public',
      madeForKids: madeForKids === 'yes',
      file,
    });
    back.searchParams.set('uploaded', videoId);
    return NextResponse.redirect(back, 303);
  } catch (error) {
    logger.warn('google review page: upload failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return fail('upload');
  }
}
