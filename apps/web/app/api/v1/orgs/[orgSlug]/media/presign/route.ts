import { z } from 'zod';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { presignMediaUpload } from '@/features/media/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

const schema = z.object({
  workspaceId: z.string().uuid(),
  brandId: z.string().uuid().optional(),
  filename: z.string().max(400).optional(),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().positive(),
});

/**
 * Reserve an asset and return a presigned PUT.
 *
 * Everything the client sends here is a *claim*: the type, the size and the
 * filename are all re-derived from the bytes after the upload completes.
 */
export const POST = withAuth<Params>(
  {
    permission: 'media:upload',
    resource: async ({ request }) => {
      const body = await request
        .clone()
        .json()
        .catch(() => ({}));
      const parsed = schema.partial().safeParse(body);
      return parsed.success && parsed.data.workspaceId
        ? {
            workspaceId: parsed.data.workspaceId,
            ...(parsed.data.brandId ? { brandId: parsed.data.brandId } : {}),
          }
        : {};
    },
    name: 'POST /api/v1/orgs/{orgSlug}/media/presign',
  },
  async ({ request, ctx }) => {
    const input = await readJsonBody(request, schema);

    const result = await presignMediaUpload(ctx, {
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      filename: input.filename,
      declaredMimeType: input.contentType,
      declaredSizeBytes: input.sizeBytes,
    });

    return jsonOk(result, { status: 201 });
  },
);
