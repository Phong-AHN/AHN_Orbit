import { NextResponse } from 'next/server';
import { buildOpenApiDocument } from '@/features/openapi/document';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The OpenAPI document (SRS §44, T1.19 DoD).
 *
 * **Unauthenticated on purpose.** It describes the *shape* of the API — paths,
 * permissions, the error envelope — and contains no tenant data, no
 * configuration and no secrets. Requiring a session to read it would mean the
 * people most likely to need it (a partner integrating, an engineer debugging a
 * 404) are the ones who cannot get it, in exchange for hiding a structure that
 * anyone with an account can enumerate anyway.
 *
 * What it deliberately does *not* reveal: which organizations exist, which
 * routes a given caller may use, or anything about a tenant. Every path here is
 * one whose existence is already documented in `docs/API.md`.
 */
export function GET() {
  const version = process.env.npm_package_version ?? '0.1.0';

  return NextResponse.json(buildOpenApiDocument(version), {
    headers: {
      // Static per deployment; safe to cache and cheap to regenerate.
      'cache-control': 'public, max-age=300',
    },
  });
}
