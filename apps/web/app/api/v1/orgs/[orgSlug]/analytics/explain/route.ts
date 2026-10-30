import { ValidationError } from '@orbit/core';
import { assertCan } from '@orbit/rbac';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { aiProvider } from '@/server/ai-provider';
import { explainRequestSchema } from '@/features/ai/contracts';
import { explainPerformance } from '@/features/analytics/insights-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = { orgSlug: string };

const DAY_MS = 24 * 60 * 60_000;

/**
 * A period's figures against the one before, with a plain-language reading
 * (D-109 §8.4). The figures are always returned; the reading only when every
 * number in it is one of them.
 */
export const POST = withAuth<Params>(
  {
    permission: 'analytics:read',
    resource: async ({ request }) => {
      const body = (await request
        .clone()
        .json()
        .catch(() => ({}))) as { brandId?: unknown };
      return typeof body.brandId === 'string' ? { brandId: body.brandId } : {};
    },
    name: 'POST /api/v1/orgs/{orgSlug}/analytics/explain',
  },
  async ({ request, ctx }) => {
    const input = await readJsonBody(request, explainRequestSchema);
    assertCan(ctx, 'ai:generate', { brandId: input.brandId });

    const from = new Date(`${input.from}T00:00:00.000Z`);
    const to = new Date(`${input.to}T23:59:59.999Z`);
    if (from > to || to.getTime() - from.getTime() > 186 * DAY_MS) {
      throw new ValidationError('Invalid range', {
        userMessage: 'Choose a period of up to six months that starts before it ends.',
      });
    }

    return jsonOk(
      await explainPerformance(ctx, { brandId: input.brandId, range: { from, to } }, aiProvider()),
    );
  },
);
