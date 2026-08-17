import {
  ConflictError,
  NotFoundError,
  PlanLimitExceededError,
  ValidationError,
  clock,
  uuidv7,
  type MediaKind,
  type TenantContext,
} from '@orbit/core';
import { withTenant, type TenantDb } from '@orbit/db';
import { logger } from '@orbit/observability';
import {
  MediaRejected,
  assertKeyBelongsTo,
  buildObjectKey,
  deleteObjects,
  presignDownload,
  presignUpload,
  sanitiseFilename,
  verifyUploadedObject,
} from '@orbit/storage';
import { audit, type AuditInput } from '@/server/audit';

/**
 * Media pipeline (T1.8, decision D-013).
 *
 *   presign → browser uploads straight to S3 → complete → byte verification
 *
 * The asset is PENDING until verification passes, and a PENDING asset cannot
 * be attached to a post. Nothing the client says about the file is believed:
 * the MIME type, the dimensions, and the size are all re-derived from the
 * bytes, and the object key is derived rather than accepted.
 *
 * Platform limits deliberately live in the capability system (T1.5), not here.
 * This layer answers "is this a real, safe image?"; the composer answers "will
 * Facebook take it?".
 */

/** Ceilings for what we are willing to store at all, before plan or platform. */
const ABSOLUTE_MAX_BYTES: Record<MediaKind, number> = {
  IMAGE: 25 * 1024 * 1024,
  GIF: 50 * 1024 * 1024,
  VIDEO: 512 * 1024 * 1024,
};

/** Types a client may declare at presign time. Verified again from bytes. */
const PRESIGNABLE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
]);

function kindForDeclaredType(mimeType: string): MediaKind {
  if (mimeType === 'image/gif') return 'GIF';
  if (mimeType.startsWith('video/')) return 'VIDEO';
  return 'IMAGE';
}

async function storageLimits(db: TenantDb): Promise<{ storageBytes?: number }> {
  const subscription = await db.subscription.findFirst({ select: { limits: true } });
  return (subscription?.limits as { storageBytes?: number } | undefined) ?? {};
}

// ── Presign ─────────────────────────────────────────────────────────────────

export interface PresignInput {
  workspaceId: string;
  brandId?: string | undefined;
  filename?: string | undefined;
  declaredMimeType: string;
  declaredSizeBytes: number;
}

/**
 * Reserve an asset row and hand back a presigned PUT.
 *
 * The row exists before the upload so an abandoned upload is *visible* — a
 * PENDING asset older than the cleanup window is exactly what the sweeper
 * looks for. Without it, an abandoned object would be an orphan nobody knows
 * to delete.
 */
