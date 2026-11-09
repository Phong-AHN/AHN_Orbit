import { currentCorrelationId } from '@orbit/observability';
import { jsonOk } from '@/server/api-response';
import { readJsonBody } from '@/server/with-auth';
import { withPlatformAdmin } from '@/server/with-platform-admin';
import { requestFingerprint } from '@/server/audit';
import { PROTECTED_ADMIN_FIELDS } from '@/features/admin/contracts';
import { decidePlanRequest } from '@/features/admin/plans';
import { planDecisionSchema } from '@/features/billing/contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { requestId: string };

/**
 * Approve or decline an organization's request to change plan (D-116).
 *
 * Body `{ decision, reason }` and nothing else. The organization and the plan
 * come from the stored request, so an administrator approves exactly what was
 * asked for and cannot name another plan, other limits, or another tenant. The
 * reason is mandatory and lands in that organization's own audit log, in the
 * same transaction as the plan change.
 */
export const POST = withPlatformAdmin<Params>(
  {
    permission: 'admin:change_plan',
    name: 'POST /api/v1/admin/plan-requests/{requestId}/decision',
  },
  async ({ request, params, admin }) => {
    const input = await readJsonBody(request, planDecisionSchema, {
      alsoForbid: [...PROTECTED_ADMIN_FIELDS, 'plan', 'limits', 'status'],
    });

    const correlationId = currentCorrelationId();
    const decided = await decidePlanRequest(admin, params.requestId, input, {
      ...requestFingerprint(request),
      ...(correlationId ? { correlationId } : {}),
    });

    return jsonOk({ planRequest: decided });
  },
);
