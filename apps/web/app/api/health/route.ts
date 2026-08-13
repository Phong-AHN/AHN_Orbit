import { NextResponse } from 'next/server';
import { clock } from '@orbit/core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Liveness. Deliberately touches nothing — a dependency outage must not cause
 * the orchestrator to restart an otherwise healthy process.
 */
export function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'web',
    time: clock.now().toISOString(),
  });
}
