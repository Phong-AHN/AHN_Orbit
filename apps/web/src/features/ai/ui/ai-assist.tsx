'use client';

import * as React from 'react';
import { Badge, Button, Input } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * The writing assistant, inside the composer (T4.5, SRS §24–25).
 *
 * **Nothing here changes the post.** A suggestion appears in its own panel, and
 * the text only reaches the editor when a person presses Use — which is the
 * whole of §25's "AI can never trigger publishing" expressed where a user can
 * see it. There is no auto-apply, no silent replacement, and no path from a
 * generation to a scheduled post.
 *
 * **Banned terms warn, they do not block.** The suggestion is shown, the words
 * are named, and Use stays enabled: the person writing knows the context better
 * than a word list does, and a warning that removes the option is a warning
 * people route around by pasting.
 */

export interface AIAssistProps {
  orgSlug: string;
  brandId: string;
  /** The current post text, which rewrite and hashtags work from. */
  body: string;
  platform?: string | undefined;
  maxLength?: number | undefined;
  disabled?: boolean;
  /** Called only when the person accepts a suggestion. */
  onAccept: (text: string) => void;
}

type Mode = 'caption' | 'rewrite' | 'hashtags' | 'repurpose';

interface Suggestion {
  mode: Mode;
  text: string;
  bannedTermHits: string[];
  /**
   * Why the text came out the shape it did.
   *
   * Without this an adapted caption just looks shorter, as though the model
   * lost something. Saying "Instagram caps captions at 2,200 characters and
   * does not render links" turns an apparent defect into an explanation.
   */
  constraints?: { targetPlatform: string; maxLength: number; supportsLinks: boolean } | undefined;
}

