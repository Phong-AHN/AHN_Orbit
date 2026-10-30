/**
 * The homepage's "TikTok app review" section (docs/TIKTOK-REVIEW.md).
 *
 * TikTok's reviewers start from the website URL, so the way into the test page
 * is here, with the steps spelled out. The access code is checked on the
 * server (`/review/tiktok/enter`); the test page itself refuses anyone who has
 * not entered it. Rendered only while `TIKTOK_REVIEW_ACCESS_CODE` is set.
 */

const MESSAGES: Record<string, string> = {
  code: 'That access code is not correct. Check the review notes and try again.',
  slow: 'Too many attempts. Wait ten minutes and try again.',
};

export function TikTokReviewEntry({ error }: { error: string | null }) {
  return (
    <section id="tiktok-review" className="scroll-mt-6 border-t border-line">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="rounded-lg border-2 border-accent bg-surface p-6 sm:p-8">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">
            For TikTok app reviewers
          </p>
          <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight">
            Test the TikTok integration
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-secondary">
            Try Social Square’s TikTok integration — Login Kit and the Content Posting API (Direct
            Post) — without creating a Social Square account. It requests the same scopes as the
            product: <code className="font-mono">user.info.basic</code>,{' '}
            <code className="font-mono">user.info.profile</code>,{' '}
            <code className="font-mono">video.publish</code> and{' '}
            <code className="font-mono">video.list</code>.
          </p>

          <ol className="mt-6 grid gap-4 text-sm md:grid-cols-3">
            <li className="rounded-md border border-line bg-canvas p-4">
              <span className="font-mono text-xs text-accent">Step 1</span>
              <p className="mt-1 text-ink">
                Enter the <strong>access code</strong> from our review notes below and click{' '}
                <strong>Open the TikTok test page</strong>.
              </p>
            </li>
            <li className="rounded-md border border-line bg-canvas p-4">
              <span className="font-mono text-xs text-accent">Step 2</span>
              <p className="mt-1 text-ink">
                On the test page, click <strong>Continue with TikTok</strong>, sign in with any
                TikTok account and choose <strong>Authorize</strong>.
              </p>
            </li>
            <li className="rounded-md border border-line bg-canvas p-4">
              <span className="font-mono text-xs text-accent">Step 3</span>
              <p className="mt-1 text-ink">
                Follow the page: see the connected account, post a short video (MP4 under 4 MB —
                choose <strong>Only me</strong> while the app is unaudited), see recent videos, then{' '}
                <strong>Disconnect</strong>.
              </p>
            </li>
          </ol>

          {error && MESSAGES[error] ? (
            <p
              role="alert"
              className="mt-6 rounded-md border border-line bg-danger-soft px-4 py-3 text-sm text-danger"
            >
              {MESSAGES[error]}
            </p>
          ) : null}

          <form
            method="post"
            action="/review/tiktok/enter"
            className="mt-6 flex flex-wrap items-end gap-3"
          >
            <label className="block text-sm">
              <span className="font-medium text-ink">Access code</span>
              <input
                name="code"
                type="password"
                required
                autoComplete="off"
                placeholder="Paste the code from the review notes"
                className="mt-1 block w-72 max-w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink"
              />
            </label>
            <button
              type="submit"
              className="h-10 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink hover:bg-accent-hover"
            >
              Open the TikTok test page
            </button>
          </form>

          <p className="mt-4 text-xs text-ink-muted">
            Nothing is stored: access lasts 30 minutes, only in your browser, and Disconnect revokes
            it with TikTok. The code is for TikTok’s review team only.
          </p>
        </div>
      </div>
    </section>
  );
}
