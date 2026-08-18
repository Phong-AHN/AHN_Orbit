import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  NotFoundError,
  PlanLimitExceededError,
  ValidationError,
  type TenantContext,
} from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import { headObject, s3 } from '@orbit/storage';
import { PutObjectCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import {
  cleanupMedia,
  completeMediaUpload,
  deleteMediaAsset,
  getMediaAsset,
  getMediaDownloadUrl,
  listMedia,
  presignMediaUpload,
} from './service';

/**
 * The media pipeline against **real S3-compatible storage** (MinIO).
 *
 * Objects are uploaded, verified, signed and deleted for real. The point is
 * that byte verification is exercised end to end: a file whose declared type
 * disagrees with its contents is uploaded successfully to S3 and then rejected
 * on verification, which is exactly the sequence a real attack would take.
 */

const ORG_A = '018f5a00-0000-7000-8000-00005a1f0001';
const ORG_B = '018f5b00-0000-7000-8000-00005b1f0001';
const WS_A = '018f5a00-0000-7000-8000-00005a1f0002';
const BRAND_A = '018f5a00-0000-7000-8000-00005a1f0003';
const WS_B = '018f5b00-0000-7000-8000-00005b1f0002';
const USER_A = '018f5a00-0000-7000-8000-00005a1f0004';
const USER_B = '018f5b00-0000-7000-8000-00005b1f0004';

const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };

let ctxA: TenantContext;
let ctxB: TenantContext;

// ── Fixtures ────────────────────────────────────────────────────────────────

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  // Padding so the object is a plausible size.
  return Buffer.concat([header, Buffer.alloc(500)]);
}

function jpeg(width: number, height: number): Buffer {
  const parts = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08];
  parts.push((height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff);
  parts.push(0x03, ...new Array(9).fill(0));
  return Buffer.concat([Buffer.from(parts), Buffer.alloc(200)]);
}

const SVG_PAYLOAD = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>',
  'utf8',
);

const PHP_PAYLOAD = Buffer.from('<?php system($_GET["cmd"]); ?>', 'utf8');

/** Upload straight to the bucket, standing in for the browser's PUT. */
async function putObject(key: string, body: Buffer, contentType: string) {
  await s3().send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET ?? 'orbit-media-dev',
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

async function seedTenant(org: string, ws: string, user: string, slug: string, brand?: string) {
  await platformDb.organization.upsert({
    where: { id: org },
    update: {},
    create: { id: org, name: slug, slug, timezone: 'UTC' },
  });
  await platformDb.user.upsert({
    where: { id: user },
    update: {},
    create: { id: user, firebaseUid: `dev:${slug}@t8.test`, email: `${slug}@t8.test` },
  });
  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: org, userId: user } },
    update: { role: 'OWNER', status: 'ACTIVE' },
    create: { organizationId: org, userId: user, role: 'OWNER', status: 'ACTIVE' },
  });
  await platformDb.workspace.upsert({
    where: { id: ws },
    update: {},
    create: { id: ws, organizationId: org, name: 'ws', slug: 'main', timezone: 'UTC' },
  });
  if (brand) {
    await platformDb.brand.upsert({
      where: { id: brand },
      update: {},
      create: { id: brand, organizationId: org, workspaceId: ws, name: 'b', slug: 'b' },
    });
  }
}

async function contextFor(email: string, orgId: string): Promise<TenantContext> {
  const user = await resolveUser(await devIdentityProvider.verifyIdToken(`dev:${email}`));
  return (await resolveTenantContext(user, orgId)).ctx;
}

/** presign → PUT → complete, the whole real flow. */
async function upload(
  ctx: TenantContext,
  body: Buffer,
  declaredType: string,
  options: { workspaceId?: string; brandId?: string; filename?: string } = {},
) {
  const presigned = await presignMediaUpload(ctx, {
    workspaceId: options.workspaceId ?? WS_A,
    brandId: options.brandId,
    filename: options.filename,
    declaredMimeType: declaredType,
    declaredSizeBytes: body.length,
  });

  await putObject(presigned.storageKey, body, declaredType);
  return presigned;
}

