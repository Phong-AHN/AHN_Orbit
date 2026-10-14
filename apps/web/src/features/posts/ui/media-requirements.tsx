'use client';

import * as React from 'react';
import { Badge, Card, CardBody, CardHeader, CardTitle, cn } from '@orbit/ui';
import {
  describeConstraint,
  describeFacts,
  describeMediaNeed,
  formatType,
  pinMediaIssues,
  worstSeverity,
  type MediaCapabilityView,
  type PinnedIssue,
} from '@/features/media/ui/facts';
import type { MediaItem } from '@/features/media/ui/media-panel';
import type { PostValidationResponse } from './api';

/**
 * What each targeted platform wants from the attachments, and what it said
 * about the ones that are there.
 *
 * ## The gap this closes
 *
 * The composer could already report that a post was invalid. It could not say
 * what the platform wanted, or what the file was. "Your video is too long"
 * with neither the length nor the limit on screen is not actionable — the only
 * way forward was to re-export and guess, which is exactly what people did.
 *
 * ## It renders the server's verdicts, it does not form its own
 *
 * Two kinds of text live here and the distinction is the whole design:
 *
 * - **Requirements** come from the capability descriptor and are *prose*. They
 *   say what a platform accepts. They never look at the attached files.
 * - **Verdicts** come from the `/validate` response and are *quoted*. Every
 *   error or warning shown is a message the server produced.
 *
 * There is no third category. Nothing here compares a file against a limit, so
 * there is no second validation engine to drift out of step with the real one —
 * the risk the summary module's own docstring warns about.
 *
 * The pinning works because the engine already names the attachment it is
 * talking about: `field` is `media[2]`, so the issue can sit under the third
 * file without anything in the browser deciding which file that is.
 *
 * ## A media error deliberately appears twice on the page
 *
 * The Checks card lists it too. Removing it from there was the first instinct
 * and it is wrong: Checks is the answer to "can this post go out", and it says
 * **"Everything checks out"** when its list is empty. Filtering media errors
 * out of it would make that sentence appear while a media error was on screen
 * a few inches above — a summary that lies is worse than a message said twice.
 *
 * So Checks stays the complete, authoritative list, and the copy here exists
 * for a different job: sitting against the file and the limit it concerns.
 */

export interface MediaRequirementsProps {
  media: MediaItem[];
  /**
   * One entry per distinct platform on the post. Resolved by the caller, which
   * holds the capability record and knows how it is keyed.
   */
  requirements: Array<{ platform: string; media: MediaCapabilityView }>;
  validation: PostValidationResponse | null;
}

export function MediaRequirements({ media, requirements, validation }: MediaRequirementsProps) {
  /**
   * Nothing to say yet: no platform to state a requirement for and no file to
   * describe. The panel appears with the first of either rather than sitting
   * empty on a new post.
   *
   * Both halves matter. With files but no account picked there are still facts
   * worth showing — and `MEDIA_NOT_READY` is a post-level media issue that can
   * exist before any account is chosen, so it would have nowhere to land.
   */
  if (requirements.length === 0 && media.length === 0) return null;

  // Only the media-scoped issues reach here, each already pinned to the
  // attachment the engine named. The filtering and the pinning are tested in
  // the facts module rather than being a condition buried in this render.
  const issues = validation
    ? pinMediaIssues(
        validation.postIssues,
        validation.variants.map((variant) => ({
          accountName: variant.accountName,
          issues: variant.result.issues,
        })),
      )
    : [];

  const setIssues = issues.filter((issue) => issue.index === null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Media requirements</CardTitle>
      </CardHeader>

      <CardBody className="space-y-5">
        {setIssues.length > 0 ? (
          <ul className="space-y-1.5">
            {setIssues.map((issue, index) => (
              <IssueLine key={`set-${index}`} issue={issue} />
            ))}
          </ul>
        ) : null}

        {media.length > 0 ? (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Attached
            </h3>

            <ul className="space-y-2">
              {media.map((item, index) => {
                const mine = issues.filter((issue) => issue.index === index);
                const worst = worstSeverity(mine);
                const facts = describeFacts(item);

                return (
                  <li
                    key={item.mediaAssetId}
                    className={cn(
                      'rounded border-l-2 pl-3',
                      worst === 'ERROR'
                        ? 'border-danger'
                        : worst === 'WARNING'
                          ? 'border-warning'
                          : 'border-line',
                    )}
                  >
                    <p className="text-sm text-ink">
                      <span className="text-ink-muted">{index + 1}. </span>
                      {item.originalFilename ?? formatType(item.mimeType)}
                      {/* The facts repeat what the attachment row shows, because
                          this is where they are compared against a limit and
                          the two are not always on screen together. */}
                      {facts.length > 0 ? (
                        <span className="text-xs text-ink-muted"> — {facts.join(' · ')}</span>
                      ) : null}
                    </p>

                    {mine.length > 0 ? (
                      <ul className="mt-1 space-y-1">
                        {mine.map((issue, i) => (
                          <IssueLine key={`${item.mediaAssetId}-${i}`} issue={issue} />
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {/* Guarded, or a post with files and no account picked yet shows this
            heading with nothing under it. */}
        {requirements.length > 0 ? (
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              What each platform accepts
            </h3>

            <ul className="space-y-3">
              {requirements.map(({ platform, media: capability }) => (
                <li key={platform} className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">{platform.toLowerCase()}</Badge>
                    <span className="text-sm text-ink">{describeMediaNeed(capability)}</span>
                  </div>

                  <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                    <ConstraintList label="Images" constraint={capability.image} />
                    <ConstraintList label="Video" constraint={capability.video} />
                    <ConstraintList label="GIF" constraint={capability.gif} />
                  </div>

                  {/* Stated only when it bites. A platform that happily mixes
                      kinds does not need to announce it. */}
                  {!capability.allowsMixedKinds && capability.image && capability.video ? (
                    <p className="text-xs text-ink-muted">
                      Images and video cannot go in the same post.
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </CardBody>
    </Card>
  );
}

function ConstraintList({
  label,
  constraint,
}: {
  label: string;
  constraint: MediaCapabilityView['image'];
}) {
  // An unsupported kind is left out rather than shown as "not supported":
  // `describeMediaNeed` has already said which kinds the platform takes, and
  // repeating the absence twice makes a short list look like a long one.
  if (!constraint) return null;

  return (
    <div className="text-xs text-ink-muted">
      <span className="font-medium text-ink-secondary">{label}: </span>
      {describeConstraint(constraint).join(' · ')}
    </div>
  );
}

function IssueLine({ issue }: { issue: PinnedIssue }) {
  return (
    <li className="flex gap-2 text-sm">
      <span
        aria-hidden="true"
        className={cn(
          'mt-1.5 size-1.5 shrink-0 rounded-full',
          issue.severity === 'ERROR' ? 'bg-danger' : 'bg-warning',
        )}
      />
      <span>
        {issue.where ? <span className="font-medium text-ink">{issue.where}: </span> : null}
        {/* The server's own words. Rewording them here is how two descriptions
            of the same rule start to disagree. */}
        <span className="text-ink-muted">{issue.message}</span>
      </span>
    </li>
  );
}
