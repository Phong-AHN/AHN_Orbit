import { Loading, PageHeader } from '@orbit/ui';

export default function PostsLoading() {
  return (
    <main id="main" className="px-4 py-10 sm:px-6">
      <PageHeader title="Posts" description="Loading your content…" />
      <Loading className="mt-8" label="Loading posts" rows={5} />
    </main>
  );
}