beforeAll(async () => {
  // The bucket may not exist on a fresh volume.
  try {
    await s3().send(
      new CreateBucketCommand({ Bucket: process.env.S3_BUCKET ?? 'orbit-media-dev' }),
    );
  } catch {
    // Already exists — fine.
  }

  await seedTenant(ORG_A, WS_A, USER_A, 't8a', BRAND_A);
  await seedTenant(ORG_B, WS_B, USER_B, 't8b');
  ctxA = await contextFor('t8a@t8.test', ORG_A);
  ctxB = await contextFor('t8b@t8.test', ORG_B);
});

beforeEach(async () => {
  await platformDb.postMedia.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.mediaAsset.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
  await platformDb.$disconnect();
});

/**
 * A real MP4 carrying a real sample table, so the frame rate is read rather
 * than asserted.
 *
 * `stts` is a run-length list of `(sample_count, sample_delta)` in the track's
 * timescale: one entry is a constant rate, several distinct deltas is variable
 * frame rate — what a phone records by default, and what TikTok refuses while
 * the file's own label still says 30fps.
 */
function mp4(entries: Array<[count: number, delta: number]>, timescale = 600): Buffer {
  const out: number[] = [];
  const push32 = (t: number[], v: number) =>
    t.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const type = (t: number[], s: string) => {
    for (const ch of s) t.push(ch.charCodeAt(0));
  };
  const box = (name: string, payload: number[]): number[] => {
    const b: number[] = [];
    push32(b, 8 + payload.length);
    type(b, name);
    b.push(...payload);
    return b;
  };

  push32(out, 16);
  type(out, 'ftyp');
  type(out, 'isom');
  push32(out, 512);

  const mvhd: number[] = [0, 0, 0, 0];
  push32(mvhd, 0);
  push32(mvhd, 0);
  push32(mvhd, 1000);
  push32(mvhd, 8000);
  while (mvhd.length < 100) mvhd.push(0);

  const hdlr: number[] = [0, 0, 0, 0];
  push32(hdlr, 0);
  type(hdlr, 'vide');
  while (hdlr.length < 24) hdlr.push(0);

  const mdhd: number[] = [0, 0, 0, 0];
  push32(mdhd, 0);
  push32(mdhd, 0);
  push32(mdhd, timescale);
  push32(mdhd, timescale * 8);
  while (mdhd.length < 24) mdhd.push(0);

  const tkhd: number[] = [0, 0, 0, 0];
  while (tkhd.length < 84 - 8) tkhd.push(0);
  push32(tkhd, 1080 * 65_536);
  push32(tkhd, 1920 * 65_536);

  const stts: number[] = [0, 0, 0, 0];
  push32(stts, entries.length);
  for (const [count, delta] of entries) {
    push32(stts, count);
    push32(stts, delta);
  }

  const mdia = box('mdia', [
    ...box('hdlr', hdlr),
    ...box('mdhd', mdhd),
    ...box('minf', box('stbl', box('stts', stts))),
  ]);
  const trak = box('trak', [...box('tkhd', tkhd), ...mdia]);

  return Buffer.from([...out, ...box('moov', [...box('mvhd', mvhd), ...trak])]);
}

/**
 * Frame rate, refused at the upload rather than at publish time.
 *
 * Four scheduled posts failed in one afternoon on a video its owner was certain
 * was 30fps. It was — on average. Catching it here costs ten seconds; catching
 * it when a post goes out costs a slot and a conversation with a client.
 */
