import { Loading, PageHeader, Skeleton } from '@orbit/ui';

export default function ComposerLoading() {
  return (
    <main id="main" className="px-4 py-10 sm:px-6">
      <PageHeader title="Loading post…" />
      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Loading label="Loading the composer" rows={4} />
        <Skeleton className="h-48 w-full" />
      </div>
    </main>
  );
}
