'use client';

import { ErrorState } from '@orbit/ui';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-16">
      <ErrorState
        title="The dashboard didn't load"
        description="Something went wrong on our side. Trying again often works."
        {...(error.digest ? { correlationId: error.digest } : {})}
        onRetry={reset}
      />
    </main>
  );
}
