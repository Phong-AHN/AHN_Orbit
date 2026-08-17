'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  Dialog,
  Empty,
  Field,
  Input,
  Select,
  Textarea,
  useToast,
} from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * The ideas board (Phase 4 P2, SRS §25).
 *
 * The API shipped without a surface, which meant the feature existed and
 * nobody could use it. This is the surface.
 *
 * **An idea is a note, and the UI keeps it that way.** One required field —
 * the topic — and everything else optional, because the point of writing an
 * idea down in a planning meeting is that it takes five seconds. A form that
 * demanded a platform, a caption and a date would be a draft, and drafts
 * already exist.
 *
 * **Converting is the one irreversible act here**, so it confirms: it creates a
 * post, marks the idea converted, and the idea can never be edited again. The
 * dialog says so rather than letting somebody discover it.
 */

export interface Idea {
  id: string;
  topic: string;
  hook: string | null;
  platform: string | null;
  caption: string | null;
  cta: string | null;
  plannedFor: string | null;
  state: string;
  brand: { id: string; name: string };
  generatedBy: { name: string | null; email: string } | null;
  convertedPosts: Array<{ id: string }>;
}

export interface IdeaBoardProps {
  orgSlug: string;
  ideas: Idea[];
  brands: Array<{ id: string; name: string; workspaceId: string }>;
  canCreate: boolean;
  canUpdate: boolean;
  /** Current filter, mirrored from the URL so a filtered board is shareable. */
  filter: { state: string; brandId: string; q: string };
}

const STATE_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'info'> = {
  SUGGESTED: 'neutral',
  ACCEPTED: 'accent',
  CONVERTED: 'success',
  DISMISSED: 'info',
};

const STATE_LABEL: Record<string, string> = {
  SUGGESTED: 'Idea',
  ACCEPTED: 'Agreed',
  CONVERTED: 'Became a post',
  DISMISSED: 'Dropped',
};

export function IdeaBoard({
  orgSlug,
  ideas,
  brands,
  canCreate,
  canUpdate,
  filter,
}: IdeaBoardProps) {
  const router = useRouter();
  const toast = useToast();

  const [creating, setCreating] = React.useState(false);
  const [converting, setConverting] = React.useState<Idea | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const base = `/api/v1/orgs/${encodeURIComponent(orgSlug)}/content-ideas`;

  async function setState(idea: Idea, state: 'ACCEPTED' | 'DISMISSED' | 'SUGGESTED') {
    setBusy(idea.id);
    setError(null);

    try {
      await apiRequest(`${base}/${idea.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ state }),
      });

      toast.show(
        state === 'ACCEPTED'
          ? 'Marked as agreed.'
          : state === 'DISMISSED'
            ? 'Dropped.'
            : 'Back on the board.',
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be changed.');
    } finally {
      setBusy(null);
    }
  }

  async function convert(idea: Idea) {
    setBusy(idea.id);
    setError(null);

    try {
      const { post } = await apiRequest<{ post: { id: string } }>(`${base}/${idea.id}/convert`, {
        method: 'POST',
      });

      toast.show('Draft created. Opening it now.');
      setConverting(null);
      router.push(`/orgs/${orgSlug}/posts/${post.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not become a post.');
      setConverting(null);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <Filters orgSlug={orgSlug} brands={brands} filter={filter} />

      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      {canCreate ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setCreating(true)}>
            Add an idea
          </Button>
        </div>
      ) : null}

      {ideas.length === 0 ? (
        <Empty
          title={
            filter.q || filter.state || filter.brandId ? 'Nothing matches that' : 'No ideas yet'
          }
          description={
            filter.q || filter.state || filter.brandId
              ? 'Try a different search, brand or status.'
              : 'Ideas are the things worth writing down before they become posts — a topic and a hook is enough.'
          }
          {...(canCreate && !filter.q
            ? {
                action: (
                  <Button size="sm" onClick={() => setCreating(true)}>
                    Add the first one
                  </Button>
                ),
              }
            : {})}
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ideas.map((idea) => (
            <li key={idea.id}>
              <Card className="flex h-full flex-col">
                <CardBody className="flex flex-1 flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={STATE_TONE[idea.state] ?? 'neutral'}>
                      {STATE_LABEL[idea.state] ?? idea.state}
                    </Badge>
                    <span className="truncate text-xs text-ink-muted">{idea.brand.name}</span>
                    {idea.platform ? <Badge tone="neutral">{idea.platform}</Badge> : null}
                  </div>

                  <p className="text-sm font-medium text-ink">{idea.topic}</p>

                  {idea.hook ? (
                    <p className="line-clamp-3 text-sm text-ink-secondary">{idea.hook}</p>
                  ) : null}

                  <p className="mt-auto text-xs text-ink-muted">
                    {idea.plannedFor ? `Planned for ${idea.plannedFor.slice(0, 10)}` : 'No date'}
                    {idea.generatedBy
                      ? ` · ${idea.generatedBy.name ?? idea.generatedBy.email}`
                      : ''}
                  </p>

                  {canUpdate && idea.state !== 'CONVERTED' ? (
                    <div className="flex flex-wrap gap-1.5 border-t border-line pt-2">
                      {idea.state !== 'ACCEPTED' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => void setState(idea, 'ACCEPTED')}
                        >
                          Agree
                        </Button>
                      ) : null}

                      <Button
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => setConverting(idea)}
                      >
                        Make a post
                      </Button>

                      {idea.state !== 'DISMISSED' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-auto"
                          disabled={busy !== null}
                          onClick={() => void setState(idea, 'DISMISSED')}
                        >
                          Drop
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-auto"
                          disabled={busy !== null}
                          onClick={() => void setState(idea, 'SUGGESTED')}
                        >
                          Restore
                        </Button>
                      )}
                    </div>
                  ) : null}

                  {idea.state === 'CONVERTED' && idea.convertedPosts[0] ? (
                    <a
                      href={`/orgs/${orgSlug}/posts/${idea.convertedPosts[0].id}`}
                      className="border-t border-line pt-2 text-sm font-medium text-accent hover:underline"
                    >
                      Open the post →
                    </a>
                  ) : null}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <CreateIdea
        orgSlug={orgSlug}
        brands={brands}
        open={creating}
        onClose={() => setCreating(false)}
      />

      <ConfirmDialog
        open={converting !== null}
        busy={busy !== null}
        onClose={() => setConverting(null)}
        onConfirm={async () => {
          if (converting) await convert(converting);
        }}
        title="Turn this into a post?"
        description="A draft is created and opened. Nothing is scheduled or published."
        confirmLabel="Create the draft"
        tone="primary"
      >
        <p className="text-sm text-ink-secondary">
          The idea is kept as the record of where the post came from, and cannot be edited
          afterwards. An idea becomes a post once.
        </p>
      </ConfirmDialog>
    </div>
  );
}

/**
 * Filters, in the URL.
 *
 * A filtered board is a thing people send to each other, and it survives a
 * reload. The server re-reads and re-validates either way.
 */
function Filters({
  orgSlug,
  brands,
  filter,
}: {
  orgSlug: string;
  brands: IdeaBoardProps['brands'];
  filter: IdeaBoardProps['filter'];
}) {
  const router = useRouter();
  const [q, setQ] = React.useState(filter.q);

  function apply(next: Partial<IdeaBoardProps['filter']>) {
    const merged = { ...filter, q, ...next };
    const params = new URLSearchParams();

    if (merged.q.trim()) params.set('q', merged.q.trim());
    if (merged.state) params.set('state', merged.state);
    if (merged.brandId) params.set('brandId', merged.brandId);

    const query = params.toString();
    router.replace(`/orgs/${orgSlug}/ideas${query ? `?${query}` : ''}`);
  }

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        apply({});
      }}
    >
      <div className="min-w-[12rem] flex-1">
        <label htmlFor="idea-search" className="mb-1 block text-sm font-medium text-ink">
          Search
        </label>
        <Input
          id="idea-search"
          type="search"
          value={q}
          placeholder="Topic or hook"
          onChange={(event) => setQ(event.target.value)}
        />
      </div>

      <div>
        <label htmlFor="idea-state" className="mb-1 block text-sm font-medium text-ink">
          Status
        </label>
        <Select
          id="idea-state"
          value={filter.state}
          onChange={(event) => apply({ state: event.target.value })}
        >
          <option value="">All</option>
          <option value="SUGGESTED">Ideas</option>
          <option value="ACCEPTED">Agreed</option>
          <option value="CONVERTED">Became posts</option>
          <option value="DISMISSED">Dropped</option>
        </Select>
      </div>

      {brands.length > 1 ? (
        <div>
          <label htmlFor="idea-brand" className="mb-1 block text-sm font-medium text-ink">
            Brand
          </label>
          <Select
            id="idea-brand"
            value={filter.brandId}
            onChange={(event) => apply({ brandId: event.target.value })}
          >
            <option value="">All brands</option>
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      <Button type="submit" variant="secondary">
        Search
      </Button>
    </form>
  );
}

