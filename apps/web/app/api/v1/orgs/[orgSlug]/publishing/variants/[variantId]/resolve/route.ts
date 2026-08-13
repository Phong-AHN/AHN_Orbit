import type { TenantContext } from '@orbit/core';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { PROTECTED_PUBLISHING_FIELDS, resolveParkedSchema } from '@/features/publishing/contracts';
import { variantScope } from '@/features/publishing/logs';
import { resolveParkedVariant } from '@/features/publishing/resolve';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; variantId: string };

async function scope({ params, ctx }: { params: Params; ctx: TenantContext }) {
  const post = await variantScope(ctx, params.variantId);
  return {
    workspaceId: post.workspaceId,
    brandId: post.brandId,
    createdById: post.createdById,
    // Resolving a parked publish acts on a post whose status is past the edit
    // lock by definition, so this is a publishing act rather than a content
    // edit (decision D-016).
    intent: 'TRANSITION' as const,
  };
}

/**
 * Record what actually happened to a parked publish.
 *
 * Guarded by `post:retry_failed`, which docs/RBAC.md restricts to Owner, Admin
 * and Account Manager — the roles that already carry responsibility for a
 * broken publish. A reason is mandatory and the action is audited as a security
 * event: this is a person overriding a machine that said "I don't know".
 */
export const POST = withAuth<Params>(
  {
    permission: 'post:retry_failed',
    resource: scope,
    name: 'POST /api/v1/orgs/{orgSlug}/publishing/variants/{variantId}/resolve',
  },
  async ({ request, ctx, params }) => {
    const input = await readJsonBody(request, resolveParkedSchema, {
      alsoForbid: PROTECTED_PUBLISHING_FIELDS,
    });

    return jsonOk(
      await resolveParkedVariant(ctx, params.variantId, input, requestFingerprint(request)),
    );
  },
);
