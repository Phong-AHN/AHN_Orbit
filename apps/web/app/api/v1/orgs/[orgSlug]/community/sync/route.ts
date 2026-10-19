import { currentCorrelationId } from '@orbit/observability';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { syncNow } from '@/features/community/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * Read the connected accounts now rather than waiting for the sweep.
 *
 * No `permission` on the wrapper, for the same reason the queue's `GET` has
 * none: `comment:read_public` is brand-scoped for a Content Creator and an
 * Approver, so checking it here with an empty resource scope would deny
 * exactly the people the inbox is for (**D-069**). The service authorizes, and
 * then narrows the accounts it queues to the ones the caller can reach — so a
 * brand-scoped role cannot spend the tenant's provider quota on an account
 * outside its brands.
 *
 * `POST` rather than `GET`: it has an effect, it costs provider quota, and it
 * must never be something a browser or a crawler can prefetch.
 *
 * Returns the number of accounts queued, not comments found. The work is
 * asynchronous and a count of comments here would be a number invented before
 * the job runs.
 *
 * `withAuth` always establishes a correlation id, so the fallback below is
 * unreachable in a request — it exists because the accessor is typed for
 * callers outside a log context, and inventing an id is better than widening
 * the job payload to accept an absent one.
 */
export const POST = withAuth<Params>(
  { name: 'POST /api/v1/orgs/{orgSlug}/community/sync' },
  async ({ ctx }) =>
    jsonOk(await syncNow(ctx, currentCorrelationId() ?? `community-sync-${ctx.organizationId}`)),
);
