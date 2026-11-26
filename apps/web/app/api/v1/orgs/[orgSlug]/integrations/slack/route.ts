import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { saveSlackSchema } from '@/features/integrations/contracts';
import {
  disconnectSlack,
  getSlackIntegration,
  saveSlackIntegration,
} from '@/features/integrations/slack';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * The organization's Slack channel (D-129).
 *
 * `org:update` for reading as well as writing: which channel an agency's
 * publishing alerts go to is configuration, not something every member needs.
 * The webhook URL is never in a response.
 */
export const GET = withAuth<Params>(
  { permission: 'org:update', name: 'GET /api/v1/orgs/{orgSlug}/integrations/slack' },
  async ({ ctx }) => jsonOk({ slack: await getSlackIntegration(ctx) }),
);

export const PUT = withAuth<Params>(
  { permission: 'org:update', name: 'PUT /api/v1/orgs/{orgSlug}/integrations/slack' },
  async ({ request, ctx, user }) => {
    const input = await readJsonBody(request, saveSlackSchema);
    const slack = await saveSlackIntegration(
      ctx,
      input,
      { name: user.name },
      requestFingerprint(request),
    );
    return jsonOk({ slack });
  },
);

export const DELETE = withAuth<Params>(
  { permission: 'org:update', name: 'DELETE /api/v1/orgs/{orgSlug}/integrations/slack' },
  async ({ request, ctx }) => {
    await disconnectSlack(ctx, requestFingerprint(request));
    return jsonOk({ slack: { connected: false } });
  },
);
