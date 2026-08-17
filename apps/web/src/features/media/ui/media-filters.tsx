'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button, Input, Select } from '@orbit/ui';

/**
 * Filters that live in the URL.
 *
 * A library is browsed by narrowing, and a narrowed view is worth sending to a
 * colleague — so the state belongs in the address bar, not in a hook. The
 * server re-reads it either way, so a pasted or edited URL is just another
 * request.
 */

export interface MediaFiltersProps {
  brands: Array<{ id: string; label: string }>;
  /** Folders live per client, so choosing one is what turns folders on. */
  clients: Array<{ id: string; name: string }>;
  initial: { q: string; kind: string; brandId: string; workspaceId: string };
}

export function MediaFilters({ brands, clients, initial }: MediaFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();

  const [q, setQ] = React.useState(initial.q);
  const [kind, setKind] = React.useState(initial.kind);
  const [brandId, setBrandId] = React.useState(initial.brandId);
  const [workspaceId, setWorkspaceId] = React.useState(initial.workspaceId);

  function apply(next: { q?: string; kind?: string; brandId?: string; workspaceId?: string }) {
    const params = new URLSearchParams();
    const merged = { q, kind, brandId, workspaceId, ...next };

    if (merged.q.trim()) params.set('q', merged.q.trim());
    if (merged.kind) params.set('kind', merged.kind);
    if (merged.brandId) params.set('brandId', merged.brandId);
    if (merged.workspaceId) params.set('workspaceId', merged.workspaceId);
    // Changing client leaves any folder behind: a folder id from one client is
    // meaningless under another, and carrying it would show an empty view with
    // no explanation.

    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  }

  const dirty = Boolean(q || kind || brandId || workspaceId);

  return (
    <form
      className="mb-6 flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        apply({});
      }}
    >
      <div className="min-w-[14rem] flex-1">
        <label htmlFor="media-search" className="mb-1 block text-sm font-medium text-ink">
          Search
        </label>
        <Input
          id="media-search"
          type="search"
          value={q}
          placeholder="Filename or tag"
          onChange={(event) => setQ(event.target.value)}
        />
      </div>

      <div>
        <label htmlFor="media-kind" className="mb-1 block text-sm font-medium text-ink">
          Type
        </label>
        <Select
          id="media-kind"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value);
            apply({ kind: event.target.value });
          }}
        >
          <option value="">All types</option>
          <option value="IMAGE">Images</option>
          <option value="GIF">GIFs</option>
          <option value="VIDEO">Video</option>
        </Select>
      </div>

      {clients.length > 0 ? (
        <div>
          <label htmlFor="media-client" className="mb-1 block text-sm font-medium text-ink">
            Client
          </label>
          <Select
            id="media-client"
            value={workspaceId}
            onChange={(event) => {
              setWorkspaceId(event.target.value);
              apply({ workspaceId: event.target.value });
            }}
          >
            <option value="">All clients</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      {brands.length > 0 ? (
        <div>
          <label htmlFor="media-brand" className="mb-1 block text-sm font-medium text-ink">
            Brand
          </label>
          <Select
            id="media-brand"
            value={brandId}
            onChange={(event) => {
              setBrandId(event.target.value);
              apply({ brandId: event.target.value });
            }}
          >
            <option value="">All brands</option>
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.label}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      <Button type="submit" variant="secondary">
        Search
      </Button>

      {dirty ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setQ('');
            setKind('');
            setBrandId('');
            setWorkspaceId('');
            router.replace(pathname);
          }}
        >
          Clear
        </Button>
      ) : null}
    </form>
  );
}
