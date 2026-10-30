import { NextResponse, type NextRequest } from 'next/server';
import { takeToken } from '@orbit/queue';
import { logger } from '@orbit/observability';
import { OAuthError } from './oauth';

/**
 * HTTP plumbing shared by the OAuth and MCP endpoints (D-109).
 *
 * These endpoints take bearer tokens or no credentials at all — never the
 * session cookie — so allowing any origin is safe here and lets browser-based
 * MCP clients reach them. The consent page and the confirmation routes, which
 * do use the cookie, are not served through this.
 */
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, MCP-Protocol-Version',
} as const;

export function preflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return NextResponse.json(body, {
    status: init.status ?? 200,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store', ...init.headers },
  });
}

export function oauthError(error: unknown): NextResponse {
  if (error instanceof OAuthError) {
    return json(
      { error: error.error, error_description: error.description },
      { status: error.error === 'invalid_client' ? 401 : 400 },
    );
  }
  logger.error('oauth endpoint failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  return json({ error: 'server_error' }, { status: 500 });
}

export function clientAddress(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

/**
 * A per-address ceiling for unauthenticated endpoints. Fails open when Redis is
 * down, like the AI limiter: these endpoints are still protected by what they
 * check, and refusing everyone would be an outage of sign-in for AI apps.
 */
export async function withinLimit(
  bucket: string,
  request: NextRequest,
  config: { capacity: number; refillWindowMs: number },
): Promise<boolean> {
  const result = await takeToken(
    `ratelimit:oauth:${bucket}:${clientAddress(request)}`,
    config,
  ).catch(() => ({ allowed: true, retryAfterMs: 0 }));
  return result.allowed;
}

/** Read a token-endpoint body: form-encoded per RFC 6749, JSON tolerated. */
export async function readForm(request: NextRequest): Promise<URLSearchParams> {
  const type = request.headers.get('content-type') ?? '';
  const text = (await request.text()).slice(0, 16_384);
  if (type.includes('application/json')) {
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      return new URLSearchParams(
        Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'),
      );
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(text);
}
