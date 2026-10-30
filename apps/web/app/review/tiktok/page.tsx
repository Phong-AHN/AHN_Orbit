import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { TIKTOK_ANALYTICS_SCOPES, TIKTOK_PUBLISH_SCOPES } from '@orbit/providers/tiktok';
import {
  TIKTOK_REVIEW_MAX_UPLOAD_BYTES,
  TIKTOK_REVIEW_SESSION_COOKIE,
  openTikTokSession,
  tiktokReviewEnabled,
} from '@/features/tiktok-review/session';
import {
  getCreatorInfo,
  getPublishStatus,
  getUser,
  listVideos,
  type CreatorInfo,
  type TikTokUser,
  type TikTokVideo,
} from '@/features/tiktok-review/tiktok';
import { PostForm } from '@/features/tiktok-review/ui/post-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'TikTok integration review',
  // For TikTok's reviewers, reached from the review notes. Not for search.
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const ERRORS: Record<string, string> = {
  code: 'That access code is not correct. It is in our review notes.',
  consent: 'TikTok did not grant access. Start again and choose Authorize.',
  state: 'The sign-in link expired or was used twice. Start again.',
  token: 'TikTok did not return a token. Start again.',
  session: 'The session ended (it lasts 30 minutes). Connect again.',
  file: 'Choose a video file.',
  size: 'That file is larger than 4 MB. Choose a shorter clip.',
  type: 'Choose an MP4, MOV or WebM video.',
  privacy: 'Choose who can view the video, from the options shown.',
  consent_box: 'Tick the box to agree to TikTok’s Music Usage Confirmation before posting.',
  disclosure: 'With disclosure on, choose “Your brand”, “Branded content”, or both.',
  branded_private: 'Branded content cannot be posted as “Only me”. Choose another audience.',
  post: 'TikTok did not accept the post.',
};

const SCOPE_USE: Record<string, string> = {
  'user.info.basic':
    'Show the connected account’s name and avatar, so the agency knows which account it is publishing to.',
  'user.info.profile': 'Show the account’s @username next to its name.',
  'video.publish':
    'Publish a video the agency created and the client approved, directly to the account, with the privacy and interaction settings the user chooses.',
  'video.list':
    'List the account’s recent videos and their view and like counts, for the client’s performance report.',
};

/**
 * The page TikTok's app reviewers use to test Social Square's TikTok
 * integration without a Social Square account. See
 * `features/tiktok-review/session.ts` for what it stores (nothing) and how it
 * is gated (an access code).
 */
