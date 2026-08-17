import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, type TenantContext } from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import {
  createFolder,
  deleteFolder,
  folderPath,
  listFolders,
  moveAssets,
  renameFolder,
} from './folders';

/**
 * Media folders (SRS §12).
 *
 * The property worth proving above all others: **deleting a folder must never
 * delete a photograph**. An agency that loses a client's shoot because somebody
 * tidied up has lost something unrecoverable, and no confirmation dialog is
 * worth relying on for that.
 *
 * The second is scope. An agency's library spans clients, so filing one
 * client's photograph into another client's campaign folder has to be
 * impossible rather than merely discouraged.
 */

const ORG_A = '018f1300-0000-7000-8000-001300000001';
const ORG_B = '018f1400-0000-7000-8000-001400000001';
const WS_A1 = '018f1300-0000-7000-8000-001300000002';
const WS_A2 = '018f1300-0000-7000-8000-001300000003';
const WS_B = '018f1400-0000-7000-8000-001400000002';

const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };

let ctxA: TenantContext;
let ctxB: TenantContext;

async function seed(org: string, workspaces: string[], slug: string, email: string) {
  await platformDb.organization.upsert({
    where: { id: org },
    update: {},
    create: { id: org, name: slug, slug, timezone: 'UTC' },
  });

  for (const [index, ws] of workspaces.entries()) {
    await platformDb.workspace.upsert({
      where: { id: ws },
      update: {},
      create: {
        id: ws,
        organizationId: org,
        name: `${slug}-${index}`,
        slug: `${slug}-${index}`,
        timezone: 'UTC',
      },
    });
  }

  const identity = await devIdentityProvider.verifyIdToken(`dev:${email}`);
  const user = await resolveUser(identity);

  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: org, userId: user.id } },
    update: {},
    create: { organizationId: org, userId: user.id, role: 'OWNER', status: 'ACTIVE' },
  });

  const { ctx } = await resolveTenantContext(user, org, 'itest-folders');
  return ctx;
}

