import { z } from 'zod';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { getBestPostingTimes } from '@/features/analytics/insights-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

const querySchema = z.object({
  workspaceId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  socialAccountId: z.string().uuid().optional(),
  timeZone: z
    .string()
    .max(64)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown time zone')
    .optional(),
});

/**
 * When a brand's posts do best, from its own last 90 days (D-109 §8.3).
 * Computed, not generated — no model, no credit — and "not enough data" when
 * that is the truth.
 */
export const GET = withAuth<Params>(
  {
    permission: 'analytics:read',
    resource: ({ request }) => {
      const params = new URL(request.url).searchParams;
      const workspaceId = params.get('workspaceId');
      const brandId = params.get('brandId');
      return {
        ...(workspaceId ? { workspaceId } : {}),
        ...(brandId ? { brandId } : {}),
      };
    },
    name: 'GET /api/v1/orgs/{orgSlug}/analytics/best-times',
  },
  async ({ request, ctx, organization }) => {
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const { timeZone, ...filter } = query;
    return jsonOk(
      await getBestPostingTimes(
        ctx,
        Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined)),
        timeZone ?? organization.timezone,
      ),
    );
  },
);
