import { Loading, PageHeader } from '@orbit/ui';

export default function AccountsLoading() {
  return (
    <main id="main" className="mx-auto max-w-content px-4 sm:px-6 py-10">
      <PageHeader title="Connected accounts" description="Checking your connections…" />
      <Loading className="mt-8" label="Loading connected accounts" rows={4} />
    </main>
  );
}
