import { NotFoundError, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import type { ResourceScope } from '@orbit/rbac';

/**
 * The workspace and brand a conversation belongs to, for the route's
 * permission check (**D-107**).
 *
 * Read through the tenant-scoped client, so a conversation in another
 * organization is not found rather than refused — a probe cannot tell
 * "not yours" from "no such thing". The service checks again against the same
 * row before it acts.
 */
export async function conversationResourceScope({
  params,
  ctx,
}: {
  params: { conversationId: string };
  ctx: TenantContext;
}): Promise<ResourceScope> {
  const conversation = await withTenant(ctx, (db) =>
    db.socialConversation.findFirst({
      where: { id: params.conversationId },
      select: { workspaceId: true, brandId: true },
    }),
  );

  if (!conversation) throw new NotFoundError('Conversation');

  return { workspaceId: conversation.workspaceId, brandId: conversation.brandId };
}
