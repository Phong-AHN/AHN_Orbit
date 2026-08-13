import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';

/**
 * Composite tenant foreign keys, enforced by PostgreSQL.
 *
 * These tests deliberately bypass every application safeguard. They use a raw
 * PrismaClient with no tenant extension, connect as the table **owner** (so RLS
 * does not apply either), and write cross-tenant references directly.
 *
 * Nothing is left to catch the write except the foreign keys themselves. If a
 * test here passes, the guarantee is in the database — not in a convention.
 */

const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://orbit:orbit_local_dev@localhost:5432/orbit?schema=public';

const raw = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

const A = {
  org: '018f1a00-0000-7000-8000-00000a1f0001',
  workspace: '018f1a00-0000-7000-8000-00000a1f0002',
  brand: '018f1a00-0000-7000-8000-00000a1f0003',
  account: '018f1a00-0000-7000-8000-00000a1f0004',
  post: '018f1a00-0000-7000-8000-00000a1f0005',
  variant: '018f1a00-0000-7000-8000-00000a1f0006',
  media: '018f1a00-0000-7000-8000-00000a1f0007',
  folder: '018f1a00-0000-7000-8000-00000a1f0008',
};

const B = {
  org: '018f1b00-0000-7000-8000-00000b1f0001',
  workspace: '018f1b00-0000-7000-8000-00000b1f0002',
  brand: '018f1b00-0000-7000-8000-00000b1f0003',
  account: '018f1b00-0000-7000-8000-00000b1f0004',
  post: '018f1b00-0000-7000-8000-00000b1f0005',
  variant: '018f1b00-0000-7000-8000-00000b1f0006',
  media: '018f1b00-0000-7000-8000-00000b1f0007',
  folder: '018f1b00-0000-7000-8000-00000b1f0008',
};

/** Postgres error 23503 = foreign_key_violation. */
const FK_VIOLATION = /foreign key constraint|23503/i;

async function seed(t: typeof A, label: string) {
  await raw.organization.create({
    data: { id: t.org, name: label, slug: label, timezone: 'UTC' },
  });
  await raw.workspace.create({
    data: { id: t.workspace, organizationId: t.org, name: 'ws', slug: 'main', timezone: 'UTC' },
  });
  await raw.brand.create({
    data: { id: t.brand, organizationId: t.org, workspaceId: t.workspace, name: 'b', slug: 'b' },
  });
  await raw.mediaFolder.create({
    data: { id: t.folder, organizationId: t.org, workspaceId: t.workspace, name: 'f' },
  });
  await raw.socialAccount.create({
    data: {
      id: t.account,
      organizationId: t.org,
      workspaceId: t.workspace,
      brandId: t.brand,
      platform: 'FACEBOOK',
      externalId: `ext-${label}`,
      displayName: 'page',
    },
  });
  await raw.post.create({
    data: {
      id: t.post,
      organizationId: t.org,
      workspaceId: t.workspace,
      brandId: t.brand,
      body: 'x',
    },
  });
  await raw.postVariant.create({
    data: {
      id: t.variant,
      organizationId: t.org,
      postId: t.post,
      socialAccountId: t.account,
      platform: 'FACEBOOK',
    },
  });
  await raw.mediaAsset.create({
    data: {
      id: t.media,
      organizationId: t.org,
      workspaceId: t.workspace,
      kind: 'IMAGE',
      storageKey: `key-${label}`,
      mimeType: 'image/jpeg',
      sizeBytes: 1,
    },
  });
}

beforeAll(async () => {
  await raw.organization.deleteMany({ where: { id: { in: [A.org, B.org] } } });
  await seed(A, 'fk-tenant-a');
  await seed(B, 'fk-tenant-b');
});

afterAll(async () => {
  await raw.organization.deleteMany({ where: { id: { in: [A.org, B.org] } } });
  await raw.$disconnect();
});

