import { NextResponse } from 'next/server';
import { AGENT_SCOPES } from '@orbit/core';
import { agentsEnabledAnywhere } from '@/features/agent/availability';
import { json, preflight } from '@/features/agent/http';
import { issuer, mcpResource } from '@/features/agent/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Protected Resource Metadata (RFC 9728) for `/api/mcp` (D-109 §6). Served at
 * the root and at the path-suffixed form clients derive from the resource URL.
 */
export function GET() {
  if (!agentsEnabledAnywhere()) return new NextResponse(null, { status: 404 });
  return json({
    resource: mcpResource(),
    authorization_servers: [issuer()],
    scopes_supported: AGENT_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Social Square',
  });
}

export const OPTIONS = preflight;
