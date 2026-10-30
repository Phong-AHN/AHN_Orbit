import { z } from 'zod';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { sendMessage } from '@/features/copilot/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = { orgSlug: string };

const bodySchema = z.object({
  threadId: z.string().uuid().nullish(),
  text: z.string().trim().min(1).max(4_000),
});

/**
 * Send the Copilot a message (D-109 phase 5). A person's act in their own
 * session; every tool the Copilot then uses checks that person's rights, and
 * outward actions come back as cards to confirm.
 */
export const POST = withAuth<Params>(
  { name: 'POST /api/v1/orgs/{orgSlug}/copilot/messages' },
  async ({ request, ctx, organization, user }) => {
    const input = await readJsonBody(request, bodySchema);
    return jsonOk(
      await sendMessage(
        ctx,
        organization,
        { threadId: input.threadId ?? null, text: input.text, user: { name: user.name } },
        {
          origin: new URL(request.url).origin,
          forwardedFor: request.headers.get('x-forwarded-for'),
        },
      ),
    );
  },
);
