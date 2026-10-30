import { NextResponse, type NextRequest } from 'next/server';
import { isAppError, newCorrelationId } from '@orbit/core';
import { resolveTenantContext, resolveUserById } from '@orbit/auth';
import { serverEnv } from '@orbit/config';
import { logger } from '@orbit/observability';
import { agentEnabledFor, agentsEnabledAnywhere } from '@/features/agent/availability';
import { CORS_HEADERS, clientAddress, json, preflight } from '@/features/agent/http';
import { handleMcpMessage, SUPPORTED_PROTOCOL_VERSIONS } from '@/features/agent/mcp';
import { issuer, verifyAccessToken } from '@/features/agent/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The Social Square MCP server (D-109).
 *
 * Every request: a bearer token resolved to a live grant; the person and
 * their membership resolved fresh (a removed or suspended member, or a Client,
 * is refused here, before any tool); the organization checked against the
 * rollout switch. Then one JSON-RPC message. Each tool call goes on to run
 * through `withAuth` itself, so the checks above are a front door, not the
 * only one.
 */
function unauthorized(invalidToken: boolean) {
  const metadata = `${issuer()}/.well-known/oauth-protected-resource`;
  return new NextResponse(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${metadata}"${invalidToken ? ', error="invalid_token"' : ''}`,
    },
  });
}

export async function POST(request: NextRequest) {
  if (!agentsEnabledAnywhere()) return new NextResponse(null, { status: 404 });

  const version = request.headers.get('mcp-protocol-version');
  if (version && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return json({ error: `Unsupported MCP-Protocol-Version: ${version}` }, { status: 400 });
  }

  const header = request.headers.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) return unauthorized(false);

  const grant = await verifyAccessToken(token);
  if (!grant) return unauthorized(true);

  const correlationId = request.headers.get('x-correlation-id') ?? newCorrelationId();

  let organization: { id: string; slug: string };
  try {
    const user = await resolveUserById(grant.userId);
    const resolved = await resolveTenantContext(user, grant.organizationId, correlationId);
    if (
      resolved.ctx.principal.kind !== 'USER' ||
      resolved.ctx.principal.organizationRole === 'CLIENT'
    ) {
      return json({ error: 'forbidden' }, { status: 403 });
    }
    organization = resolved.organization;
  } catch (error) {
    if (isAppError(error) && error.status < 500) return unauthorized(true);
    throw error;
  }
  if (!agentEnabledFor(organization)) return json({ error: 'forbidden' }, { status: 403 });

  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (Array.isArray(message)) {
    return json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Batches are not supported' },
    });
  }

  try {
    const response = await handleMcpMessage(message, {
      scopes: grant.scopes,
      invocation: {
        userId: grant.userId,
        organizationId: grant.organizationId,
        delegation: { channel: 'MCP', grantId: grant.grantId, scopes: grant.scopes },
      },
      origin: serverEnv().APP_URL.replace(/\/$/, ''),
      organizationSlug: organization.slug,
      forwardedFor: clientAddress(request),
      correlationId,
    });
    if (!response) return new NextResponse(null, { status: 202, headers: CORS_HEADERS });
    return json(response);
  } catch (error) {
    logger.error('mcp request failed', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: `Internal error (${correlationId})` },
    });
  }
}

/** No server-to-client stream: this server is stateless and never initiates. */
export function GET() {
  return new NextResponse(null, { status: 405, headers: { ...CORS_HEADERS, Allow: 'POST' } });
}

export const DELETE = GET;
export const OPTIONS = preflight;
