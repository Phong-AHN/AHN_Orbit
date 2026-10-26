import { Badge } from '@orbit/ui';
import { platformName, safeExternalUrl } from './links';
import { VARIANT_STATE_LABEL, VARIANT_STATE_TONE, type VariantPublishState } from './status';

/**
 * Where one account's version of a post ended up, and the link to it.
 *
 * The heading the attempt timeline below it was missing: with several
 * accounts on a post, a column of identical "Attempts" cards said nothing
 * about which account each one was. And a post marked Published with no way
 * to open it is a claim nobody can check — the link is what lets somebody see
 * the post exists, on which account, and manage it there.
 *
 * The address is shown as text as well as linked, so it can be copied into a
 * message to the client without opening the platform first.
 */
export function VariantOutcome({
  variant,
  timezone,
}: {
  variant: {
    platform: string;
    status: VariantPublishState;
    externalPostId: string | null;
    externalPermalink: string | null;
    publishedAt: Date | null;
    socialAccount: { displayName: string };
  };
  timezone: string;
}) {
  const link = safeExternalUrl(variant.externalPermalink);
  const name = platformName(variant.platform);

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-semibold text-ink">
          {name} · {variant.socialAccount.displayName}
        </p>

        {variant.publishedAt ? (
          <p className="text-xs text-ink-muted">
            Published{' '}
            <time dateTime={variant.publishedAt.toISOString()}>
              {variant.publishedAt.toLocaleString('en-GB', {
                timeZone: timezone,
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </time>{' '}
            ({timezone})
          </p>
        ) : null}

        {link ? (
          <p className="break-all font-mono text-xs text-ink-secondary">{link}</p>
        ) : variant.status === 'PUBLISHED' && variant.externalPostId ? (
          // Published, and the platform gave an id but no link. Say so rather
          // than leave the card looking like nothing happened.
          <p className="text-xs text-ink-muted">
            {name} did not return a link. Post id:{' '}
            <span className="break-all font-mono">{variant.externalPostId}</span>
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Badge tone={VARIANT_STATE_TONE[variant.status]}>
          {VARIANT_STATE_LABEL[variant.status]}
        </Badge>
        {link ? (
          // `noreferrer` as well as `noopener`: a public page has no need to
          // learn which Orbit screen somebody arrived from.
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded text-sm font-medium text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            View on {name} ↗
          </a>
        ) : null}
      </div>
    </div>
  );
}
