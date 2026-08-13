import { listAccessibleOrganizations } from '@orbit/auth';
import { currentCorrelationId } from '@orbit/observability';
import { newCorrelationId } from '@orbit/core';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withUser } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { createOrganizationSchema } from '@/features/tenancy/contracts';
import { createOrganization } from '@/features/tenancy/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Organizations the caller belongs to. Authenticated, not tenant-scoped. */
export const GET = withUser({ name: 'GET /api/v1/orgs' }, async ({ user }) =>
  jsonOk({ organizations: await listAccessibleOrganizations(user.id) }),
);

/**
 * Create an organization; the caller becomes its Owner.
 *
 * Needs no permission because it creates the tenant it would be checked
 * against — any authenticated user may start an agency.
 */
export const POST = withUser({ name: 'POST /api/v1/orgs' }, async ({ request, user }) => {
  const input = await readJsonBody(request, createOrganizationSchema);

  const organization = await createOrganization(
    user.id,
    input,
    requestFingerprint(request),
    currentCorrelationId() ?? newCorrelationId(),
  );

  return jsonOk({ organization }, { status: 201 });
});