describe('video frame rate', () => {
  it('accepts a constant 30fps clip', async () => {
    // 600 ticks per second, one frame every 20 → 30fps.
    const presigned = await upload(ctxA, mp4([[240, 20]]), 'video/mp4');
    const asset = await completeMediaUpload(ctxA, presigned.assetId, fingerprint);

    expect(asset.status).toBe('READY');
  });

  /** The exact production case: average 30, peak 120. */
  it('refuses a variable-rate clip whose average still looks like 30', async () => {
    const presigned = await upload(
      ctxA,
      mp4([
        [120, 20],
        [120, 5],
      ]),
      'video/mp4',
    );

    await expect(completeMediaUpload(ctxA, presigned.assetId, fingerprint)).rejects.toThrow();

    const row = await platformDb.mediaAsset.findUniqueOrThrow({ where: { id: presigned.assetId } });
    expect(row.status).toBe('REJECTED');
    // The message has to say the rate *varies*, or somebody re-exports at the
    // same 30fps their editor already reports and hits it again.
    expect(row.rejectionReason).toMatch(/changes speed|constant frame rate/i);
  });

  it('refuses a clip below every platform floor', async () => {
    // One frame every 60 ticks → 10fps.
    const presigned = await upload(ctxA, mp4([[80, 60]]), 'video/mp4');

    await expect(completeMediaUpload(ctxA, presigned.assetId, fingerprint)).rejects.toThrow();
  });

  it('records the rate it read, so a later check does not have to re-read bytes', async () => {
    const presigned = await upload(ctxA, mp4([[240, 20]]), 'video/mp4');
    await completeMediaUpload(ctxA, presigned.assetId, fingerprint);

    const row = await platformDb.mediaAsset.findUniqueOrThrow({ where: { id: presigned.assetId } });
    expect(row.frameRate).toBe(30);
    expect(row.peakFrameRate).toBe(30);
  });
});

// ── The happy path ──────────────────────────────────────────────────────────

describe('upload and verification', () => {
  it('verifies a real PNG and records dimensions read from the bytes', async () => {
    const { assetId } = await upload(ctxA, png(1200, 630), 'image/png', {
      filename: 'banner.png',
    });

    const asset = await completeMediaUpload(ctxA, assetId, fingerprint);

    expect(asset.status).toBe('READY');
    expect(asset.mimeType).toBe('image/png');
    expect(asset.width).toBe(1200);
    expect(asset.height).toBe(630);
    expect(asset.kind).toBe('IMAGE');
  });

  it('verifies a real JPEG', async () => {
    const { assetId } = await upload(ctxA, jpeg(800, 600), 'image/jpeg');
    const asset = await completeMediaUpload(ctxA, assetId, fingerprint);

    expect(asset.mimeType).toBe('image/jpeg');
    expect(asset.width).toBe(800);
    expect(asset.height).toBe(600);
  });

  it('records the size S3 reports, not the size the client declared', async () => {
    const body = png(100, 100);
    const presigned = await presignMediaUpload(ctxA, {
      workspaceId: WS_A,
      declaredMimeType: 'image/png',
      // A deliberate lie: the client claims 10 bytes.
      declaredSizeBytes: 10,
    });
    await putObject(presigned.storageKey, body, 'image/png');

    const asset = await completeMediaUpload(ctxA, presigned.assetId, fingerprint);
    expect(asset.sizeBytes).toBe(body.length);
  });

  it('is idempotent — completing twice is not an error', async () => {
    const { assetId } = await upload(ctxA, png(10, 10), 'image/png');
    await completeMediaUpload(ctxA, assetId, fingerprint);
    const second = await completeMediaUpload(ctxA, assetId, fingerprint);
    expect(second.status).toBe('READY');
  });

  it('keeps the asset PENDING and unlistable until verified', async () => {
    const { assetId } = await upload(ctxA, png(10, 10), 'image/png');

    expect((await getMediaAsset(ctxA, assetId)).status).toBe('PENDING');
    // A PENDING asset must not be attachable to a post.
    expect(await listMedia(ctxA)).toHaveLength(0);

    await completeMediaUpload(ctxA, assetId, fingerprint);
    expect(await listMedia(ctxA)).toHaveLength(1);
  });
});

// ── The attacks ─────────────────────────────────────────────────────────────

