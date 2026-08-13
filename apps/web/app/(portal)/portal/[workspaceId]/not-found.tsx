import { Empty, PageHeader } from '@orbit/ui';

/**
 * Everything a client may not see renders as this.
 *
 * Deliberately incurious: another agency's post, another client's workspace, and
 * a post that has not yet been sent for review all land here, saying the same
 * thing. A message that distinguished them would be a way to ask questions of
 * the database one URL at a time.
 */
export default function PortalNotFound() {
  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-16">
      <PageHeader title="Not found" />
      <Empty
        className="mt-8"
        title="We couldn't find that"
        description="It may have been moved, or it may not be shared with you. Try starting again from your content."
      />
    </main>
  );
}