/** A READY asset, because that is the only kind anybody files. */
async function seedAsset(org: string, workspaceId: string, name: string) {
  return platformDb.mediaAsset.create({
    data: {
      organizationId: org,
      workspaceId,
      kind: 'IMAGE',
      storageKey: `org/${org}/workspace/${workspaceId}/${name}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: 1_000,
      originalFilename: `${name}.jpg`,
      status: 'READY',
    },
  });
}

beforeAll(async () => {
  ctxA = await seed(ORG_A, [WS_A1, WS_A2], 'fold-a', 'owner@fold-a.test');
  ctxB = await seed(ORG_B, [WS_B], 'fold-b', 'owner@fold-b.test');
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { email: { endsWith: '.test' } } });
});

beforeEach(async () => {
  await platformDb.mediaAsset.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.mediaFolder.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
});

describe('creating', () => {
  it('creates a folder at the workspace root', async () => {
    const folder = await createFolder(
      ctxA,
      { workspaceId: WS_A1, name: 'Spring campaign' },
      fingerprint,
    );

    expect(folder.name).toBe('Spring campaign');
    expect(folder.parentId).toBeNull();
  });

  it('nests under a parent', async () => {
    const parent = await createFolder(ctxA, { workspaceId: WS_A1, name: 'Campaigns' }, fingerprint);
    const child = await createFolder(
      ctxA,
      { workspaceId: WS_A1, name: 'Spring', parentId: parent.id },
      fingerprint,
    );

    expect(child.parentId).toBe(parent.id);
    expect((await folderPath(ctxA, child.id)).map((f) => f.name)).toEqual(['Campaigns', 'Spring']);
  });

  it('refuses two folders with the same name in the same place', async () => {
    await createFolder(ctxA, { workspaceId: WS_A1, name: 'Shoots' }, fingerprint);

    await expect(
      createFolder(ctxA, { workspaceId: WS_A1, name: 'Shoots' }, fingerprint),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('allows the same name in a different folder', async () => {
    const a = await createFolder(ctxA, { workspaceId: WS_A1, name: 'Q1' }, fingerprint);
    const b = await createFolder(ctxA, { workspaceId: WS_A1, name: 'Q2' }, fingerprint);

    await createFolder(ctxA, { workspaceId: WS_A1, name: 'Shoots', parentId: a.id }, fingerprint);

    await expect(
      createFolder(ctxA, { workspaceId: WS_A1, name: 'Shoots', parentId: b.id }, fingerprint),
    ).resolves.toBeDefined();
  });

  it('refuses a workspace from another tenant, by exact id', async () => {
    await expect(
      createFolder(ctxA, { workspaceId: WS_B, name: 'Theirs' }, fingerprint),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a parent in a different workspace', async () => {
    const parent = await createFolder(ctxA, { workspaceId: WS_A1, name: 'One' }, fingerprint);

    await expect(
      createFolder(ctxA, { workspaceId: WS_A2, name: 'Two', parentId: parent.id }, fingerprint),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('stops nesting at the depth limit', async () => {
    let parentId: string | undefined;

    for (let depth = 0; depth < 5; depth++) {
      const folder = await createFolder(
        ctxA,
        { workspaceId: WS_A1, name: `Level ${depth}`, ...(parentId ? { parentId } : {}) },
        fingerprint,
      );
      parentId = folder.id;
    }

    await expect(
      createFolder(ctxA, { workspaceId: WS_A1, name: 'Too deep', parentId }, fingerprint),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('renaming', () => {
  it('renames a folder', async () => {
    const folder = await createFolder(ctxA, { workspaceId: WS_A1, name: 'Old' }, fingerprint);

    expect((await renameFolder(ctxA, folder.id, 'New', fingerprint)).name).toBe('New');
  });

  it('refuses a name already used beside it', async () => {
    await createFolder(ctxA, { workspaceId: WS_A1, name: 'Taken' }, fingerprint);
    const other = await createFolder(ctxA, { workspaceId: WS_A1, name: 'Free' }, fingerprint);

    await expect(renameFolder(ctxA, other.id, 'Taken', fingerprint)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('does not find another tenant folder, by exact id', async () => {
    const theirs = await createFolder(ctxB, { workspaceId: WS_B, name: 'Theirs' }, fingerprint);

    await expect(renameFolder(ctxA, theirs.id, 'Mine', fingerprint)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('deleting', () => {
  /**
   * The one that matters. A folder is a label; removing a label must not
   * destroy what it was attached to.
   */
  it('never deletes the assets inside it', async () => {
    const folder = await createFolder(ctxA, { workspaceId: WS_A1, name: 'Shoot' }, fingerprint);
    const asset = await seedAsset(ORG_A, WS_A1, 'photo');
    await moveAssets(ctxA, { assetIds: [asset.id], folderId: folder.id }, fingerprint);

    const result = await deleteFolder(ctxA, folder.id, fingerprint);

    expect(result.movedAssets).toBe(1);

    const after = await platformDb.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(after.deletedAt).toBeNull();
    // Moved up to the root, which is where its parent was.
    expect(after.folderId).toBeNull();
  });

  it('moves contents up to the parent rather than to the root', async () => {
    const parent = await createFolder(ctxA, { workspaceId: WS_A1, name: 'Campaigns' }, fingerprint);
    const child = await createFolder(
      ctxA,
      { workspaceId: WS_A1, name: 'Spring', parentId: parent.id },
      fingerprint,
    );

    const asset = await seedAsset(ORG_A, WS_A1, 'photo');
    await moveAssets(ctxA, { assetIds: [asset.id], folderId: child.id }, fingerprint);

    await deleteFolder(ctxA, child.id, fingerprint);

    const after = await platformDb.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(after.folderId).toBe(parent.id);
  });

  it('lifts sub-folders up rather than orphaning them', async () => {
    const parent = await createFolder(ctxA, { workspaceId: WS_A1, name: 'A' }, fingerprint);
    const middle = await createFolder(
      ctxA,
      { workspaceId: WS_A1, name: 'B', parentId: parent.id },
      fingerprint,
    );
    const leaf = await createFolder(
      ctxA,
      { workspaceId: WS_A1, name: 'C', parentId: middle.id },
      fingerprint,
    );

    await deleteFolder(ctxA, middle.id, fingerprint);

    const after = await platformDb.mediaFolder.findUniqueOrThrow({ where: { id: leaf.id } });
    expect(after.parentId).toBe(parent.id);
  });

  it('does not delete another tenant folder, by exact id', async () => {
    const theirs = await createFolder(ctxB, { workspaceId: WS_B, name: 'Theirs' }, fingerprint);

    await expect(deleteFolder(ctxA, theirs.id, fingerprint)).rejects.toBeInstanceOf(NotFoundError);
    expect(await platformDb.mediaFolder.findUnique({ where: { id: theirs.id } })).not.toBeNull();
  });
});

describe('moving assets', () => {
  it('files an asset into a folder and back out', async () => {
    const folder = await createFolder(ctxA, { workspaceId: WS_A1, name: 'Shoot' }, fingerprint);
    const asset = await seedAsset(ORG_A, WS_A1, 'photo');

    await moveAssets(ctxA, { assetIds: [asset.id], folderId: folder.id }, fingerprint);
    expect(
      (await platformDb.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).folderId,
    ).toBe(folder.id);

    await moveAssets(ctxA, { assetIds: [asset.id], folderId: null }, fingerprint);
    expect(
      (await platformDb.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).folderId,
    ).toBeNull();
  });

  /**
   * An agency's library spans clients. Filing one client's photograph into
   * another client's campaign folder must be impossible, not merely discouraged.
   */
  it('refuses to file an asset into another workspace folder', async () => {
    const folder = await createFolder(
      ctxA,
      { workspaceId: WS_A2, name: 'Other client' },
      fingerprint,
    );
    const asset = await seedAsset(ORG_A, WS_A1, 'photo');

    const result = await moveAssets(
      ctxA,
      { assetIds: [asset.id], folderId: folder.id },
      fingerprint,
    );

    expect(result.moved).toBe(0);
    expect(
      (await platformDb.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).folderId,
    ).toBeNull();
  });

  it('cannot file another tenant asset', async () => {
    const folder = await createFolder(ctxA, { workspaceId: WS_A1, name: 'Mine' }, fingerprint);
    const theirs = await seedAsset(ORG_B, WS_B, 'theirs');

    const result = await moveAssets(
      ctxA,
      { assetIds: [theirs.id], folderId: folder.id },
      fingerprint,
    );

    expect(result.moved).toBe(0);
  });
});

describe('listing', () => {
  it('lists only this workspace folders', async () => {
    await createFolder(ctxA, { workspaceId: WS_A1, name: 'One' }, fingerprint);
    await createFolder(ctxA, { workspaceId: WS_A2, name: 'Two' }, fingerprint);

    expect(await listFolders(ctxA, WS_A1)).toHaveLength(1);
  });

  it('never lists another tenant folders', async () => {
    await createFolder(ctxB, { workspaceId: WS_B, name: 'Theirs' }, fingerprint);

    expect(await listFolders(ctxA, WS_B)).toHaveLength(0);
  });
});
