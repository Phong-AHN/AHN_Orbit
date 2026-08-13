'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardBody, Field, Input, Select, Textarea } from '@orbit/ui';
import { ApiError, postsApi } from './api';

/**
 * Everything a post needs before the composer can open on it.
 *
 * The composer edits an existing post — it autosaves, validates per account and
 * runs the state machine, all of which need an id. So this collects the three
 * things a post cannot exist without (brand, accounts, a first draft of the
 * body) and hands off immediately; every other affordance lives in the composer
 * where it belongs, rather than being duplicated here.
 *
 * Accounts are chosen up front because each one becomes a `PostVariant`, and a
 * post with no variant is a post that can never publish.
 */

export interface PublishTargetAccount {
  id: string;
  displayName: string;
  platform: string;
  status: string;
}

export interface PublishTarget {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  accounts: PublishTargetAccount[];
}

export interface NewPostFormProps {
  orgSlug: string;
  targets: PublishTarget[];
}

export function NewPostForm({ orgSlug, targets }: NewPostFormProps) {
  const router = useRouter();
  const [brandId, setBrandId] = React.useState(targets[0]?.id ?? '');
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const brand = targets.find((target) => target.id === brandId);

  // Switching brand cannot keep the previous brand's accounts: a variant must
  // belong to the same brand as its post, and the server would refuse it.
  function chooseBrand(next: string) {
    setBrandId(next);
    setSelected(new Set());
  }

  function toggle(accountId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!brand) return;

    setBusy(true);
    setError(null);

    try {
      const { post } = await postsApi(orgSlug).create({
        workspaceId: brand.workspaceId,
        brandId: brand.id,
        ...(title.trim() ? { title: title.trim() } : {}),
        body,
        socialAccountIds: [...selected],
      });

      router.replace(`/orgs/${orgSlug}/posts/${post.id}`);
      router.refresh();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'We could not create the post. Please try again in a moment.',
      );
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardBody>
        <form className="space-y-5" onSubmit={(e) => void submit(e)}>
          <Field label="Brand" htmlFor="post-brand" required>
            <Select
              id="post-brand"
              value={brandId}
              disabled={busy}
              onChange={(event) => chooseBrand(event.target.value)}
            >
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.workspaceName} — {target.name}
                </option>
              ))}
            </Select>
          </Field>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">Publish to</legend>

            {!brand || brand.accounts.length === 0 ? (
              <p className="text-sm text-ink-muted">
                This brand has no connected accounts yet. You can still write the post and choose
                accounts later, but it cannot be scheduled until one is connected.
              </p>
            ) : (
              brand.accounts.map((account) => (
                <label
                  key={account.id}
                  className="flex cursor-pointer items-center gap-3 rounded border border-line px-3 py-2 hover:bg-surface-sunken"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(account.id)}
                    disabled={busy}
                    onChange={() => toggle(account.id)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-ink">{account.displayName}</span>
                    <span className="block text-xs text-ink-muted">
                      {account.platform}
                      {account.status === 'NEEDS_RECONNECT' ? ' · needs reconnecting' : ''}
                    </span>
                  </span>
                </label>
              ))
            )}
          </fieldset>

          <Field
            label="Internal title"
            htmlFor="post-title"
            hint="Optional. Only your team sees this — it is never published."
          >
            <Input
              id="post-title"
              value={title}
              maxLength={200}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>

          <Field
            label="Post"
            htmlFor="post-body"
            hint="A starting point. You can rewrite it per account in the composer."
          >
            <Textarea
              id="post-body"
              rows={6}
              value={body}
              disabled={busy}
              placeholder="What should this say?"
              onChange={(event) => setBody(event.target.value)}
            />
          </Field>

          {error ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          ) : null}

          <Button type="submit" loading={busy} disabled={busy || !brand}>
            Create draft
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
