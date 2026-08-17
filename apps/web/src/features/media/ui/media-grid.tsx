'use client';

import { Badge } from '@orbit/ui';

/**
 * The library grid.
 *
 * Preview URLs are signed and short-lived, which is why this is a plain `img`
 * and not a Next `Image`: the optimizer would cache a URL that expires, and the
 * grid would rot into broken frames within the hour.
 *
 * Videos get a poster-less `<video>` with `preload="metadata"` — enough for the
 * browser to paint a first frame without pulling the whole file down for a
 * thumbnail nobody may click.
 */

export interface LibraryAsset {
  id: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  originalFilename: string | null;
  tags: string[];
  createdAt: string | Date;
  previewUrl: string;
}

export interface MediaGridProps {
  assets: LibraryAsset[];
  /**
   * Selection, for filing into folders. Omitted entirely when the caller has
   * nothing to do with a selection — a checkbox that leads nowhere is clutter.
   */
  selectedIds?: readonly string[];
  onToggle?: ((assetId: string, selected: boolean) => void) | undefined;
}

export function MediaGrid({ assets, selectedIds, onToggle }: MediaGridProps) {
  const selectable = Boolean(onToggle);

  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {assets.map((asset) => {
        const selected = selectedIds?.includes(asset.id) ?? false;

        return (
          <li
            key={asset.id}
            className={`overflow-hidden rounded border bg-surface ${
              selected ? 'border-accent ring-1 ring-accent' : 'border-line'
            }`}
          >
            {selectable ? (
              <label className="flex cursor-pointer items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-ink-secondary">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(event) => onToggle?.(asset.id, event.target.checked)}
                />
                {selected ? 'Selected' : 'Select'}
              </label>
            ) : null}

            <a
              href={asset.previewUrl}
              target="_blank"
              rel="noreferrer"
              className="block aspect-square bg-surface-sunken"
            >
              {asset.kind === 'IMAGE' ? (
                // A plain `img`, not `next/image`: the optimizer would cache a
                // URL that expires within the hour and the grid would rot.
                <img
                  src={asset.previewUrl}
                  alt={asset.originalFilename ?? 'Uploaded image'}
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              ) : asset.kind === 'VIDEO' ? (
                <video
                  src={asset.previewUrl}
                  preload="metadata"
                  muted
                  playsInline
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-sm text-ink-muted">
                  {asset.mimeType.split('/')[1]?.toUpperCase() ?? 'FILE'}
                </div>
              )}
            </a>

            <div className="space-y-1 px-3 py-2">
              <p className="truncate text-sm text-ink" title={asset.originalFilename ?? undefined}>
                {asset.originalFilename ?? 'Untitled'}
              </p>

              <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
                <Badge tone="neutral">{asset.kind}</Badge>
                <span>{size(asset.sizeBytes)}</span>
                {asset.width && asset.height ? (
                  <span>
                    {asset.width}×{asset.height}
                  </span>
                ) : null}
                {asset.durationMs ? <span>{Math.round(asset.durationMs / 1000)}s</span> : null}
              </div>

              {asset.tags.length > 0 ? (
                <p className="truncate text-xs text-ink-muted">{asset.tags.join(', ')}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
