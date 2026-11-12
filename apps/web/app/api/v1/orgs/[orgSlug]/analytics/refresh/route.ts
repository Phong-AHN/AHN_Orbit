import { z } from 'zod';
import { currentCorrelationId } from '@orbit/observability';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { refreshAnalyticsNow } from '@/features/analytics/refresh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

const refreshSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
});

/**
 * Queue a read of Page and post figures now (D-122).
 *
 * `POST`: it has an effect and it spends provider quota, so nothing may
 * prefetch it. No `permission` on the wrapper: `report:generate` is
 * workspace-scoped for some roles, and the service asks it with the workspace
 * when one is named, then narrows the accounts to those the caller can reach.
 *
 * Returns how many accounts and posts were queued — not figures, which do not
 * exist until the worker has read them.
 */
export const POST = withAuth<Params>(
  { name: 'POST /api/v1/orgs/{orgSlug}/analytics/refresh' },
  async ({ request, ctx }) => {
    const body = await readJsonBody(request, refreshSchema);
    return jsonOk(
      await refreshAnalyticsNow(
        ctx,
        {
          ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
          ...(body.accountId ? { socialAccountId: body.accountId } : {}),
        },
        currentCorrelationId() ?? `analytics-refresh-${ctx.organizationId}`,
      ),
    );
  },
);
