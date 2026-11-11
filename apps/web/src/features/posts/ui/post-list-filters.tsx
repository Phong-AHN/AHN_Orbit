'use client';

import * as React from 'react';
import Form from 'next/form';
import Link from 'next/link';
import { Button, Input, Select, buttonClassName } from '@orbit/ui';

/**
 * Search, filter and sort for the post list.
 *
 * A GET form (`next/form`, so it navigates without a full reload), which keeps
 * the page server-rendered and gives every view a URL that can be bookmarked or
 * sent to a colleague. A dropdown applies as soon as
 * it changes; the search applies on Enter or the button, so typing does not
 * reload the page on every letter.
 *
 * The options arrive as props: what this viewer may filter by is decided on the
 * server, and this component imports nothing that would pull server code into
 * the browser.
 */

export interface PostListFilterValues {
  q?: string | undefined;
  status?: string | undefined;
  platform?: string | undefined;
  workspaceId?: string | undefined;
  brandId?: string | undefined;
  sort: string;
}

interface Option {
  value: string;
  label: string;
}

export interface PostListFiltersProps {
  action: string;
  values: PostListFilterValues;
  statuses: Option[];
  platforms: Option[];
  sorts: Option[];
  clients: Option[];
  /** Brands with the client they belong to, so the list can narrow to one client. */
  brands: Array<Option & { workspaceId: string; clientName: string }>;
  filtered: boolean;
}

export function PostListFilters({
  action,
  values,
  statuses,
  platforms,
  sorts,
  clients,
  brands,
  filtered,
}: PostListFiltersProps) {
  const formRef = React.useRef<HTMLFormElement>(null);

  // A brand from another client would match nothing, so the brand list follows
  // the client picked.
  const [clientId, setClientId] = React.useState(values.workspaceId ?? '');
  const shownBrands = clientId ? brands.filter((brand) => brand.workspaceId === clientId) : brands;

  const submit = () => formRef.current?.requestSubmit();

  return (
    <Form
      ref={formRef}
      action={action}
      role="search"
      aria-label="Search and filter posts"
      className="space-y-3 rounded-lg border border-line bg-surface p-3"
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="posts-q" className="sr-only">
          Search posts
        </label>
        <Input
          id="posts-q"
          name="q"
          type="search"
          defaultValue={values.q ?? ''}
          placeholder="Search title or text"
          maxLength={100}
          className="sm:flex-1"
        />
        <div className="flex gap-2">
          <Button type="submit" size="sm">
            Search
          </Button>
          {filtered ? (
            <Link href={action} className={buttonClassName({ variant: 'ghost', size: 'sm' })}>
              Clear
            </Link>
          ) : null}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <FilterSelect
          id="posts-status"
          name="status"
          label="Status"
          allLabel="All statuses"
          value={values.status}
          options={statuses}
          onChange={submit}
        />
        <FilterSelect
          id="posts-platform"
          name="platform"
          label="Platform"
          allLabel="All platforms"
          value={values.platform}
          options={platforms}
          onChange={submit}
        />
        {clients.length > 1 ? (
          <FilterSelect
            id="posts-client"
            name="workspaceId"
            label="Client"
            allLabel="All clients"
            value={values.workspaceId}
            options={clients}
            onChange={(next) => {
              setClientId(next);
              // A brand that belongs to another client goes with the change.
              const brandSelect = formRef.current?.elements.namedItem('brandId');
              if (brandSelect instanceof HTMLSelectElement) {
                const stillFits = brands.some(
                  (brand) => brand.value === brandSelect.value && brand.workspaceId === next,
                );
                if (!stillFits) brandSelect.value = '';
              }
              submit();
            }}
          />
        ) : null}
        {brands.length > 1 ? (
          <FilterSelect
            id="posts-brand"
            name="brandId"
            label="Brand"
            allLabel="All brands"
            value={values.brandId}
            options={shownBrands.map((brand) => ({
              value: brand.value,
              label:
                clientId || clients.length <= 1
                  ? brand.label
                  : `${brand.clientName} · ${brand.label}`,
            }))}
            onChange={submit}
          />
        ) : null}
        <FilterSelect
          id="posts-sort"
          name="sort"
          label="Sort"
          value={values.sort}
          options={sorts}
          onChange={submit}
        />
      </div>
    </Form>
  );
}

function FilterSelect({
  id,
  name,
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  id: string;
  name: string;
  label: string;
  /** The "no filter" choice. Absent for sort, which always has a value. */
  allLabel?: string;
  value: string | undefined;
  options: Option[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-ink-muted">
        {label}
      </label>
      <Select
        id={id}
        name={name}
        defaultValue={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
      >
        {allLabel ? <option value="">{allLabel}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
