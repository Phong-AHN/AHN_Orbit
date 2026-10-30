import { NextResponse } from 'next/server';
import { AGENT_SCOPES } from '@orbit/core';
import { agentsEnabledAnywhere } from '@/features/agent/availability';
import { json, preflight } from '@/features/agent/http';
import { issuer } from '@/features/agent/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Authorization Server Metadata (RFC 8414) for MCP clients (D-109 §6). */
export function GET() {
  if (!agentsEnabledAnywhere()) return new NextResponse(null, { status: 404 });
  const base = issuer();
  return json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: AGENT_SCOPES,
    authorization_response_iss_parameter_supported: true,
  });
}

export const OPTIONS = preflight;
