'use client';

import { ErrorState } from '@orbit/ui';

/**
 * Route-level error boundary.
 *
 * Renders the safe message only. `error.message` from a server component is
 * already redacted in production by Next, and `digest` is the handle support
 * uses to find the real one in the logs — the same role `correlationId` plays
 * for an API failure.
 */
export default function PostsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-16">
      <ErrorState
        title="This page didn't load"
        description="Something went wrong on our side. Trying again often works."
        {...(error.digest ? { correlationId: error.digest } : {})}
        onRetry={reset}
      />
    </main>
  );
}