describe('byte verification rejects disguised files', () => {
  it('REJECTS a PHP payload uploaded as image/jpeg', async () => {
    // The classic: correct extension, correct declared type, wrong bytes.
    const { assetId, storageKey } = await upload(ctxA, PHP_PAYLOAD, 'image/jpeg', {
      filename: 'innocent.jpg',
    });

    await expect(completeMediaUpload(ctxA, assetId, fingerprint)).rejects.toThrow(ValidationError);

    const asset = await platformDb.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.status).toBe('REJECTED');
    expect(asset.rejectionReason).toBeTruthy();

    // The bytes must not survive in the bucket.
    await expect(headObject(storageKey)).rejects.toThrow();
  });

  it('REJECTS an SVG uploaded as image/png — stored XSS', async () => {
    const { assetId } = await upload(ctxA, SVG_PAYLOAD, 'image/png', { filename: 'logo.png' });

    await expect(completeMediaUpload(ctxA, assetId, fingerprint)).rejects.toThrow(/SVG/i);

    const asset = await platformDb.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.status).toBe('REJECTED');
  });

  it('rejects an HTML document dressed as a GIF', async () => {
    const html = Buffer.from('<!DOCTYPE html><html><script>x</script></html>', 'utf8');
    const { assetId } = await upload(ctxA, html, 'image/gif');
    await expect(completeMediaUpload(ctxA, assetId, fingerprint)).rejects.toThrow(ValidationError);
  });

  it('rejects an empty object', async () => {
    const presigned = await presignMediaUpload(ctxA, {
      workspaceId: WS_A,
      declaredMimeType: 'image/png',
      declaredSizeBytes: 100,
    });
    await putObject(presigned.storageKey, Buffer.alloc(0), 'image/png');

    await expect(completeMediaUpload(ctxA, presigned.assetId, fingerprint)).rejects.toThrow(
      /empty/i,
    );
  });

  it('rejects a truncated image whose dimensions cannot be read', async () => {
    const truncated = png(100, 100).subarray(0, 12);
    const { assetId } = await upload(ctxA, truncated, 'image/png');
    await expect(completeMediaUpload(ctxA, assetId, fingerprint)).rejects.toThrow(
      /dimensions could not be read/i,
    );
  });

  it('stores the SNIFFED type when the client declares the wrong one', async () => {
    // An honest mismatch: real JPEG bytes, declared as PNG. Accepted, but the
    // stored type is what the bytes say.
    const { assetId } = await upload(ctxA, jpeg(50, 50), 'image/png');
    const asset = await completeMediaUpload(ctxA, assetId, fingerprint);
    expect(asset.mimeType).toBe('image/jpeg');
  });

  it('refuses to presign a type we never store', async () => {
    for (const type of ['image/svg+xml', 'application/pdf', 'text/html', 'application/zip']) {
      await expect(
        presignMediaUpload(ctxA, {
          workspaceId: WS_A,
          declaredMimeType: type,
          declaredSizeBytes: 1000,
        }),
      ).rejects.toThrow(ValidationError);
    }
  });

  it('refuses to presign an implausible size', async () => {
    await expect(
      presignMediaUpload(ctxA, {
        workspaceId: WS_A,
        declaredMimeType: 'image/png',
        declaredSizeBytes: 900 * 1024 * 1024,
      }),
    ).rejects.toThrow(ValidationError);
  });
});

// ── Keys and tenant isolation ───────────────────────────────────────────────

