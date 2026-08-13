import { Loading, PageHeader, Skeleton } from '@orbit/ui';

export default function ComposerLoading() {
  return (
    <main id="main" className="mx-auto max-w-6xl px-6 py-10">
      <PageHeader title="Loading post…" />
      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Loading label="Loading the composer" rows={4} />
        <Skeleton className="h-48 w-full" />
      </div>
    </main>
  );
}
