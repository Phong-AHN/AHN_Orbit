import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { testSlack } from '@/features/integrations/slack';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/** Send a test message to the connected channel (D-129). */
export const POST = withAuth<Params>(
  { permission: 'org:update', name: 'POST /api/v1/orgs/{orgSlug}/integrations/slack/test' },
  async ({ ctx }) => {
    await testSlack(ctx);
    return jsonOk({ sent: true });
  },
);
