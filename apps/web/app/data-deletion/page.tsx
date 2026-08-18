import type { Metadata } from 'next';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Data deletion' };

/**
 * Where a data deletion request is explained.
 *
 * Meta requires the deletion callback to return a URL "a human-readable
 * explanation of the status of their request", and this is it. It renders for
 * somebody with no session and no account — the person reading it revoked an
 * app and may never have used Orbit directly — so it sits at the top level
 * beside the privacy policy rather than inside any route group.
 *
 * It says what was removed **and what was not**, because those are different
 * and the difference is the part people actually want to know.
 */
export default async function DataDeletionPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;

  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold text-ink">Data deletion</h1>

      {code ? (
        <p className="mt-4 text-sm text-ink-secondary">
          Your request has been processed. Reference:{' '}
          <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-xs">{code}</code>
        </p>
      ) : (
        <p className="mt-4 text-sm text-ink-secondary">
          This page explains what happens when a social account is removed from AHN Orbit.
        </p>
      )}

      <h2 className="mt-8 text-sm font-semibold text-ink">What is removed</h2>
      <ul className="mt-2 space-y-1.5 text-sm text-ink-secondary">
        <li>The stored access token for the connection, deleted immediately.</li>
        <li>The connection itself, so nothing can publish to the account again.</li>
      </ul>

      <h2 className="mt-6 text-sm font-semibold text-ink">What is not removed</h2>
      <p className="mt-2 text-sm text-ink-secondary">
        Posts an agency wrote, scheduled or published stay with that agency. They are the
        agency&rsquo;s records of its own work rather than data belonging to the social account, and
        removing a connection is not an instruction to destroy them. Anything already published on
        the platform is governed by that platform.
      </p>

      <h2 className="mt-6 text-sm font-semibold text-ink">Asking for more</h2>
      <p className="mt-2 text-sm text-ink-secondary">
        To have an agency&rsquo;s own records deleted, the agency has to ask — see the{' '}
        <Link href="/privacy-policy" className="underline">
          privacy policy
        </Link>{' '}
        for how.
      </p>
    </main>
  );
}
