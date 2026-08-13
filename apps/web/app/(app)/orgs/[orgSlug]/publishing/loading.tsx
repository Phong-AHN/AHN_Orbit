import { Loading, PageHeader } from '@orbit/ui';

export default function PublishingLoading() {
  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-10">
      <PageHeader title="Publishing" description="Loading what went out…" />
      <Loading className="mt-8" label="Loading publishing logs" rows={5} />
    </main>
  );
}
