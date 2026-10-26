'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, useToast } from '@orbit/ui';
import { compactAge } from '@/features/community/thread';
import { ApiError, apiRequest } from '@/features/posts/ui/api';
import { categoryLabel } from '../labels';

/**
 * What the AI assistant has done in one conversation (**D-108**).
 *
 * Every draft it offered, every reply it sent and every hand-over, with the
 * documents it answered from and a way to say whether it was right. The
 * ratings are how an agency learns whether to trust it with AUTO — and, once it
 * has, whether it still should.
 */

export interface DecisionView {
  id: string;
  action: 'SUGGESTED' | 'REPLIED' | 'ESCALATED';
  category: string | null;
  reason: string | null;
  text: string | null;
  rating: boolean | null;
  createdAt: string;
  cited: { id: string; title: string }[];
}

const ACTION_LABEL: Record<DecisionView['action'], string> = {
  SUGGESTED: 'Drafted a reply',
  REPLIED: 'Replied on its own',
  ESCALATED: 'Handed to a person',
};

export function AssistantActivity({
  orgSlug,
  conversationId,
  decisions,
  renderedAt,
  canReply,
  mode,
  paused,
}: {
  orgSlug: string;
  conversationId: string;
  decisions: DecisionView[];
  renderedAt: string;
  canReply: boolean;
  mode: 'OFF' | 'SUGGEST' | 'AUTO';
  paused: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const now = React.useMemo(() => new Date(renderedAt), [renderedAt]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const base = `/api/v1/orgs/${encodeURIComponent(orgSlug)}/messages/${conversationId}`;

  async function post(path: string, body: unknown, done: string) {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`${base}/${path}`, { method: 'POST', body: JSON.stringify(body) });
      toast.show(done);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'OFF' && decisions.length === 0) return null;

  return (
    <section
      aria-label="AI assistant activity"
      className="mt-4 rounded-lg border border-line bg-surface px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">AI assistant</h3>
        {mode === 'AUTO' && canReply ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              void post(
                'assistant',
                { paused: !paused },
                paused
                  ? 'The assistant may answer here again.'
                  : 'The assistant will stay out of this conversation.',
              )
            }
          >
            {paused ? 'Let the assistant answer here' : 'Stop the assistant here'}
          </Button>
        ) : null}
      </div>

      {mode === 'AUTO' ? (
        <p className="mt-1 text-xs text-ink-muted">
          {paused
            ? 'Switched off for this conversation. Only the team answers here.'
            : 'May answer this conversation when nobody from the team has, using only the brand’s documents.'}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      {decisions.length === 0 ? (
        <p className="mt-2 text-sm text-ink-muted">Nothing yet.</p>
      ) : (
        <ol className="mt-3 space-y-3">
          {decisions.map((decision) => (
            <li key={decision.id} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge
                  tone={
                    decision.action === 'ESCALATED'
                      ? 'warning'
                      : decision.action === 'REPLIED'
                        ? 'info'
                        : 'neutral'
                  }
                >
                  {ACTION_LABEL[decision.action]}
                </Badge>
                <time dateTime={decision.createdAt} className="text-ink-muted">
                  {compactAge(decision.createdAt, now)}
                </time>
                {decision.category ? (
                  <span className="text-ink-secondary">{categoryLabel(decision.category)}</span>
                ) : null}
              </div>

              {decision.text ? (
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">
                  {decision.text}
                </p>
              ) : null}

              {decision.cited.length > 0 ? (
                <p className="mt-1 text-xs text-ink-muted">
                  From: {decision.cited.map((entry) => entry.title).join(', ')}
                </p>
              ) : null}

              {decision.action !== 'ESCALATED' && canReply ? (
                <div className="mt-1 flex items-center gap-2 text-xs">
                  <span className="text-ink-muted">Was this right?</span>
                  <Button
                    variant={decision.rating === true ? 'secondary' : 'ghost'}
                    size="sm"
                    disabled={busy}
                    aria-pressed={decision.rating === true}
                    onClick={() =>
                      void post(`decisions/${decision.id}`, { rating: true }, 'Thanks.')
                    }
                  >
                    Yes
                  </Button>
                  <Button
                    variant={decision.rating === false ? 'secondary' : 'ghost'}
                    size="sm"
                    disabled={busy}
                    aria-pressed={decision.rating === false}
                    onClick={() =>
                      void post(`decisions/${decision.id}`, { rating: false }, 'Thanks.')
                    }
                  >
                    No
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