describe('the database rejects cross-tenant references', () => {
  it('Post → Brand: the exact gap this closes', async () => {
    // Organization A, but pointing at B's brand. Previously accepted.
    await expect(
      raw.post.create({
        data: {
          organizationId: A.org,
          workspaceId: A.workspace,
          brandId: B.brand,
          body: 'mixed tenant',
        },
      }),
    ).rejects.toThrow(FK_VIOLATION);
  });

  it('Post → Workspace', async () => {
    await expect(
      raw.post.create({
        data: {
          organizationId: A.org,
          workspaceId: B.workspace,
          brandId: A.brand,
          body: 'mixed tenant',
        },
      }),
    ).rejects.toThrow(FK_VIOLATION);
  });

  it('Brand → Workspace', async () => {
    await expect(
      raw.brand.create({
        data: { organizationId: A.org, workspaceId: B.workspace, name: 'x', slug: 'x' },
      }),
    ).rejects.toThrow(FK_VIOLATION);
  });

  it('SocialAccount → Brand', async () => {
    await expect(
      raw.socialAccount.create({
        data: {
          organizationId: A.org,
          workspaceId: A.workspace,
          brandId: B.brand,
          platform: 'FACEBOOK',
          externalId: 'x1',
          displayName: 'x',
        },
      }),
    ).rejects.toThrow(FK_VIOLATION);
  });

  it('PostVariant → Post', async () => {
    await expect(
      raw.postVariant.create({
        data: {
          organizationId: A.org,
          postId: B.post,
          socialAccountId: A.account,
          platform: 'FACEBOOK',
        },
      }),
    ).rejects.toThrow(FK_VIOLATION);
  });

  it('PostVariant → SocialAccount', async () => {
    await expect(
      raw.postVariant.create({
        data: {
          organizationId: A.org,
          postId: A.post,
          socialAccountId: B.account,
          platform: 'FACEBOOK',
        },
      }),
    ).rejects.toThrow(FK_VIOLATION);
  });

  it('PostMedia → MediaAsset', async () => {
    await expect(
      raw.postMedia.create({
        data: { organizationId: A.org, postId: A.post, mediaAssetId: B.media },
      }),
    ).rejects.toThrow(FK_VIOLATION);
  });

  it('MediaAsset → Folder', async () => {
    await expect(
      raw.mediaAsset.create({
        data: {
          organizationId: A.org,
          workspaceId: A.workspace,
          folderId: B.folder,
          kind: 'IMAGE',
          storageKey: 'k1',
          mimeType: 'image/jpeg',
          sizeBytes: 1,
        },
      }),
    ).rejects.toThrow(FK_VIOLATION);
  });

  it('Approval → Post', async () => {
    await expect(
      raw.approval.create({ data: { organizationId: A.org, postId: B.post, stage: 'INTERNAL' } }),
    ).rejects.toThrow(FK_VIOLATION);
  });

  it('Comment → Post', async () => {
    await expect(
      raw.comment.create({ data: { organizationId: A.org, postId: B.post, body: 'hi' } }),
    ).rejects.toThrow(FK_VIOLATION);
  });

  it('PublishingJob → PostVariant', async () => {
    await expect(
      raw.publishingJob.create({
        data: {
          organizationId: A.org,
          postVariantId: B.variant,
          idempotencyKey: 'k',
          scheduledFor: new Date(),
        },
      }),
    ).rejects.toThrow(FK_VIOLATION);
  });

  it('AnalyticsSnapshot → SocialAccount', async () => {
    await expect(
      raw.analyticsSnapshot.create({
        data: {
          organizationId: A.org,
          socialAccountId: B.account,
          date: new Date('2026-01-01'),
          providerApiVersion: 'v21.0',
        },
      }),
    ).rejects.toThrow(FK_VIOLATION);
  });

  it('BrandVoice → Brand', async () => {
    await expect(
      raw.brandVoice.create({ data: { organizationId: A.org, brandId: B.brand } }),
    ).rejects.toThrow(FK_VIOLATION);
  });

  it('WorkspaceMembership → Workspace', async () => {
    const user = await raw.user.create({
      data: { firebaseUid: 'dev:fk-probe@x.test', email: 'fk-probe@x.test' },
    });

    await expect(
      raw.workspaceMembership.create({
        data: {
          organizationId: A.org,
          workspaceId: B.workspace,
          userId: user.id,
          role: 'MANAGER',
        },
      }),
    ).rejects.toThrow(FK_VIOLATION);

    await raw.user.delete({ where: { id: user.id } });
  });

  it('an UPDATE cannot move a reference across the boundary either', async () => {
    await expect(
      raw.post.update({ where: { id: A.post }, data: { brandId: B.brand } }),
    ).rejects.toThrow(FK_VIOLATION);
  });
});

describe('same-tenant references still work', () => {
  it('accepts a post referencing its own organization’s brand and workspace', async () => {
    const post = await raw.post.create({
      data: {
        organizationId: A.org,
        workspaceId: A.workspace,
        brandId: A.brand,
        body: 'legitimate',
      },
    });

    expect(post.organizationId).toBe(A.org);
    await raw.post.delete({ where: { id: post.id } });
  });

  it('accepts an optional reference left null', async () => {
    const asset = await raw.mediaAsset.create({
      data: {
        organizationId: A.org,
        workspaceId: A.workspace,
        kind: 'IMAGE',
        storageKey: 'nullable-ok',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
      },
    });

    expect(asset.brandId).toBeNull();
    await raw.mediaAsset.delete({ where: { id: asset.id } });
  });

  it('still cascades an organization delete through every child', async () => {
    // NO ACTION on the optional references is checked at end-of-statement, so a
    // cascading org delete that removes parent and child together must succeed.
    const orgId = '018f1c00-0000-7000-8000-00000c1f0001';
    await raw.organization.create({
      data: { id: orgId, name: 'cascade-probe', slug: 'cascade-probe', timezone: 'UTC' },
    });
    const ws = await raw.workspace.create({
      data: { organizationId: orgId, name: 'w', slug: 'main', timezone: 'UTC' },
    });
    const brand = await raw.brand.create({
      data: { organizationId: orgId, workspaceId: ws.id, name: 'b', slug: 'b' },
    });
    const folder = await raw.mediaFolder.create({
      data: { organizationId: orgId, workspaceId: ws.id, name: 'f' },
    });
    await raw.mediaAsset.create({
      data: {
        organizationId: orgId,
        workspaceId: ws.id,
        brandId: brand.id,
        folderId: folder.id,
        kind: 'IMAGE',
        storageKey: 'cascade-probe',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
      },
    });

    await expect(raw.organization.delete({ where: { id: orgId } })).resolves.toBeTruthy();
    expect(await raw.mediaAsset.count({ where: { organizationId: orgId } })).toBe(0);
  });
});