export function AIAssist({
  orgSlug,
  brandId,
  body,
  platform,
  maxLength,
  disabled,
  onAccept,
}: AIAssistProps) {
  const [open, setOpen] = React.useState(false);
  const [intent, setIntent] = React.useState('');
  const [busy, setBusy] = React.useState<Mode | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [suggestion, setSuggestion] = React.useState<Suggestion | null>(null);

  const base = `/api/v1/orgs/${encodeURIComponent(orgSlug)}/ai`;
  const hasBody = body.trim().length > 0;

  /**
   * What is left, reported by the thing that spends it.
   *
   * One request is one credit (**D-066**). The balance comes back **with each
   * generation** rather than from `/ai/usage`, which is guarded by
   * `ai:view_usage` and held only by an Owner or Admin — a Content Creator
   * would never have seen it, and a feature that silently stops working
   * mid-month is a feature people stop trusting (**D-077**).
   */
  const [remaining, setRemaining] = React.useState<number | null>(null);

  async function run(mode: Mode, path: string, payload: Record<string, unknown>) {
    setBusy(mode);
    setError(null);

    try {
      const data = await apiRequest<{
        suggestion?: string;
        hashtags?: string[];
        bannedTermHits: string[];
        creditsRemaining: number | null;
        constraints?: { targetPlatform: string; maxLength: number; supportsLinks: boolean };
      }>(`${base}/${path}`, {
        method: 'POST',
        body: JSON.stringify({
          brandId,
          ...(platform ? { platform } : {}),
          ...payload,
        }),
      });

      setSuggestion({
        mode,
        text: data.suggestion ?? (data.hashtags ?? []).join(' '),
        bannedTermHits: data.bannedTermHits,
        constraints: data.constraints,
      });
      setRemaining(data.creditsRemaining);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be generated.');
    } finally {
      setBusy(null);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        Writing assistant
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded border border-line bg-surface-sunken p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">Writing assistant</span>

        {remaining !== null ? (
          <Badge tone={remaining <= 5 ? 'warning' : 'neutral'}>{remaining} left this month</Badge>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => {
            setOpen(false);
            setSuggestion(null);
            setError(null);
          }}
        >
          Close
        </Button>
      </div>

      <div className="space-y-2">
        <Input
          aria-label="What is this post about?"
          value={intent}
          disabled={busy !== null || disabled}
          placeholder="What is this post about?"
          onChange={(event) => setIntent(event.target.value)}
        />

        {remaining === 0 ? (
          <p className="text-xs text-warning">
            No AI suggestions left this month. Everything else still works.
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            loading={busy === 'caption'}
            disabled={busy !== null || disabled || intent.trim().length < 3}
            onClick={() =>
              void run('caption', 'caption', {
                intent: intent.trim(),
                ...(maxLength ? { maxLength } : {}),
              })
            }
          >
            Draft a caption
          </Button>

          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'rewrite'}
            disabled={busy !== null || disabled || !hasBody}
            onClick={() =>
              void run('rewrite', 'rewrite', {
                text: body,
                mode: 'shorten',
                ...(maxLength ? { maxLength } : {}),
              })
            }
          >
            Shorten
          </Button>

          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'rewrite'}
            disabled={busy !== null || disabled || !hasBody}
            onClick={() => void run('rewrite', 'rewrite', { text: body, mode: 'rephrase' })}
          >
            Rephrase
          </Button>

          {/* Adapting is a different act from rewriting: it changes what the
              words are *for*, using the target platform's real constraints. */}
          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'repurpose'}
            disabled={busy !== null || disabled || !hasBody}
            onClick={() =>
              void run('repurpose', 'repurpose', {
                text: body,
                targetPlatform: 'INSTAGRAM',
                ...(platform ? { sourcePlatform: platform } : {}),
              })
            }
          >
            Adapt for Instagram
          </Button>

          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'repurpose'}
            disabled={busy !== null || disabled || !hasBody}
            onClick={() =>
              void run('repurpose', 'repurpose', {
                text: body,
                targetPlatform: 'FACEBOOK',
                ...(platform ? { sourcePlatform: platform } : {}),
              })
            }
          >
            Adapt for Facebook
          </Button>

          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'hashtags'}
            disabled={busy !== null || disabled || !hasBody}
            onClick={() => void run('hashtags', 'hashtags', { text: body, count: 8 })}
          >
            Hashtags
          </Button>
        </div>

        {!hasBody ? (
          <p className="text-xs text-ink-muted">
            Shorten, rephrase and hashtags work from the post text. Write something first, or draft
            a caption.
          </p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      {suggestion ? (
        <div className="space-y-2 rounded border border-line bg-surface p-3">
          {suggestion.constraints ? (
            <p className="text-xs text-ink-muted">
              Written for {suggestion.constraints.targetPlatform.toLowerCase()}: up to{' '}
              {suggestion.constraints.maxLength.toLocaleString('en-US')} characters
              {suggestion.constraints.supportsLinks
                ? '.'
                : ', and no clickable links in captions — any URL was removed.'}
            </p>
          ) : null}

          {suggestion.bannedTermHits.length > 0 ? (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-secondary">
              <Badge tone="warning">Check this</Badge>
              This uses {suggestion.bannedTermHits.map((term) => `“${term}”`).join(', ')}, which the
              brand avoids.
            </p>
          ) : null}

          <p className="whitespace-pre-wrap text-sm text-ink">{suggestion.text}</p>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => {
                // Hashtags append; a caption or a rewrite replaces. Neither
                // happens without this click.
                onAccept(
                  suggestion.mode === 'hashtags'
                    ? `${body.trimEnd()}\n\n${suggestion.text}`.trim()
                    : suggestion.text,
                );
                setSuggestion(null);
              }}
            >
              {suggestion.mode === 'hashtags' ? 'Add to post' : 'Use this'}
            </Button>

            <Button size="sm" variant="ghost" onClick={() => setSuggestion(null)}>
              Discard
            </Button>

            <span className="text-xs text-ink-muted">
              A suggestion. Nothing changes until you use it.
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
