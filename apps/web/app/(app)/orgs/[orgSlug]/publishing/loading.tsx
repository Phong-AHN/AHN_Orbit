import { Loading, PageHeader } from '@orbit/ui';

export default function PublishingLoading() {
  return (
    <main id="main" className="px-4 py-10 sm:px-6">
      <PageHeader title="Publishing" description="Loading what went out…" />
      <Loading className="mt-8" label="Loading publishing logs" rows={5} />
    </main>
  );
}
