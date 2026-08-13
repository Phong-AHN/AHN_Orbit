import { Empty } from '@orbit/ui';

/**
 * Shown both for a post that does not exist and for one in another
 * organization — deliberately the same answer, so navigation cannot be used to
 * confirm that an id is real somewhere else.
 */
export default function PostNotFound() {
  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-16">
      <Empty
        title="That post isn't here"
        description="It may have been deleted, or the link may be wrong."
      />
    </main>
  );
}