export async function presignMediaUpload(ctx: TenantContext, input: PresignInput) {
  const declared = input.declaredMimeType.split(';')[0]?.trim().toLowerCase() ?? '';

  if (!PRESIGNABLE_TYPES.has(declared)) {
    throw new ValidationError('Unsupported media type', {
      userMessage: "That file type isn't supported. Use a JPEG, PNG, WebP, GIF or MP4.",
      context: { declared },
    });
  }

  const kind = kindForDeclaredType(declared);
  const absoluteMax = ABSOLUTE_MAX_BYTES[kind];

  if (input.declaredSizeBytes <= 0 || input.declaredSizeBytes > absoluteMax) {
    throw new ValidationError('Declared size outside the permitted range', {
      userMessage: `Files of this type must be under ${Math.floor(absoluteMax / 1024 / 1024)}MB.`,
      context: { declaredSizeBytes: input.declaredSizeBytes, absoluteMax },
    });
  }

  return withTenant(ctx, async (db) => {
    const workspace = await db.workspace.findFirst({
      where: { id: input.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!workspace) throw new NotFoundError('Workspace');

    if (input.brandId) {
      const brand = await db.brand.findFirst({
        where: { id: input.brandId, workspaceId: input.workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!brand) throw new NotFoundError('Brand');
    }

    const limits = await storageLimits(db);
    if (limits.storageBytes !== undefined) {
      const used = await db.mediaAsset.aggregate({
        where: { deletedAt: null },
        _sum: { sizeBytes: true },
      });
      const consumed = used._sum.sizeBytes ?? 0;
      if (consumed + input.declaredSizeBytes > limits.storageBytes) {
        throw new PlanLimitExceededError('Storage limit reached', {
          userMessage: 'Your plan’s storage is full. Remove some files or upgrade.',
          context: { consumed, limit: limits.storageBytes },
        });
      }
    }

    // The id is ours, and so is the key built from it. The client's filename
    // survives only as sanitised metadata.
    const assetId = uuidv7();
    const extension = declared.split('/')[1]?.replace('quicktime', 'mov') ?? 'bin';

    const storageKey = buildObjectKey({
      organizationId: ctx.organizationId,
      workspaceId: input.workspaceId,
      brandId: input.brandId ?? null,
      assetId,
      extension: extension === 'jpeg' ? 'jpg' : extension,
      now: clock.now(),
    });

    const asset = await db.mediaAsset.create({
      data: {
        id: assetId,
        organizationId: ctx.organizationId,
        workspaceId: input.workspaceId,
        brandId: input.brandId ?? null,
        kind,
        storageKey,
        // Overwritten by verification. Present only so the row is valid.
        mimeType: declared,
        sizeBytes: input.declaredSizeBytes,
        originalFilename: sanitiseFilename(input.filename) ?? null,
        status: 'PENDING',
        uploadedById: ctx.principal.kind === 'USER' ? ctx.principal.userId : null,
      },
      select: { id: true, storageKey: true },
    });

    const { url, expiresAt } = await presignUpload({
      key: storageKey,
      contentType: declared,
      contentLength: input.declaredSizeBytes,
      maxBytes: absoluteMax,
    });

    return { assetId: asset.id, uploadUrl: url, expiresAt, storageKey };
  });
}

// ── Complete ────────────────────────────────────────────────────────────────

/**
 * Verify an uploaded object and move the asset to READY.
 *
 * A rejection marks the asset REJECTED with a reason and deletes the object —
 * a file that failed verification must not linger in the bucket.
 */
export async function completeMediaUpload(
  ctx: TenantContext,
  assetId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const asset = await withTenant(ctx, async (db) => {
    const found = await db.mediaAsset.findFirst({
      where: { id: assetId, deletedAt: null },
      select: {
        id: true,
        status: true,
        storageKey: true,
        mimeType: true,
        sizeBytes: true,
        kind: true,
        workspaceId: true,
        brandId: true,
      },
    });
    if (!found) throw new NotFoundError('Media asset');
    return found;
  });

  if (asset.status === 'READY') {
    // Completing twice is not an error — a retried request should be a no-op.
    return getMediaAsset(ctx, assetId);
  }

  if (asset.status === 'REJECTED') {
    throw new ConflictError('This upload was already rejected', {
      userMessage: 'That upload was rejected. Please upload the file again.',
    });
  }

  // Belt and braces: the key was derived, but signing anything is gated on it
  // belonging to this tenant.
  assertKeyBelongsTo(asset.storageKey, ctx.organizationId);

  try {
    const verified = await verifyUploadedObject({
      key: asset.storageKey,
      declaredMimeType: asset.mimeType,
      declaredSizeBytes: asset.sizeBytes,
      maxBytes: ABSOLUTE_MAX_BYTES[asset.kind],
    });

    if (verified.declaredTypeMismatch) {
      // Not fatal — browsers guess badly — but a deliberate mismatch is worth
      // seeing, and the sniffed type is what we store either way.
      logger.warn('declared media type did not match the bytes', {
        securityEvent: true,
        assetId,
        declared: asset.mimeType,
        actual: verified.mimeType,
      });
    }

    const updated = await withTenant(ctx, async (db) => {
      const row = await db.mediaAsset.update({
        where: { id: assetId },
        data: {
          status: 'READY',
          // Everything below is re-derived from the bytes, replacing whatever
          // the client declared.
          mimeType: verified.mimeType,
          kind: verified.kind,
          sizeBytes: verified.sizeBytes,
          width: verified.width ?? null,
          height: verified.height ?? null,
          durationMs: verified.durationMs ?? null,
          rejectionReason: null,
        },
        select: MEDIA_SELECT,
      });

      await audit(db, ctx, {
        action: 'media.uploaded',
        resourceType: 'MediaAsset',
        resourceId: assetId,
        workspaceId: asset.workspaceId,
        brandId: asset.brandId ?? undefined,
        after: {
          mimeType: verified.mimeType,
          sizeBytes: verified.sizeBytes,
          width: verified.width,
          height: verified.height,
          durationMs: verified.durationMs,
          declaredTypeMismatch: verified.declaredTypeMismatch,
        },
        ...fingerprint,
      });

      return row;
    });

    return updated;
  } catch (error) {
    const reason =
      error instanceof MediaRejected ? error.userMessage : 'The file could not be verified.';

    await withTenant(ctx, (db) =>
      db.mediaAsset.update({
        where: { id: assetId },
        data: { status: 'REJECTED', rejectionReason: reason },
      }),
    );

    // The bytes failed verification, so they do not stay in the bucket.
    await deleteObjects([asset.storageKey]).catch((cleanupError: unknown) => {
      logger.error('failed to remove a rejected upload', {
        assetId,
        reason: cleanupError instanceof Error ? cleanupError.message : 'unknown',
      });
    });

    logger.warn('media upload rejected', {
      assetId,
      declared: asset.mimeType,
      reason: error instanceof Error ? error.message : 'unknown',
    });

    throw error;
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

const MEDIA_SELECT = {
  id: true,
  kind: true,
  mimeType: true,
  sizeBytes: true,
  width: true,
  height: true,
  durationMs: true,
  originalFilename: true,
  tags: true,
  status: true,
  rejectionReason: true,
  workspaceId: true,
  brandId: true,
  folderId: true,
  createdAt: true,
} as const;

export async function getMediaAsset(ctx: TenantContext, assetId: string) {
  return withTenant(ctx, async (db) => {
    const asset = await db.mediaAsset.findFirst({
      where: { id: assetId, deletedAt: null },
      select: MEDIA_SELECT,
    });
    if (!asset) throw new NotFoundError('Media asset');
    return asset;
  });
}

export interface MediaFilter {
  workspaceId?: string;
  brandId?: string;
  kind?: MediaKind;
  /** Matched against the original filename and the tags, case-insensitively. */
  search?: string;
  /**
   * Narrow to one folder. `null` means the workspace root specifically —
   * distinct from `undefined`, which means "anywhere" (SRS §12).
   */
  folderId?: string | null;
  limit?: number;
}

/**
 * The where-clause both listings share.
 *
 * Note what is *not* here: an organization predicate. The tenant-scoped client
 * adds it, and RLS enforces it underneath — writing one by hand would suggest
 * the isolation is this function's job, and the day somebody forgot it, it
 * would be.
 */
function mediaWhere(filter: MediaFilter) {
  const search = filter.search?.trim();

  return {
    deletedAt: null,
    // Only verified assets are listed: PENDING and REJECTED are internal
    // states, and nothing should be attachable before it is checked.
    status: 'READY' as const,
    ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
    ...(filter.brandId ? { brandId: filter.brandId } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
    // `null` is a filter (root only); `undefined` is no filter at all.
    ...(filter.folderId !== undefined ? { folderId: filter.folderId } : {}),
    ...(search
      ? {
          OR: [
            { originalFilename: { contains: search, mode: 'insensitive' as const } },
            { tags: { has: search.toLowerCase() } },
          ],
        }
      : {}),
  };
}

export async function listMedia(ctx: TenantContext, filter: MediaFilter = {}) {
  return withTenant(ctx, (db) =>
    db.mediaAsset.findMany({
      where: mediaWhere(filter),
      select: MEDIA_SELECT,
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter.limit ?? 50, 200),
    }),
  );
}

/**
 * The same listing, plus a short-lived preview URL for each row.
 *
 * A library you cannot see is a list of filenames, so the grid needs the bytes.
 * The URLs are signed per object and expire, which is the same bargain
 * `getMediaDownloadUrl` makes — the difference is only that this makes it once
 * per page instead of once per click.
 *
 * `inline: true` here, unlike the download route: a thumbnail that arrives as
 * `attachment` is a download prompt, not a thumbnail. That is safe *because*
 * the Content-Type is the verified one — the browser renders what the bytes
 * actually were, never what the uploader claimed.
 */
export async function listMediaWithPreviews(ctx: TenantContext, filter: MediaFilter = {}) {
  const assets = await withTenant(ctx, (db) =>
    db.mediaAsset.findMany({
      where: mediaWhere(filter),
      select: { ...MEDIA_SELECT, storageKey: true },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter.limit ?? 60, 200),
    }),
  );

  return Promise.all(
    assets.map(async ({ storageKey, ...asset }) => {
      assertKeyBelongsTo(storageKey, ctx.organizationId);

      const { url } = await presignDownload({
        key: storageKey,
        contentType: asset.mimeType,
        filename: asset.originalFilename ?? undefined,
        inline: true,
      });

      return { ...asset, previewUrl: url };
    }),
  );
}

/**
 * A short-lived signed URL for one asset.
 *
 * Issued only after the tenant-scoped lookup succeeds, and only for a key that
 * carries this organization's prefix. A leaked URL grants fifteen minutes on
 * one object and never a listing.
 */
export async function getMediaDownloadUrl(
  ctx: TenantContext,
  assetId: string,
  options: { inline?: boolean } = {},
) {
  const asset = await withTenant(ctx, async (db) => {
    const found = await db.mediaAsset.findFirst({
      where: { id: assetId, deletedAt: null, status: 'READY' },
      select: { storageKey: true, mimeType: true, originalFilename: true },
    });
    if (!found) throw new NotFoundError('Media asset');
    return found;
  });

  assertKeyBelongsTo(asset.storageKey, ctx.organizationId);

  return presignDownload({
    key: asset.storageKey,
    // The verified type, never the declared one, and always with a
    // Content-Disposition — so a file that somehow slipped through is
    // downloaded rather than rendered.
    contentType: asset.mimeType,
    filename: asset.originalFilename ?? undefined,
    inline: options.inline ?? false,
  });
}

// ── Delete and cleanup ──────────────────────────────────────────────────────

export async function deleteMediaAsset(
  ctx: TenantContext,
  assetId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const asset = await db.mediaAsset.findFirst({
      where: { id: assetId, deletedAt: null },
      select: { id: true, workspaceId: true, brandId: true, originalFilename: true },
    });
    if (!asset) throw new NotFoundError('Media asset');

    const attached = await db.postMedia.count({ where: { mediaAssetId: assetId } });
    if (attached > 0) {
      throw new ConflictError('Media is still attached to a post', {
        userMessage: `This file is used by ${attached} post${
          attached === 1 ? '' : 's'
        }. Remove it from them first.`,
        context: { assetId, attached },
      });
    }

    // Soft delete; the nightly sweeper purges the object after a grace period,
    // so an accidental delete is recoverable (assumption C12).
    await db.mediaAsset.update({ where: { id: assetId }, data: { deletedAt: clock.now() } });

    await audit(db, ctx, {
      action: 'media.deleted',
      resourceType: 'MediaAsset',
      resourceId: assetId,
      workspaceId: asset.workspaceId,
      brandId: asset.brandId ?? undefined,
      before: { originalFilename: asset.originalFilename },
      ...fingerprint,
    });
  });
}

export interface CleanupResult {
  abandoned: number;
  purged: number;
}

/**
 * Sweep abandoned and soft-deleted media.
 *
 * Two populations:
 *   • PENDING assets whose upload never completed — the browser closed, the
 *     network dropped, the user changed their mind. The row is what makes
 *     these findable rather than orphaned in the bucket.
 *   • soft-deleted assets past their grace period.
 *
 * Runs from the maintenance queue (T1.11); exposed here so it is testable and
 * so an operator can trigger it.
 */
export async function cleanupMedia(
  ctx: TenantContext,
  options: { abandonedAfterMs?: number; purgeAfterMs?: number } = {},
): Promise<CleanupResult> {
  const abandonedAfter = options.abandonedAfterMs ?? 24 * 60 * 60 * 1000;
  const purgeAfter = options.purgeAfterMs ?? 30 * 24 * 60 * 60 * 1000;
  const now = clock.nowMs();

  const { abandonedKeys, purgedKeys } = await withTenant(ctx, async (db) => {
    const abandoned = await db.mediaAsset.findMany({
      where: {
        status: { in: ['PENDING', 'REJECTED'] },
        createdAt: { lt: new Date(now - abandonedAfter) },
        deletedAt: null,
      },
      select: { id: true, storageKey: true },
    });

    const purgeable = await db.mediaAsset.findMany({
      where: { deletedAt: { lt: new Date(now - purgeAfter) } },
      select: { id: true, storageKey: true },
    });

    if (abandoned.length > 0) {
      await db.mediaAsset.deleteMany({ where: { id: { in: abandoned.map((a) => a.id) } } });
    }
    if (purgeable.length > 0) {
      await db.postMedia.deleteMany({
        where: { mediaAssetId: { in: purgeable.map((a) => a.id) } },
      });
      await db.mediaAsset.deleteMany({ where: { id: { in: purgeable.map((a) => a.id) } } });
    }

    return {
      abandonedKeys: abandoned.map((a) => a.storageKey),
      purgedKeys: purgeable.map((a) => a.storageKey),
    };
  });

  // Objects go after the rows: a failure here leaves a recoverable orphan,
  // whereas the reverse would leave a row pointing at nothing.
  await deleteObjects([...abandonedKeys, ...purgedKeys]);

  if (abandonedKeys.length > 0 || purgedKeys.length > 0) {
    logger.info('media cleanup completed', {
      abandoned: abandonedKeys.length,
      purged: purgedKeys.length,
    });
  }

  return { abandoned: abandonedKeys.length, purged: purgedKeys.length };
}
