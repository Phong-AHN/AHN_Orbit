'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Dialog, Field, Input, Select, Textarea } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';
import { viewUrl } from './api';
import type { LibraryAsset } from './library-picker';

/**
 * Generate an image with AI (D-110), from the composer or the media library.
 *
 * The image lands in the library, tagged `ai-generated`, exactly like an
 * upload; from the composer it is attached to the post as well. The person
 * sees it before it is used — nothing here publishes anything.
 */

const RATIOS: Array<{ value: string; label: string }> = [
  { value: '1:1', label: 'Square 1:1 — feed posts' },
  { value: '4:5', label: 'Portrait 4:5 — Instagram feed' },
  { value: '9:16', label: 'Vertical 9:16 — Stories, Reels, TikTok' },
  { value: '16:9', label: 'Wide 16:9 — YouTube, LinkedIn, X' },
  { value: '3:4', label: 'Portrait 3:4 — Pinterest' },
  { value: '4:3', label: 'Landscape 4:3' },
];

interface GeneratedAsset {
  id: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  frameRate: number | null;
  peakFrameRate: number | null;
  originalFilename: string | null;
}

export interface GenerateImageProps {
  orgSlug: string;
  /** Fixed in the composer. On the library page the person chooses instead. */
  target?: { workspaceId: string; brandId: string };
  brands?: Array<{ id: string; workspaceId: string; label: string }>;
  disabled?: boolean;
  /** "Attach" in the composer; just "Done" in the library. */
  confirmLabel?: string;
  onGenerated: (asset: LibraryAsset) => void;
}

export function GenerateImage({
  orgSlug,
  target,
  brands = [],
  disabled,
  confirmLabel = 'Done',
  onGenerated,
}: GenerateImageProps) {
  const [open, setOpen] = React.useState(false);
  const [brandId, setBrandId] = React.useState(target?.brandId ?? brands[0]?.id ?? '');
  const [prompt, setPrompt] = React.useState('');
  const [ratio, setRatio] = React.useState('1:1');
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<LibraryAsset | null>(null);

  const chosen =
    target ??
    (() => {
      const brand = brands.find((b) => b.id === brandId);
      return brand ? { workspaceId: brand.workspaceId, brandId: brand.id } : null;
    })();

  function close() {
    setOpen(false);
    setResult(null);
    setError(null);
  }

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    if (!chosen || prompt.trim().length < 5) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const { asset } = await apiRequest<{ asset: GeneratedAsset }>(
        `/api/v1/orgs/${encodeURIComponent(orgSlug)}/media/generate`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...chosen,
            prompt: prompt.trim(),
            aspectRatio: ratio,
            ...(text.trim() ? { textInImage: text.trim() } : {}),
          }),
        },
      );
      const { url } = await viewUrl(orgSlug, asset.id);
      setResult({ ...asset, previewUrl: url });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The image could not be generated. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled || (!target && brands.length === 0)}
        onClick={() => setOpen(true)}
      >
        Generate image
      </Button>

      <Dialog
        open={open}
        onClose={close}
        title="Generate an image with AI"
        description="Saved to the media library and tagged ai-generated. Uses one AI credit."
        className="w-[min(40rem,calc(100vw-2rem))]"
        footer={
          result ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
                Try another
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  onGenerated(result);
                  close();
                  setPrompt('');
                  setText('');
                }}
              >
                {confirmLabel}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button
                size="sm"
                type="submit"
                form="generate-image-form"
                loading={busy}
                loadingLabel="Generating"
                disabled={!chosen || prompt.trim().length < 5}
              >
                Generate
              </Button>
            </>
          )
        }
      >
        {result ? (
          <div className="space-y-3">
            <img
              src={result.previewUrl}
              alt={`AI-generated image: ${prompt}`}
              className="max-h-[50vh] w-full rounded-md border border-line object-contain"
            />
            <p className="text-xs text-ink-muted">
              <Badge tone="info">ai-generated</Badge> Some platforms ask that realistic AI images be
              labelled as AI-made when you publish them.
            </p>
          </div>
        ) : (
          <form id="generate-image-form" className="space-y-4" onSubmit={(e) => void generate(e)}>
            {!target ? (
              <Field label="Brand" htmlFor="generate-image-brand">
                <Select
                  id="generate-image-brand"
                  value={brandId}
                  onChange={(e) => setBrandId(e.target.value)}
                  disabled={busy}
                >
                  {brands.map((brand) => (
                    <option key={brand.id} value={brand.id}>
                      {brand.label}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field
              label="Describe the image"
              htmlFor="generate-image-prompt"
              hint="Subject, setting, mood, style. It never shows real people or other brands’ logos."
            >
              <Textarea
                id="generate-image-prompt"
                rows={4}
                value={prompt}
                maxLength={1_500}
                disabled={busy}
                placeholder="A warm evening networking event on a rooftop, people chatting with drinks, soft golden light, photo style"
                onChange={(e) => setPrompt(e.target.value)}
              />
            </Field>
            <Field label="Shape" htmlFor="generate-image-ratio">
              <Select
                id="generate-image-ratio"
                value={ratio}
                onChange={(e) => setRatio(e.target.value)}
                disabled={busy}
              >
                {RATIOS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Text in the image (optional)"
              htmlFor="generate-image-text"
              hint="Leave empty for no text. Short words render best."
            >
              <Input
                id="generate-image-text"
                value={text}
                maxLength={120}
                disabled={busy}
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
            {busy ? (
              <p className="text-sm text-ink-muted">Generating — this can take up to a minute…</p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
          </form>
        )}
      </Dialog>
    </>
  );
}

/** The library page's version: the new image simply appears in the grid. */
export function LibraryGenerateImage({
  orgSlug,
  brands,
}: {
  orgSlug: string;
  brands: Array<{ id: string; workspaceId: string; label: string }>;
}) {
  const router = useRouter();
  return <GenerateImage orgSlug={orgSlug} brands={brands} onGenerated={() => router.refresh()} />;
}
