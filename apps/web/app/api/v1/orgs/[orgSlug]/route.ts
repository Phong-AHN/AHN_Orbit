import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { updateOrganizationSchema } from '@/features/tenancy/contracts';
import { getOrganization, updateOrganization } from '@/features/tenancy/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

export const GET = withAuth<Params>(
  { permission: 'org:read', name: 'GET /api/v1/orgs/{orgSlug}' },
  async ({ ctx }) => jsonOk({ organization: await getOrganization(ctx) }),
);

export const PATCH = withAuth<Params>(
  { permission: 'org:update', name: 'PATCH /api/v1/orgs/{orgSlug}' },
  async ({ request, ctx }) => {
    const patch = await readJsonBody(request, updateOrganizationSchema);
    const organization = await updateOrganization(ctx, patch, requestFingerprint(request));
    return jsonOk({ organization });
  },
);
