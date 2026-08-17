import { ConflictError, NotFoundError, ValidationError, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import { audit, type AuditInput } from '@/server/audit';

/**
 * Media folders (SRS §12).
 *
 * `MediaFolder` has been in the schema since the beginning and nothing used it,
 * so an agency's library was one flat list per brand — which is fine at fifty
 * assets and unusable at five hundred.
 *
 * **Deleting a folder never deletes a photograph.** The database enforces this
 * (`MediaAsset.folder` is `NoAction`, so a folder with assets cannot be
 * removed), and this module makes it a feature rather than an error: the
 * contents move up to the parent, then the folder goes. Losing a client's
 * shoot because somebody tidied up would be unrecoverable, and no confirmation
 * dialog is worth relying on for that.
 *
 * Folders are scoped to a **workspace**, not a brand: agencies file by campaign
 * and by shoot, and both routinely span the brands belonging to one client.
 */

const FOLDER_SELECT = {
  id: true,
  name: true,
  parentId: true,
  workspaceId: true,
  createdAt: true,
  _count: { select: { assets: true, children: true } },
} as const;

/** Deep enough for campaign → shoot → cut; shallow enough to stay navigable. */
const MAX_DEPTH = 5;

export async function listFolders(ctx: TenantContext, workspaceId: string) {
  return withTenant(ctx, (db) =>
    db.mediaFolder.findMany({
      where: { workspaceId },
      select: FOLDER_SELECT,
      orderBy: { name: 'asc' },
    }),
  );
}

/**
 * The chain from the root down to one folder, for a breadcrumb.
 *
 * Walked in the application rather than with a recursive CTE: the depth is
 * capped at five, so this is at most five indexed lookups by primary key, and
 * the query stays something anybody can read.
 */
export async function folderPath(ctx: TenantContext, folderId: string) {
  return withTenant(ctx, async (db) => {
    const path: Array<{ id: string; name: string }> = [];
    let current: string | null = folderId;

    for (let depth = 0; depth < MAX_DEPTH && current; depth++) {
      const folder: { id: string; name: string; parentId: string | null } | null =
        await db.mediaFolder.findFirst({
          where: { id: current },
          select: { id: true, name: true, parentId: true },
        });

      if (!folder) break;

      path.unshift({ id: folder.id, name: folder.name });
      current = folder.parentId;
    }

    return path;
  });
}

export async function createFolder(
  ctx: TenantContext,
  input: { workspaceId: string; name: string; parentId?: string | undefined },
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const name = input.name.trim();
  if (name.length === 0) throw new ValidationError('A folder needs a name');

  return withTenant(ctx, async (db) => {
    // Verified through the scoped client, so a workspace from another tenant is
    // simply not found.
    const workspace = await db.workspace.findFirst({
      where: { id: input.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!workspace) throw new NotFoundError('Workspace');

    if (input.parentId) {
      const parent = await db.mediaFolder.findFirst({
        where: { id: input.parentId, workspaceId: input.workspaceId },
        select: { id: true },
      });
      // A parent in another workspace is not a parent. The composite foreign
      // key would refuse it anyway; this produces a sentence instead.
      if (!parent) throw new NotFoundError('Parent folder');

      const depth = (await folderPathInside(db, input.parentId)).length;
      if (depth >= MAX_DEPTH) {
        throw new ConflictError('Folder nesting limit reached', {
          userMessage: `Folders can be ${MAX_DEPTH} deep. Put this one higher up.`,
        });
      }
    }

    const existing = await db.mediaFolder.findFirst({
      where: { workspaceId: input.workspaceId, parentId: input.parentId ?? null, name },
      select: { id: true },
    });

    // The unique index would refuse this; catching it here turns a constraint
    // error into something a person can act on.
    if (existing) {
      throw new ConflictError('A folder with that name already exists here', {
        userMessage: `There is already a folder called “${name}” here.`,
      });
    }

    const folder = await db.mediaFolder.create({
      data: {
        organizationId: ctx.organizationId,
        workspaceId: input.workspaceId,
        parentId: input.parentId ?? null,
        name,
      },
      select: FOLDER_SELECT,
    });

    await audit(db, ctx, {
      action: 'media_folder.created',
      resourceType: 'MediaFolder',
      resourceId: folder.id,
      workspaceId: input.workspaceId,
      after: { name },
      ...fingerprint,
    });

    return folder;
  });
}

export async function renameFolder(
  ctx: TenantContext,
  folderId: string,
  name: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new ValidationError('A folder needs a name');

  return withTenant(ctx, async (db) => {
    const folder = await db.mediaFolder.findFirst({
      where: { id: folderId },
      select: { id: true, workspaceId: true, parentId: true, name: true },
    });
    if (!folder) throw new NotFoundError('Folder');

    const clash = await db.mediaFolder.findFirst({
      where: {
        workspaceId: folder.workspaceId,
        parentId: folder.parentId,
        name: trimmed,
        id: { not: folderId },
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictError('A folder with that name already exists here', {
        userMessage: `There is already a folder called “${trimmed}” here.`,
      });
    }

    const updated = await db.mediaFolder.update({
      where: { id: folderId },
      data: { name: trimmed },
      select: FOLDER_SELECT,
    });

    await audit(db, ctx, {
      action: 'media_folder.renamed',
      resourceType: 'MediaFolder',
      resourceId: folderId,
      workspaceId: folder.workspaceId,
      before: { name: folder.name },
      after: { name: trimmed },
      ...fingerprint,
    });

    return updated;
  });
}

/**
 * Remove a folder, keeping everything that was in it.
 *
 * Contents move up to the parent — assets and sub-folders alike — and then the
 * folder goes. One transaction, so a failure cannot leave assets orphaned in a
 * folder that no longer exists.
 *
 * **No asset is ever deleted here.** Deleting media is its own action, with its
 * own permission and its own confirmation; a folder is a label, and removing a
 * label must not destroy what it was attached to.
 */
export async function deleteFolder(
  ctx: TenantContext,
  folderId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const folder = await db.mediaFolder.findFirst({
      where: { id: folderId },
      select: { id: true, name: true, workspaceId: true, parentId: true },
    });
    if (!folder) throw new NotFoundError('Folder');

    const [movedAssets, movedFolders] = await Promise.all([
      db.mediaAsset.updateMany({
        where: { folderId },
        data: { folderId: folder.parentId },
      }),
      db.mediaFolder.updateMany({
        where: { parentId: folderId },
        data: { parentId: folder.parentId },
      }),
    ]);

    await db.mediaFolder.delete({ where: { id: folderId } });

    await audit(db, ctx, {
      action: 'media_folder.deleted',
      resourceType: 'MediaFolder',
      resourceId: folderId,
      workspaceId: folder.workspaceId,
      before: { name: folder.name },
      // Recorded because "where did my files go" is the question this answers.
      after: { movedAssets: movedAssets.count, movedFolders: movedFolders.count },
      ...fingerprint,
    });

    return { movedAssets: movedAssets.count, movedFolders: movedFolders.count };
  });
}

/**
 * Move assets into a folder, or out to the workspace root with `null`.
 *
 * Every asset is checked against the destination's workspace first: an agency's
 * library spans clients, and filing one client's photograph into another
 * client's campaign folder is a mistake the UI should not be able to make.
 */
export async function moveAssets(
  ctx: TenantContext,
  input: { assetIds: string[]; folderId: string | null },
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  if (input.assetIds.length === 0) return { moved: 0 };

  return withTenant(ctx, async (db) => {
    let workspaceId: string | null = null;

    if (input.folderId) {
      const folder = await db.mediaFolder.findFirst({
        where: { id: input.folderId },
        select: { id: true, workspaceId: true },
      });
      if (!folder) throw new NotFoundError('Folder');
      workspaceId = folder.workspaceId;
    }

    const { count } = await db.mediaAsset.updateMany({
      where: {
        id: { in: input.assetIds },
        deletedAt: null,
        // The destination's workspace, when there is one. An asset from another
        // client is simply not matched rather than moved.
        ...(workspaceId ? { workspaceId } : {}),
      },
      data: { folderId: input.folderId },
    });

    await audit(db, ctx, {
      action: 'media.moved',
      resourceType: 'MediaAsset',
      ...(workspaceId ? { workspaceId } : {}),
      after: { moved: count, folderId: input.folderId },
      ...fingerprint,
    });

    return { moved: count };
  });
}

/** Depth helper that reuses an open transaction rather than opening another. */
async function folderPathInside(
  db: Parameters<Parameters<typeof withTenant>[1]>[0],
  folderId: string,
): Promise<string[]> {
  const path: string[] = [];
  let current: string | null = folderId;

  for (let depth = 0; depth < MAX_DEPTH && current; depth++) {
    const folder: { id: string; parentId: string | null } | null = await db.mediaFolder.findFirst({
      where: { id: current },
      select: { id: true, parentId: true },
    });
    if (!folder) break;

    path.unshift(folder.id);
    current = folder.parentId;
  }

  return path;
}
