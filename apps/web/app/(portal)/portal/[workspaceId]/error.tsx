'use client';

import { ErrorState } from '@orbit/ui';

/**
 * Route-level error boundary for the portal.
 *
 * Says less than the agency's equivalent on purpose. A client has no support
 * ticket to raise with us and no correlation id to quote — their route is their
 * agency — so this offers a retry and nothing that reads like an internal
 * diagnostic.
 */
export default function PortalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-16">
      <ErrorState
        title="Something went wrong"
        description="We couldn't load this just now. Trying again usually works — if it keeps happening, let your agency know."
        onRetry={reset}
      />
    </main>
  );
}