function CreateIdea({
  orgSlug,
  brands,
  open,
  onClose,
}: {
  orgSlug: string;
  brands: IdeaBoardProps['brands'];
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();

  const [brandId, setBrandId] = React.useState(brands[0]?.id ?? '');
  const [topic, setTopic] = React.useState('');
  const [hook, setHook] = React.useState('');
  const [plannedFor, setPlannedFor] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    const brand = brands.find((candidate) => candidate.id === brandId);
    if (!brand) return;

    setBusy(true);
    setError(null);

    try {
      await apiRequest(`/api/v1/orgs/${encodeURIComponent(orgSlug)}/content-ideas`, {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: brand.workspaceId,
          brandId: brand.id,
          topic: topic.trim(),
          ...(hook.trim() ? { hook: hook.trim() } : {}),
          ...(plannedFor ? { plannedFor } : {}),
        }),
      });

      toast.show('Idea added.');
      setTopic('');
      setHook('');
      setPlannedFor('');
      onClose();
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add an idea"
      description="A topic is enough. Everything else can wait until it becomes a post."
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={busy}
            disabled={busy || topic.trim().length < 3 || !brandId}
            onClick={() => void submit()}
          >
            Add
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Brand" htmlFor="idea-brand-new" required>
          <Select
            id="idea-brand-new"
            value={brandId}
            disabled={busy}
            onChange={(event) => setBrandId(event.target.value)}
          >
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Topic" htmlFor="idea-topic" required>
          <Input
            id="idea-topic"
            value={topic}
            disabled={busy}
            autoFocus
            placeholder="Behind the scenes at the roastery"
            onChange={(event) => setTopic(event.target.value)}
          />
        </Field>

        <Field label="Hook" htmlFor="idea-hook" hint="The angle, if you have one already.">
          <Textarea
            id="idea-hook"
            rows={3}
            value={hook}
            disabled={busy}
            onChange={(event) => setHook(event.target.value)}
          />
        </Field>

        <Field label="Planned for" htmlFor="idea-date" hint="Optional. Puts it on the plan.">
          <Input
            id="idea-date"
            type="date"
            value={plannedFor}
            disabled={busy}
            onChange={(event) => setPlannedFor(event.target.value)}
          />
        </Field>

        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