describe('storage keys and isolation', () => {
  it('derives a tenant-scoped key that contains no client filename', async () => {
    const { storageKey } = await upload(ctxA, png(10, 10), 'image/png', {
      filename: '../../../etc/passwd.png',
      brandId: BRAND_A,
    });

    expect(storageKey).toMatch(new RegExp(`^org/${ORG_A}/workspace/${WS_A}/brand/${BRAND_A}/`));
    expect(storageKey).not.toContain('passwd');
    expect(storageKey).not.toContain('..');
    expect(storageKey.endsWith('/original.png')).toBe(true);
  });

  it('keeps the sanitised filename as metadata only', async () => {
    const { assetId } = await upload(ctxA, png(10, 10), 'image/png', {
      filename: 'C:\\Users\\me\\Holiday Photo.png',
    });
    const asset = await completeMediaUpload(ctxA, assetId, fingerprint);
    expect(asset.originalFilename).toBe('Holiday Photo.png');
  });

  it('does not resolve another tenant’s asset by exact id', async () => {
    const { assetId } = await upload(ctxA, png(10, 10), 'image/png');
    await completeMediaUpload(ctxA, assetId, fingerprint);

    await expect(getMediaAsset(ctxB, assetId)).rejects.toThrow(NotFoundError);
    await expect(getMediaDownloadUrl(ctxB, assetId)).rejects.toThrow(NotFoundError);
  });

  it('does not let another tenant delete an asset', async () => {
    const { assetId } = await upload(ctxA, png(10, 10), 'image/png');
    await completeMediaUpload(ctxA, assetId, fingerprint);

    await expect(deleteMediaAsset(ctxB, assetId, fingerprint)).rejects.toThrow(NotFoundError);
    expect((await getMediaAsset(ctxA, assetId)).status).toBe('READY');
  });

  it('refuses to presign into another tenant’s workspace', async () => {
    await expect(
      presignMediaUpload(ctxA, {
        workspaceId: WS_B,
        declaredMimeType: 'image/png',
        declaredSizeBytes: 1000,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('lists only this tenant’s assets', async () => {
    const a = await upload(ctxA, png(10, 10), 'image/png');
    await completeMediaUpload(ctxA, a.assetId, fingerprint);

    const b = await upload(ctxB, png(20, 20), 'image/png', { workspaceId: WS_B });
    await completeMediaUpload(ctxB, b.assetId, fingerprint);

    expect((await listMedia(ctxA)).map((m) => m.id)).toEqual([a.assetId]);
    expect((await listMedia(ctxB)).map((m) => m.id)).toEqual([b.assetId]);
  });
});

// ── Signed reads ────────────────────────────────────────────────────────────

describe('signed download URLs', () => {
  it('issues a URL that actually fetches the object', async () => {
    const body = png(64, 64);
    const { assetId } = await upload(ctxA, body, 'image/png');
    await completeMediaUpload(ctxA, assetId, fingerprint);

    const { url, expiresAt } = await getMediaDownloadUrl(ctxA, assetId);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).length).toBe(body.length);
  });

  it('forces a download disposition and the verified content type', async () => {
    const { assetId } = await upload(ctxA, jpeg(40, 40), 'image/png');
    await completeMediaUpload(ctxA, assetId, fingerprint);

    const { url } = await getMediaDownloadUrl(ctxA, assetId);
    const response = await fetch(url);

    // Even if something unexpected slipped through, it downloads rather than
    // renders — a stored-XSS defence independent of the upload check.
    expect(response.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
  });

  it('does not sign a PENDING asset', async () => {
    const { assetId } = await upload(ctxA, png(10, 10), 'image/png');
    await expect(getMediaDownloadUrl(ctxA, assetId)).rejects.toThrow(NotFoundError);
  });

  it('the bucket is not publicly readable', async () => {
    const body = png(10, 10);
    const { assetId, storageKey } = await upload(ctxA, body, 'image/png');
    await completeMediaUpload(ctxA, assetId, fingerprint);

    const endpoint = process.env.S3_ENDPOINT ?? 'http://localhost:9000';
    const unsigned = await fetch(
      `${endpoint}/${process.env.S3_BUCKET ?? 'orbit-media-dev'}/${storageKey}`,
    );

    expect(unsigned.status).toBeGreaterThanOrEqual(400);
  });
});

// ── Deletion and cleanup ────────────────────────────────────────────────────

describe('deletion and cleanup', () => {
  it('soft-deletes and hides the asset', async () => {
    const { assetId } = await upload(ctxA, png(10, 10), 'image/png');
    await completeMediaUpload(ctxA, assetId, fingerprint);

    await deleteMediaAsset(ctxA, assetId, fingerprint);

    expect(await listMedia(ctxA)).toHaveLength(0);
    const row = await platformDb.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
    expect(row.deletedAt).not.toBeNull();
  });

  it('refuses to delete media still attached to a post', async () => {
    const { assetId } = await upload(ctxA, png(10, 10), 'image/png');
    await completeMediaUpload(ctxA, assetId, fingerprint);

    const post = await platformDb.post.create({
      data: { organizationId: ORG_A, workspaceId: WS_A, brandId: BRAND_A, body: 'x' },
    });
    await platformDb.postMedia.create({
      data: { organizationId: ORG_A, postId: post.id, mediaAssetId: assetId },
    });

    await expect(deleteMediaAsset(ctxA, assetId, fingerprint)).rejects.toThrow(ConflictError);
  });

  it('sweeps abandoned uploads and removes their objects', async () => {
    // An upload that was presigned and PUT but never completed.
    const { assetId, storageKey } = await upload(ctxA, png(10, 10), 'image/png');
    expect((await headObject(storageKey)).contentLength).toBeGreaterThan(0);

    const result = await cleanupMedia(ctxA, { abandonedAfterMs: -60_000 });

    expect(result.abandoned).toBe(1);
    expect(await platformDb.mediaAsset.count({ where: { id: assetId } })).toBe(0);
    await expect(headObject(storageKey)).rejects.toThrow();
  });

  it('leaves a completed upload alone', async () => {
    const { assetId } = await upload(ctxA, png(10, 10), 'image/png');
    await completeMediaUpload(ctxA, assetId, fingerprint);

    const result = await cleanupMedia(ctxA, { abandonedAfterMs: -60_000 });
    expect(result.abandoned).toBe(0);
    expect(await platformDb.mediaAsset.count({ where: { id: assetId } })).toBe(1);
  });

  it('purges soft-deleted assets after the grace period', async () => {
    const { assetId, storageKey } = await upload(ctxA, png(10, 10), 'image/png');
    await completeMediaUpload(ctxA, assetId, fingerprint);
    await deleteMediaAsset(ctxA, assetId, fingerprint);

    const result = await cleanupMedia(ctxA, { purgeAfterMs: -60_000 });

    expect(result.purged).toBe(1);
    await expect(headObject(storageKey)).rejects.toThrow();
  });

  it('does not touch another tenant’s assets', async () => {
    const b = await upload(ctxB, png(10, 10), 'image/png', { workspaceId: WS_B });

    await cleanupMedia(ctxA, { abandonedAfterMs: -60_000, purgeAfterMs: -60_000 });

    expect(await platformDb.mediaAsset.count({ where: { id: b.assetId } })).toBe(1);
  });
});

// ── Plan limits and audit ───────────────────────────────────────────────────

describe('limits and audit', () => {
  it('enforces the storage limit from the subscription', async () => {
    await platformDb.subscription.upsert({
      where: { organizationId: ORG_A },
      update: { limits: { storageBytes: 1000 } },
      create: { organizationId: ORG_A, limits: { storageBytes: 1000 } },
    });

    const { assetId } = await upload(ctxA, png(10, 10), 'image/png');
    await completeMediaUpload(ctxA, assetId, fingerprint);

    await expect(
      presignMediaUpload(ctxA, {
        workspaceId: WS_A,
        declaredMimeType: 'image/png',
        declaredSizeBytes: 2000,
      }),
    ).rejects.toThrow(PlanLimitExceededError);

    await platformDb.subscription.deleteMany({ where: { organizationId: ORG_A } });
  });

  it('audits a verified upload with the derived properties', async () => {
    const { assetId } = await upload(ctxA, png(1200, 630), 'image/png');
    await completeMediaUpload(ctxA, assetId, fingerprint);

    const entry = await platformDb.auditLog.findFirstOrThrow({
      where: { organizationId: ORG_A, action: 'media.uploaded', resourceId: assetId },
    });

    expect(entry.actorUserId).toBe(USER_A);
    expect(JSON.stringify(entry.after)).toContain('1200');
  });
});