export default async function TikTokReviewPage({ searchParams }: PageProps) {
  if (!tiktokReviewEnabled()) notFound();

  const params = await searchParams;
  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : null);
  const error = one('error');
  const published = one('published');

  const session = openTikTokSession((await cookies()).get(TIKTOK_REVIEW_SESSION_COOKIE)?.value);

  let user: TikTokUser | null = null;
  let creator: CreatorInfo | null = null;
  let videos: TikTokVideo[] = [];
  let status: { status: string; failReason: string | null } | null = null;
  let readError: string | null = null;
  if (session) {
    try {
      [user, creator, videos] = await Promise.all([
        getUser(session.accessToken),
        getCreatorInfo(session.accessToken),
        listVideos(session.accessToken).catch(() => []),
      ]);
      if (published)
        status = await getPublishStatus(session.accessToken, published).catch(() => null);
    } catch (e) {
      readError = e instanceof Error ? e.message : 'TikTok could not be read.';
    }
  }

  const scopes = [...new Set([...TIKTOK_PUBLISH_SCOPES, ...TIKTOK_ANALYTICS_SCOPES])];

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-16">
      <header className="mb-10">
        <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-accent">
          Social Square
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-ink">
          TikTok integration — app review
        </h1>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-secondary">
          Social Square is a social media management platform. Agencies use it to schedule and
          publish content to their clients’ accounts. This page lets the TikTok review team exercise
          exactly the TikTok integration our customers use — Login Kit and the Content Posting API
          (Direct Post) — without creating a Social Square account. It requests the same scopes as
          the product, stores nothing, and revokes access when you press Disconnect.
        </p>
      </header>

      {error && ERRORS[error] ? (
        <p
          role="alert"
          className="mb-6 rounded-md border border-line bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          {ERRORS[error]}
          {error === 'post' && one('detail') ? ` TikTok said: ${one('detail')}` : null}
        </p>
      ) : null}
      {published ? (
        <p
          role="status"
          className="mb-6 rounded-md border border-line bg-success-soft px-4 py-3 text-sm text-ink"
        >
          Sent to TikTok. Publish ID <code className="font-mono">{published}</code>
          {status ? (
            <>
              {' '}
              — status <strong>{status.status}</strong>
              {status.failReason ? ` (${status.failReason})` : ''}
            </>
          ) : null}
          . TikTok can take a few minutes to process the video; reload to see the latest status.
        </p>
      ) : null}
      {one('disconnected') ? (
        <p
          role="status"
          className="mb-6 rounded-md border border-line bg-surface-sunken px-4 py-3 text-sm text-ink"
        >
          Disconnected. Access was revoked with TikTok and nothing was kept.
        </p>
      ) : null}

      <div className="space-y-10">
        <Section title="Scopes requested, and why">
          <ul className="space-y-3">
            {scopes.map((scope) => (
              <li key={scope} className="rounded-md border border-line bg-surface px-4 py-3">
                <code className="block font-mono text-xs text-ink">{scope}</code>
                <p className="mt-1 text-sm text-ink-secondary">{SCOPE_USE[scope]}</p>
              </li>
            ))}
          </ul>
          <P>
            Social Square does not request <code className="font-mono">user.info.stats</code> or any
            other scope. Nothing is ever posted without a person creating it and pressing Post.
          </P>
        </Section>

        {!session ? (
          <Section title="Step 1 — Connect a TikTok account">
            <P>
              Enter the access code from our review notes. You will be taken to TikTok’s
              authorization screen, which lists the scopes above. Choose Authorize to come back
              here.
            </P>
            <form method="post" action="/review/tiktok/start" className="flex flex-wrap gap-3">
              <label className="sr-only" htmlFor="tiktok-review-code">
                Access code
              </label>
              <input
                id="tiktok-review-code"
                name="code"
                type="password"
                required
                autoComplete="off"
                placeholder="Access code"
                className="w-64 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
              />
              <button
                type="submit"
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink"
              >
                Continue with TikTok
              </button>
            </form>
          </Section>
        ) : readError || !creator ? (
          <Section title="TikTok could not be read">
            <P>{readError ?? 'Try connecting again.'}</P>
            <Disconnect />
          </Section>
        ) : (
          <>
            <Section title="Step 2 — The connected account (user.info.basic, user.info.profile)">
              <div className="flex items-center gap-3 rounded-md border border-line bg-surface px-4 py-3 text-sm">
                {user?.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt=""
                    width={40}
                    height={40}
                    className="rounded-full"
                  />
                ) : null}
                <span>
                  <span className="font-medium text-ink">{user?.displayName}</span>
                  {user?.username ? (
                    <span className="text-ink-muted"> · @{user.username}</span>
                  ) : null}
                </span>
              </div>
            </Section>

            <Section title="Step 3 — Post a video (video.publish)">
              <P>
                This is how Social Square publishes a scheduled TikTok video: Direct Post, using the
                creator’s current options from TikTok. Use any short clip under{' '}
                {TIKTOK_REVIEW_MAX_UPLOAD_BYTES / 1024 / 1024} MB. While the app is under review,
                TikTok only allows posting as “Only me”.
              </P>
              <PostForm
                nickname={creator.nickname || user?.displayName || ''}
                privacyOptions={creator.privacyLevelOptions}
                commentDisabled={creator.commentDisabled}
                duetDisabled={creator.duetDisabled}
                stitchDisabled={creator.stitchDisabled}
                maxDurationSec={creator.maxVideoPostDurationSec}
                maxBytes={TIKTOK_REVIEW_MAX_UPLOAD_BYTES}
              />
            </Section>

            <Section title="Step 4 — Recent videos (video.list)">
              {videos.length === 0 ? (
                <P>No videos yet, or TikTok has not finished processing the new one.</P>
              ) : (
                <ul className="space-y-1 text-sm text-ink-secondary">
                  {videos.map((video) => (
                    <li key={video.id}>
                      {video.shareUrl ? (
                        <a
                          className="text-accent underline"
                          href={video.shareUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {video.title || video.id}
                        </a>
                      ) : (
                        <span className="text-ink">{video.title || video.id}</span>
                      )}{' '}
                      · {video.viewCount ?? 'n/a'} views · {video.likeCount ?? 'n/a'} likes
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Step 5 — Disconnect">
              <P>Revokes Social Square’s access with TikTok, as Disconnect does in the product.</P>
              <Disconnect />
            </Section>
          </>
        )}
      </div>
    </main>
  );
}

function Disconnect() {
  return (
    <form method="post" action="/review/tiktok/disconnect">
      <button
        type="submit"
        className="rounded-md border border-line px-4 py-2 text-sm font-medium text-ink"
      >
        Disconnect and revoke access
      </button>
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
      {children}
    </section>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="max-w-prose text-sm leading-relaxed text-ink-secondary">{children}</p>;
}
