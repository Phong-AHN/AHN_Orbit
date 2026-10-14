import { Loading, PageHeader } from '@orbit/ui';

export default function PostsLoading() {
  return (
    <main id="main" className="mx-auto max-w-content px-4 sm:px-6 py-10">
      <PageHeader title="Posts" description="Loading your content…" />
      <Loading className="mt-8" label="Loading posts" rows={5} />
    </main>
  );
}
