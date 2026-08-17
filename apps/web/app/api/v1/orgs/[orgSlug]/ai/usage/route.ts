import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { getCreditStatus } from '@/features/ai/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * Credits used this month against the plan limit (SRS §38).
 *
 * `ai:view_usage`, which only an Owner or Admin holds — what an organization
 * spends is a billing question, not a writing one, and a Content Creator who
 * may generate has no business seeing the account's consumption.
 */
export const GET = withAuth<Params>(
  { permission: 'ai:view_usage', name: 'GET /api/v1/orgs/{orgSlug}/ai/usage' },
  async ({ ctx }) => {
    const status = await getCreditStatus(ctx);

    return jsonOk({
      used: status.used,
      limit: status.limit ?? null,
      remaining: status.remaining ?? null,
      periodStart: status.periodStart.toISOString(),
    });
  },
);
