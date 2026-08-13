'use client';

import { ErrorState } from '@orbit/ui';

/**
 * Route-level error boundary.
 *
 * Renders the safe message only. `digest` is the handle support uses to find the
 * real one in the logs — the same role `correlationId` plays for an API failure.
 */
export default function AccountsError({
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
        description="We couldn't check your connected accounts. Trying again often works."
        {...(error.digest ? { correlationId: error.digest } : {})}
        onRetry={reset}
      />
    </main>
  );
}
