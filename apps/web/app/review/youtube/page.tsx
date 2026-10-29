import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { YOUTUBE_PUBLISH_SCOPES } from '@orbit/providers/youtube';
import {
  REVIEW_MAX_UPLOAD_BYTES,
  REVIEW_SESSION_COOKIE,
  openSession,
  reviewEnabled,
} from '@/features/google-review/session';
import {
  listChannels,
  listRecentUploads,
  type ReviewChannel,
  type ReviewVideo,
} from '@/features/google-review/youtube';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'YouTube integration review',
  // For Google's reviewers, reached from the reply email. Not for search.
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const ERRORS: Record<string, string> = {
  code: 'That access code is not correct. It is in our reply email.',
  consent: 'Google did not grant access. Start again and choose Allow on the consent screen.',
  state: 'The sign-in link expired or was used twice. Start again.',
  token: 'Google did not return a token. Start again.',
  session: 'The session ended (it lasts 30 minutes). Connect again.',
  file: 'Choose a video file.',
  size: 'That file is larger than 4 MB. Choose a shorter clip.',
  type: 'That is not a video file.',
  title: 'Give the video a title.',
  privacy: 'Choose who can see the video.',
  kids: 'Say whether the video is made for children. YouTube requires it, and Orbit never assumes it.',
  upload: 'YouTube did not accept the upload. Try again with a different clip.',
};

const SCOPE_USE: Record<string, string> = {
  'https://www.googleapis.com/auth/youtube.upload':
    'Upload a video the agency scheduled for this channel. Orbit only ever creates videos — it never edits or deletes one.',
  'https://www.googleapis.com/auth/youtube.readonly':
    'List the channels the signed-in account owns, so the agency picks the right one, and read a published video’s status and view counts for the client’s report.',
};

/**
 * The page Google's verification team uses to test AHN Orbit's YouTube
 * integration without an Orbit account. See `features/google-review/session.ts`
 * for what it stores (nothing) and how it is gated (an access code).
 */
