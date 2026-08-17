'use client';

import * as React from 'react';
import { Badge, Button, Dialog, Input, Loading, useToast } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * Choosing something already uploaded (SRS §17).
 *
 * The gap this closes was small to describe and expensive to live with: an
 * agency that shot a campaign once had to upload it again for every post that
 * used it, which meant the media library filled with duplicates of the same
 * photograph and the storage bill counted each one.
 *
 * Scoped to the brand being written for. An agency's library spans clients, and
 * a picker that showed all of it would make attaching one client's photograph
 * to another client's post a one-click mistake — the API enforces the boundary,
 * but the UI should not offer the error in the first place.
 */

export interface LibraryAsset {
  id: string;
  kind: string;
  mimeType: string;
  originalFilename: string | null;
  previewUrl: string;
}

export interface LibraryPickerProps {
  orgSlug: string;
  brandId: string;
  /** Already attached, so they can be shown as chosen rather than offered twice. */
  attachedIds: readonly string[];
  disabled?: boolean;
  onPick: (assets: LibraryAsset[]) => void;
}

export function LibraryPicker({
  orgSlug,
  brandId,
  attachedIds,
  disabled,
  onPick,
}: LibraryPickerProps) {
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [assets, setAssets] = React.useState<LibraryAsset[] | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(
    async (search: string) => {
      setAssets(null);
      setError(null);

      try {
        const params = new URLSearchParams({ brandId, kind: 'IMAGE' });
        if (search.trim()) params.set('q', search.trim());

        const { assets: found } = await apiRequest<{ assets: LibraryAsset[] }>(
          `/api/v1/orgs/${encodeURIComponent(orgSlug)}/media?${params.toString()}`,
        );

        setAssets(found);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'The library could not be loaded.');
        setAssets([]);
      }
    },
    [brandId, orgSlug],
  );

  React.useEffect(() => {
    if (open) void load(query);
    // Deliberately not keyed on `query`: searching is an explicit act below, so
    // typing does not fire a request per keystroke.
  }, [open, load]);

  function confirm() {
    const chosen = (assets ?? []).filter((asset) => selected.includes(asset.id));

    onPick(chosen);
    toast.show(
      chosen.length === 1 ? 'Added from the library.' : `Added ${chosen.length} from the library.`,
    );

    setSelected([]);
    setOpen(false);
  }

  return (
    <>
      <Button variant="secondary" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        From library
      </Button>

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setSelected([]);
        }}
        title="Attach from the library"
        description="Images already uploaded for this brand. Nothing is re-uploaded."
        className="w-[min(48rem,calc(100vw-2rem))]"
        footer={
          <>
            <span className="mr-auto text-xs text-ink-muted">
              {selected.length > 0 ? `${selected.length} selected` : 'Nothing selected'}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                setSelected([]);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={selected.length === 0} onClick={confirm}>
              Attach
            </Button>
          </>
        }
      >
        <form
          className="mb-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void load(query);
          }}
        >
          <Input
            type="search"
            aria-label="Search the library"
            placeholder="Filename or tag"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button type="submit" variant="secondary" size="sm">
            Search
          </Button>
        </form>

        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}

        {assets === null ? (
          <Loading label="Loading the library" rows={2} />
        ) : assets.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-muted">
            {query.trim()
              ? 'Nothing matches that.'
              : 'Nothing in the library for this brand yet. Upload a file and it appears here.'}
          </p>
        ) : (
          <ul className="grid max-h-80 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-4">
            {assets.map((asset) => {
              const already = attachedIds.includes(asset.id);
              const isSelected = selected.includes(asset.id);

              return (
                <li key={asset.id}>
                  <label
                    className={`block cursor-pointer overflow-hidden rounded border-2 transition-colors ${
                      isSelected ? 'border-accent' : 'border-line hover:border-line-strong'
                    } ${already ? 'opacity-50' : ''}`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={isSelected}
                      disabled={already}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, asset.id]
                            : current.filter((id) => id !== asset.id),
                        )
                      }
                    />

                    <span className="block aspect-square bg-surface-sunken">
                      {/* A plain `img`: the URL is signed and expires, and
                          `next/image` would cache it past its life and leave a
                          broken frame. */}
                      <img
                        src={asset.previewUrl}
                        alt={asset.originalFilename ?? 'Uploaded image'}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    </span>

                    <span className="flex items-center gap-1 px-2 py-1.5">
                      <span className="truncate text-xs text-ink-secondary">
                        {asset.originalFilename ?? 'Untitled'}
                      </span>
                      {already ? <Badge tone="neutral">Attached</Badge> : null}
                      {isSelected ? <Badge tone="accent">✓</Badge> : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </Dialog>
    </>
  );
}
