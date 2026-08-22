'use client';

import * as React from 'react';
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, cn } from '@orbit/ui';
import type { PostDetail } from './api';
import { TikTokOptionsPanel, type TikTokOptions } from './tiktok-options';
import { YouTubeOptionsPanel, type YouTubeOptions } from './youtube-options';
import { PinterestOptionsPanel, type PinterestOptions } from './pinterest-options';
import {
  joinList,
  missingPlatformSettings,
  requiresPlatformSettings,
  summariseMissingSettings,
  type AttachmentSummary,
  type RequiredSetting,
} from './platform-settings';

/**
 * Every platform's per-post settings, for every account, on one card.
 *
 * ## The problem this replaces
 *
 * These panels used to live inside the per-account text editor, which shows one
 * account at a time. Composing for Facebook, YouTube and Pinterest at once, you
 * would see YouTube's declaration only after clicking YouTube's tab — so the
 * normal way to compose a multi-platform post was to never see two of the three
 * things the post could not publish without. The post looked finished, was
 * approved, was scheduled, and failed at its scheduled time.
 *
 * So: **one card, every account that needs something, all of it visible.**
 * Accounts with something outstanding sit at the top and are open. Accounts that
 * are done collapse to a single "Ready" line — still there, still openable, out
 * of the way.
 *
 * ## What it does not do
 *
 * It does not decide whether the post can publish. `/validate` runs the real
 * engine server-side and the adapter refuses at publish time regardless; this is
 * the same information said early, where it can still be acted on. A warning
 * here that the server disagreed with would teach people to ignore the one that
 * matters, which is why the copy says what is missing rather than pronouncing
 * the post invalid.
 */

export interface PlatformSettingsPanelProps {
  orgSlug: string;
  variants: PostDetail['variants'];
  /** The composer's live attachments — Pinterest's cover rule reads them. */
  media: readonly AttachmentSummary[];
  readOnly: boolean;
  /** Persist one variant's settings. Rejects so the panel can show the error. */
  onSave: (variantId: string, next: Record<string, unknown>) => Promise<void>;
}

export function PlatformSettingsPanel({
  orgSlug,
  variants,
  media,
  readOnly,
  onSave,
}: PlatformSettingsPanelProps) {
  const rows = variants
    .filter((variant) => requiresPlatformSettings(variant.platform))
    .map((variant) => ({
      variant,
      missing: missingPlatformSettings({
        platform: variant.platform,
        options: variant.platformOptions,
        media,
      }),
    }));

  // Nothing on this post asks for anything. Render nothing at all rather than an
  // empty card explaining that there is nothing to explain.
  if (rows.length === 0) return null;

  /**
   * Unfinished first, and stable within each group.
   *
   * `sort` is stable in every engine this runs on, so accounts keep the order
   * they were selected in — a list that reshuffles as you fill it in is
   * disorienting when you are working down it.
   */
  const ordered = [...rows].sort(
    (a, b) => Number(b.missing.length > 0) - Number(a.missing.length > 0),
  );

  const summary = summariseMissingSettings(
    rows.map((row) => ({
      platform: row.variant.platform,
      accountName: row.variant.socialAccount.displayName,
      missing: row.missing,
    })),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Platform settings{' '}
          <span className="text-sm font-normal text-ink-muted">
            — required by {rows.length === 1 ? 'this platform' : 'these platforms'}
          </span>
        </CardTitle>
      </CardHeader>

      <CardBody className="space-y-3">
        {summary ? (
          <Alert tone="warning" title="This post cannot publish yet">
            {summary} Orbit does not choose these for you — each one is a decision about a
            client&rsquo;s content or audience.
          </Alert>
        ) : (
          <p className="text-sm text-ink-secondary">
            Every account that needs settings has them. They are still editable below.
          </p>
        )}

        {ordered.map((row) => (
          <AccountSettings
            key={row.variant.id}
            orgSlug={orgSlug}
            variant={row.variant}
            missing={row.missing}
            readOnly={readOnly}
            onSave={(next) => onSave(row.variant.id, next)}
          />
        ))}
      </CardBody>
    </Card>
  );
}

// ── One account ─────────────────────────────────────────────────────────────

function AccountSettings({
  orgSlug,
  variant,
  missing,
  readOnly,
  onSave,
}: {
  orgSlug: string;
  variant: PostDetail['variants'][number];
  missing: RequiredSetting[];
  readOnly: boolean;
  onSave: (next: Record<string, unknown>) => Promise<void>;
}) {
  const incomplete = missing.length > 0;

  /**
   * Open when something is missing, closed when it is done.
   *
   * Initial state only — deliberately not kept in sync afterwards. Collapsing a
   * section the moment somebody finishes filling it in would snatch the
   * controls away at the exact instant they might want to change their mind,
   * and a panel that moves under the cursor reads as a bug.
   */
  const [open, setOpen] = React.useState(incomplete);

  const saved = (variant.platformOptions ?? {}) as Record<string, unknown>;
  const platform = variant.platform.toUpperCase();

  return (
    <div
      className={cn(
        'rounded-lg border',
        incomplete ? 'border-warning/50 bg-warning-soft/30' : 'border-line bg-surface',
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left"
      >
        <span
          aria-hidden="true"
          className={cn(
            'mt-1 shrink-0 text-xs transition-transform',
            open ? 'rotate-90' : 'rotate-0',
          )}
        >
          ▶
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">
              {variant.socialAccount.displayName}
            </span>
            <Badge tone="neutral">{platform.toLowerCase()}</Badge>
            {incomplete ? (
              <Badge tone="warning">Needs {missing.length === 1 ? 'a setting' : 'settings'}</Badge>
            ) : (
              <Badge tone="success">Ready</Badge>
            )}
          </span>

          {/* Named on the collapsed row too, so a closed section still says what
              is wrong with it — otherwise the only way to find out is to open
              every one of them. */}
          {incomplete ? (
            <span className="mt-1 block text-xs text-ink-secondary">
              Still needs {joinList(missing.map((item) => item.label))}.
            </span>
          ) : null}
        </span>
      </button>

      {open ? (
        <div className="border-t border-line/70 p-3">
          {platform === 'TIKTOK' ? (
            <TikTokOptionsPanel
              orgSlug={orgSlug}
              socialAccountId={variant.socialAccountId}
              accountName={variant.socialAccount.displayName}
              saved={saved as TikTokOptions}
              disabled={readOnly}
              /* Spread rather than passed through: an interface has no index
                 signature, so it is not assignable to Record<string, unknown>
                 without one. The object literal is. */
              onSave={(next: TikTokOptions) => onSave({ ...next })}
            />
          ) : platform === 'YOUTUBE' ? (
            <YouTubeOptionsPanel
              socialAccountId={variant.socialAccountId}
              accountName={variant.socialAccount.displayName}
              saved={saved as YouTubeOptions}
              disabled={readOnly}
              /* Spread rather than passed through: an interface has no index
                 signature, so it is not assignable to Record<string, unknown>
                 without one. The object literal is. */
              onSave={(next: YouTubeOptions) => onSave({ ...next })}
            />
          ) : platform === 'PINTEREST' ? (
            <PinterestOptionsPanel
              orgSlug={orgSlug}
              socialAccountId={variant.socialAccountId}
              accountName={variant.socialAccount.displayName}
              saved={saved as PinterestOptions}
              disabled={readOnly}
              /* Spread rather than passed through: an interface has no index
                 signature, so it is not assignable to Record<string, unknown>
                 without one. The object literal is. */
              onSave={(next: PinterestOptions) => onSave({ ...next })}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