export default async function YouTubeReviewPage({ searchParams }: PageProps) {
  if (!reviewEnabled()) notFound();

  const params = await searchParams;
  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : null);
  const error = one('error');
  const uploaded = one('uploaded');

  const session = openSession((await cookies()).get(REVIEW_SESSION_COOKIE)?.value);

  let channels: ReviewChannel[] = [];
  let uploads: ReviewVideo[] = [];
  let readError: string | null = null;
  if (session) {
    try {
      channels = await listChannels(session.accessToken);
      const first = channels[0];
      if (first?.uploadsPlaylistId) {
        uploads = await listRecentUploads(session.accessToken, first.uploadsPlaylistId);
      }
    } catch (e) {
      readError = e instanceof Error ? e.message : 'YouTube could not be read.';
    }
  }

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-16">
      <header className="mb-10">
        <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-accent">AHN Orbit</p>
        <h1 className="text-3xl font-semibold tracking-tight text-ink">
          YouTube integration — verification review
        </h1>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-ink-secondary">
          AHN Orbit is a social media management platform. Agencies use it to schedule and publish
          content to their clients’ channels. This page lets the Google review team exercise exactly
          the YouTube integration our customers use, without creating an Orbit account. It requests
          the same two scopes as the product, stores nothing, and revokes access when you press
          Disconnect.
        </p>
      </header>

      {error && ERRORS[error] ? (
        <p
          role="alert"
          className="mb-6 rounded-md border border-line bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          {ERRORS[error]}
        </p>
      ) : null}
      {uploaded ? (
        <p
          role="status"
          className="mb-6 rounded-md border border-line bg-success-soft px-4 py-3 text-sm text-ink"
        >
          Uploaded. Video ID <code className="font-mono">{uploaded}</code> —{' '}
          <a
            className="text-accent underline"
            href={`https://www.youtube.com/watch?v=${encodeURIComponent(uploaded)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            open on YouTube
          </a>
          . It also appears in “Recent uploads” below once YouTube has processed it.
        </p>
      ) : null}
      {one('disconnected') ? (
        <p
          role="status"
          className="mb-6 rounded-md border border-line bg-surface-sunken px-4 py-3 text-sm text-ink"
        >
          Disconnected. Access was revoked with Google and nothing was kept.
        </p>
      ) : null}

      <div className="space-y-10">
        <Section title="Scopes requested, and why">
          <ul className="space-y-3">
            {YOUTUBE_PUBLISH_SCOPES.map((scope) => (
              <li key={scope} className="rounded-md border border-line bg-surface px-4 py-3">
                <code className="block break-all font-mono text-xs text-ink">{scope}</code>
                <p className="mt-1 text-sm text-ink-secondary">{SCOPE_USE[scope]}</p>
              </li>
            ))}
          </ul>
          <P>
            Orbit does not request the broader <code className="font-mono">youtube</code> or{' '}
            <code className="font-mono">youtube.force-ssl</code> scopes: it never deletes videos,
            edits playlists or manages comments. Listing a user’s own channels and reading a video’s
            statistics are not possible with <code className="font-mono">youtube.upload</code>{' '}
            alone, which is why <code className="font-mono">youtube.readonly</code> is requested
            beside it.
          </P>
        </Section>

        {!session ? (
          <Section title="Step 1 — Connect a YouTube channel">
            <P>
              Enter the access code from our reply email. You will be taken to Google’s consent
              screen, which lists both scopes above. Choose Allow to come back here.
            </P>
            <form method="post" action="/review/youtube/start" className="flex flex-wrap gap-3">
              <label className="sr-only" htmlFor="review-code">
                Access code
              </label>
              <input
                id="review-code"
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
                Connect with Google
              </button>
            </form>
          </Section>
        ) : (
          <>
            <Section title="Step 2 — The connected channel (youtube.readonly)">
              {readError ? (
                <P>YouTube could not be read: {readError}</P>
              ) : channels.length === 0 ? (
                <P>
                  This Google account has no YouTube channel. Create one on YouTube, then Disconnect
                  and connect again.
                </P>
              ) : (
                <ul className="space-y-2">
                  {channels.map((channel) => (
                    <li
                      key={channel.id}
                      className="rounded-md border border-line bg-surface px-4 py-3 text-sm"
                    >
                      <span className="font-medium text-ink">{channel.title}</span>
                      {channel.handle ? (
                        <span className="text-ink-muted"> · {channel.handle}</span>
                      ) : null}
                      <span className="block font-mono text-xs text-ink-muted">{channel.id}</span>
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="pt-2 text-sm font-semibold text-ink">Recent uploads</h3>
              {uploads.length === 0 ? (
                <P>No uploads yet.</P>
              ) : (
                <ul className="space-y-1 text-sm text-ink-secondary">
                  {uploads.map((video) => (
                    <li key={video.id}>
                      <span className="text-ink">{video.title || video.id}</span> ·{' '}
                      {video.privacyStatus ?? 'unknown'} · {video.viewCount ?? '0'} views
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Step 3 — Publish a video (youtube.upload)">
              <P>
                This is how Orbit publishes a scheduled video: a resumable upload to the channel.
                Use any short clip under {REVIEW_MAX_UPLOAD_BYTES / 1024 / 1024} MB. It is private
                unless you choose otherwise.
              </P>
              <form
                method="post"
                action="/review/youtube/upload"
                encType="multipart/form-data"
                className="space-y-3 rounded-md border border-line bg-surface p-4 text-sm"
              >
                <label className="block">
                  <span className="text-ink">Video file</span>
                  <input
                    name="video"
                    type="file"
                    accept="video/*"
                    required
                    className="mt-1 block text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-ink">Title</span>
                  <input
                    name="title"
                    required
                    maxLength={100}
                    defaultValue="AHN Orbit verification test"
                    className="mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2"
                  />
                </label>
                <label className="block">
                  <span className="text-ink">Visibility</span>
                  <select
                    name="privacy"
                    defaultValue="private"
                    className="mt-1 block rounded-md border border-line bg-surface px-3 py-2"
                  >
                    <option value="private">Private</option>
                    <option value="unlisted">Unlisted</option>
                    <option value="public">Public</option>
                  </select>
                </label>
                <fieldset>
                  <legend className="text-ink">Is this video made for children?</legend>
                  <label className="mr-4">
                    <input type="radio" name="madeForKids" value="no" required /> No
                  </label>
                  <label>
                    <input type="radio" name="madeForKids" value="yes" /> Yes
                  </label>
                </fieldset>
                <button
                  type="submit"
                  className="rounded-md bg-accent px-4 py-2 font-medium text-accent-ink"
                >
                  Upload to YouTube
                </button>
              </form>
            </Section>

            <Section title="Step 4 — Disconnect">
              <P>Revokes Orbit’s access with Google, as Disconnect does in the product.</P>
              <form method="post" action="/review/youtube/disconnect">
                <button
                  type="submit"
                  className="rounded-md border border-line px-4 py-2 text-sm font-medium text-ink"
                >
                  Disconnect and revoke access
                </button>
              </form>
            </Section>
          </>
        )}
      </div>
    </main>
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
