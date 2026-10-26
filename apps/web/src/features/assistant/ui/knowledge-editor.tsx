'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Textarea,
  cn,
} from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * What the assistant may answer from (**D-108**).
 *
 * Plain text, pasted: an FAQ is a question and its answer, a document is
 * anything longer — opening hours, shipping, a returns policy. An entry
 * marked as an internal note stays here for the team and never reaches the
 * model, which is the place for anything the assistant must not repeat.
 */

export interface KnowledgeEntryView {
  id: string;
  kind: 'FAQ' | 'DOCUMENT';
  title: string;
  question: string | null;
  content: string;
  usableByAssistant: boolean;
  updatedAt: string;
}

interface Draft {
  kind: 'FAQ' | 'DOCUMENT';
  title: string;
  question: string;
  content: string;
  usableByAssistant: boolean;
}

const EMPTY: Draft = { kind: 'FAQ', title: '', question: '', content: '', usableByAssistant: true };

export function KnowledgeEditor({
  orgSlug,
  brandId,
  entries,
  usedChars,
  maxChars,
}: {
  orgSlug: string;
  brandId: string;
  entries: KnowledgeEntryView[];
  usedChars: number;
  maxChars: number;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<string | 'new' | null>(null);
  const [draft, setDraft] = React.useState<Draft>(EMPTY);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const base = `/api/v1/orgs/${encodeURIComponent(orgSlug)}/brands/${encodeURIComponent(brandId)}/assistant/knowledge`;

  function open(entry: KnowledgeEntryView | null) {
    setError(null);
    if (!entry) {
      setEditing('new');
      setDraft(EMPTY);
      return;
    }
    setEditing(entry.id);
    setDraft({
      kind: entry.kind,
      title: entry.title,
      question: entry.question ?? '',
      content: entry.content,
      usableByAssistant: entry.usableByAssistant,
    });
  }

  async function run(request: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await request();
      setEditing(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    const body = JSON.stringify({
      kind: draft.kind,
      title: draft.title.trim(),
      question: draft.kind === 'FAQ' ? draft.question.trim() : '',
      content: draft.content.trim(),
      usableByAssistant: draft.usableByAssistant,
    });

    void run(() =>
      editing === 'new'
        ? apiRequest(base, { method: 'POST', body })
        : apiRequest(`${base}/${editing}`, { method: 'PATCH', body }),
    );
  }

  function remove(entry: KnowledgeEntryView) {
    if (!window.confirm(`Delete “${entry.title}”? The assistant will stop answering from it.`)) {
      return;
    }
    void run(() => apiRequest(`${base}/${entry.id}`, { method: 'DELETE' }));
  }

  const percent = Math.min(100, Math.round((usedChars / maxChars) * 100));

  return (
    <Card>
      <CardHeader>
        <CardTitle>What the assistant knows</CardTitle>
      </CardHeader>

      <CardBody>
        <p className="text-sm text-ink-secondary">
          The assistant answers only from these entries. If the answer is not written here, it hands
          the conversation to the team instead of guessing — so prices, hours and policies belong
          here, in the words you want customers to read.
        </p>

        <div className="mt-3">
          <div className="flex justify-between text-xs text-ink-muted">
            <span>Used by the assistant</span>
            <span className="tabular-nums">
              {usedChars.toLocaleString()} / {maxChars.toLocaleString()} characters
            </span>
          </div>
          <div
            className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Knowledge used"
          >
            <div
              className={cn('h-full', percent > 90 ? 'bg-danger' : 'bg-accent')}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}

        <ul className="mt-4 divide-y divide-line">
          {entries.length === 0 ? (
            <li className="py-4 text-sm text-ink-muted">
              Nothing yet. Start with the five questions customers ask most.
            </li>
          ) : null}
          {entries.map((entry) => (
            <li key={entry.id} className="py-3">
              {editing === entry.id ? (
                <EntryForm
                  draft={draft}
                  setDraft={setDraft}
                  busy={busy}
                  onSubmit={save}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-ink">{entry.title}</span>
                      <Badge tone="neutral">{entry.kind === 'FAQ' ? 'FAQ' : 'Document'}</Badge>
                      {!entry.usableByAssistant ? (
                        <Badge tone="warning">Internal note</Badge>
                      ) : null}
                    </div>
                    {entry.question ? (
                      <p className="mt-1 text-xs text-ink-muted">Q: {entry.question}</p>
                    ) : null}
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-ink-secondary">
                      {entry.content}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => open(entry)}>
                      Edit
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => remove(entry)}>
                      Delete
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>

        {editing === 'new' ? (
          <div className="mt-4 rounded-md border border-line p-3">
            <EntryForm
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              onSubmit={save}
              onCancel={() => setEditing(null)}
            />
          </div>
        ) : (
          <Button className="mt-4" variant="secondary" onClick={() => open(null)} disabled={busy}>
            Add an entry
          </Button>
        )}
      </CardBody>
    </Card>
  );
}

function EntryForm({
  draft,
  setDraft,
  busy,
  onSubmit,
  onCancel,
}: {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  busy: boolean;
  onSubmit: (event: React.FormEvent) => void;
  onCancel: () => void;
}) {
  const set = <K extends keyof Draft>(field: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [field]: value }));

  return (
    <form className="space-y-3" onSubmit={onSubmit}>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <Field label="Type" htmlFor="kb-kind">
          <Select
            id="kb-kind"
            value={draft.kind}
            disabled={busy}
            onChange={(e) => set('kind', e.target.value as Draft['kind'])}
          >
            <option value="FAQ">FAQ</option>
            <option value="DOCUMENT">Document</option>
          </Select>
        </Field>
        <Field label="Title" htmlFor="kb-title" required>
          <Input
            id="kb-title"
            value={draft.title}
            maxLength={200}
            disabled={busy}
            onChange={(e) => set('title', e.target.value)}
          />
        </Field>
      </div>

      {draft.kind === 'FAQ' ? (
        <Field label="The question, as a customer asks it" htmlFor="kb-question">
          <Input
            id="kb-question"
            value={draft.question}
            maxLength={500}
            disabled={busy}
            onChange={(e) => set('question', e.target.value)}
          />
        </Field>
      ) : null}

      <Field
        label={draft.kind === 'FAQ' ? 'The answer' : 'Content'}
        htmlFor="kb-content"
        required
        hint="Write facts exactly: the assistant may only repeat numbers, links and addresses that appear here."
      >
        <Textarea
          id="kb-content"
          rows={draft.kind === 'FAQ' ? 4 : 10}
          value={draft.content}
          maxLength={10_000}
          disabled={busy}
          onChange={(e) => set('content', e.target.value)}
        />
      </Field>

      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={!draft.usableByAssistant}
          disabled={busy}
          onChange={(e) => set('usableByAssistant', !e.target.checked)}
        />
        Internal note — keep it here for the team, never show it to the assistant
      </label>

      <div className="flex gap-2">
        <Button
          type="submit"
          loading={busy}
          loadingLabel="Saving"
          disabled={!draft.title.trim() || !draft.content.trim()}
        >
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
