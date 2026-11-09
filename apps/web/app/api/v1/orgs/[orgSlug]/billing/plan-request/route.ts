import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { planRequestSchema } from '@/features/billing/contracts';
import { requestPlanChange, withdrawPlanRequest } from '@/features/billing/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * Ask for another plan (D-116).
 *
 * `billing:manage`, which only the Owner holds. Asking changes nothing about
 * the plan: it records the request, and a platform administrator applies the
 * plan once AHN has arranged payment.
 */
export const POST = withAuth<Params>(
  { permission: 'billing:manage', name: 'POST /api/v1/orgs/{orgSlug}/billing/plan-request' },
  async ({ request, ctx }) => {
    // What a plan grants comes from the catalogue when it is approved; a body
    // that tries to say so is refused rather than quietly stripped.
    const input = await readJsonBody(request, planRequestSchema, {
      alsoForbid: ['limits', 'status', 'price', 'seats'],
    });
    const planRequest = await requestPlanChange(ctx, input, requestFingerprint(request));
    return jsonOk({ planRequest }, { status: 201 });
  },
);

/** Withdraw the request that is waiting. */
export const DELETE = withAuth<Params>(
  { permission: 'billing:manage', name: 'DELETE /api/v1/orgs/{orgSlug}/billing/plan-request' },
  async ({ request, ctx }) => {
    const planRequest = await withdrawPlanRequest(ctx, requestFingerprint(request));
    return jsonOk({ planRequest });
  },
);
