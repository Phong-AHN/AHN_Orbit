'use client';

import { ErrorState } from '@orbit/ui';

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-16">
      <ErrorState
        title="That didn't load"
        description="An operational view failed. The digest below is the handle for the logs."
        {...(error.digest ? { correlationId: error.digest } : {})}
        onRetry={reset}
      />
    </main>
  );
}
